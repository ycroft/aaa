//! opencode row-level incremental sync: probe remote sqlite3, run incremental
//! SELECTs, apply results to the local cache db.
//!
//! Failure handling is the caller's job (`open_for_provider`), which falls
//! back to full SFTP via `mirror::sync_files` on any error from this module.
//! See `docs/opencode-incremental-sync-design.md`.

use std::path::Path;

use log::{debug, info, warn};
use rusqlite::{params, Connection};
use serde_json::Value;

use super::{RemoteError, RemoteFs, SyncContext, SyncPhase, SyncProgress, SyncStats};

/// Cap on stdout we'll accept from the remote sqlite3 process.
/// 256 MB is far above any realistic incremental payload; anything beyond is
/// treated as misuse and the caller falls back to full SFTP.
const MAX_STDOUT: u64 = 256 * 1024 * 1024;

const SECTION_SESSION: &str = "---SECTION:session---";
const SECTION_MESSAGE: &str = "---SECTION:message---";
const SECTION_PART: &str = "---SECTION:part---";

/// Sync watermark per (table_name) inside a single physical cache db.
/// Persisted as `aaa_sync_state` so restart-safety is just "open the db".
#[derive(Debug, Default, Clone)]
pub(crate) struct Watermarks {
    pub session: i64,
    pub message: i64,
    pub part: i64,
}

/// Ensure the opencode tables exist on a freshly created cache db.
/// Schemas mirror what `OpencodeProvider::scan_summaries` / `collect_parts`
/// expects to query.
pub fn ensure_opencode_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session (
            id TEXT PRIMARY KEY,
            parent_id TEXT,
            directory TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            time_created INTEGER NOT NULL DEFAULT 0,
            time_updated INTEGER NOT NULL DEFAULT 0,
            version TEXT,
            share_url TEXT
         );
         CREATE TABLE IF NOT EXISTS message (
            id TEXT PRIMARY KEY,
            role TEXT NOT NULL DEFAULT '',
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id);
         CREATE TABLE IF NOT EXISTS part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT '',
            tool TEXT,
            time_created INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS idx_part_message ON part(message_id);",
    )
}

/// Open the cache db (creating empty if absent), ensure `aaa_sync_state` exists,
/// and return current watermarks. We use rusqlite directly here so the same
/// process holds a write lock for the apply phase later — no extra connection
/// juggling.
pub fn open_cache_db(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS aaa_sync_state (
            table_name TEXT PRIMARY KEY,
            watermark  INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );",
    )?;
    ensure_opencode_schema(&conn)?;
    Ok(conn)
}

pub(crate) fn read_watermarks(conn: &Connection) -> rusqlite::Result<Watermarks> {
    let mut stmt = conn.prepare("SELECT table_name, watermark FROM aaa_sync_state")?;
    let mut rows = stmt.query([])?;
    let mut wm = Watermarks::default();
    while let Some(r) = rows.next()? {
        let name: String = r.get(0)?;
        let val: i64 = r.get(1)?;
        match name.as_str() {
            "session" => wm.session = val,
            "message" => wm.message = val,
            "part" => wm.part = val,
            _ => {} // ignore unknown — future-proof
        }
    }
    Ok(wm)
}

#[cfg(test)]
pub(crate) fn write_watermarks(conn: &Connection, wm: &Watermarks) -> rusqlite::Result<()> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut stmt = conn.prepare(
        "INSERT OR REPLACE INTO aaa_sync_state (table_name, watermark, updated_at) VALUES (?1, ?2, ?3)",
    )?;
    stmt.execute(params!["session", wm.session, now_ms])?;
    stmt.execute(params!["message", wm.message, now_ms])?;
    stmt.execute(params!["part", wm.part, now_ms])?;
    Ok(())
}

/// Probe whether the remote has a working `sqlite3` binary new enough to take
/// the `-json` flag (3.33+).  Returns `true` only when the command runs, exits
/// 0, and the output contains a SemVer-ish version string.
pub async fn probe_sqlite3(fs: &mut dyn RemoteFs) -> bool {
    let res = fs
        .exec(
            &["sh", "-c", "command -v sqlite3 >/dev/null && sqlite3 -version"],
            b"",
            4096,
        )
        .await;
    match res {
        Ok(out) => {
            let s = String::from_utf8_lossy(&out);
            let ok = s.split_whitespace().next().map_or(false, |tok| {
                tok.split('.').next().and_then(|n| n.parse::<u32>().ok()).is_some()
            });
            if ok {
                info!("remote sqlite3 detected: {}", s.trim());
            } else {
                warn!("remote sqlite3 probe stdout did not look like a version: {:?}", s);
            }
            ok
        }
        Err(e) => {
            info!("remote sqlite3 probe failed (will fall back to full SFTP): {}", e);
            false
        }
    }
}

/// Build the SQL script piped into `sqlite3 -readonly -json <db>` via stdin.
/// Watermarks are baked into the SQL (i64 → safe to format).
pub(crate) fn build_query_script(wm: &Watermarks) -> String {
    format!(
        "SELECT '{sec_session}';\n\
         SELECT id, parent_id, directory, title, time_created, time_updated, version, share_url \
         FROM session WHERE time_updated > {wm_session} ORDER BY time_updated;\n\
         SELECT '{sec_message}';\n\
         SELECT id, role, session_id, time_created, data \
         FROM message WHERE time_created > {wm_message} ORDER BY time_created;\n\
         SELECT '{sec_part}';\n\
         SELECT id, message_id, type, tool, time_created, data \
         FROM part WHERE time_created > {wm_part} ORDER BY time_created;\n",
        sec_session = SECTION_SESSION,
        sec_message = SECTION_MESSAGE,
        sec_part = SECTION_PART,
        wm_session = wm.session,
        wm_message = wm.message,
        wm_part = wm.part,
    )
}

/// Split stdout into the three section payloads. `sqlite3 -json` prints one
/// JSON array per query (so 3 SELECTs produce 3 arrays + 3 marker arrays).
/// Markers come out as `[{"'{section}'": "---SECTION:..."}]` style — we split
/// on the literal marker text to keep it simple and resilient to formatting.
///
/// Each block is the substring between two markers, trimmed of surrounding
/// whitespace and the marker line itself.  We back up to the previous newline
/// before a marker so the preceding JSON array stays intact.
pub(crate) fn split_sections(stdout: &[u8]) -> Result<(String, String, String), RemoteError> {
    let s = std::str::from_utf8(stdout)
        .map_err(|e| RemoteError::Exec { code: -2, stderr: format!("non-utf8 stdout: {}", e) })?;
    let i_session = s.find(SECTION_SESSION).ok_or_else(|| RemoteError::Exec {
        code: -2,
        stderr: "missing SECTION:session marker".into(),
    })?;
    let i_msg = s.find(SECTION_MESSAGE).ok_or_else(|| RemoteError::Exec {
        code: -2,
        stderr: "missing SECTION:message marker".into(),
    })?;
    let i_part = s.find(SECTION_PART).ok_or_else(|| RemoteError::Exec {
        code: -2,
        stderr: "missing SECTION:part marker".into(),
    })?;
    if i_msg < i_session || i_part < i_msg {
        return Err(RemoteError::Exec {
            code: -2,
            stderr: "section markers out of order".into(),
        });
    }

    // Step over the marker line (including its trailing newline) to where the
    // body of that section begins.
    fn body_start(s: &str, marker_pos: usize) -> usize {
        match s[marker_pos..].find('\n') {
            Some(rel) => marker_pos + rel + 1,
            None => s.len(),
        }
    }
    // Walk back from a marker position to the most recent '\n' so the
    // preceding JSON array we are slicing doesn't get truncated mid-line.
    fn body_end(s: &str, next_marker: usize) -> usize {
        s[..next_marker].rfind('\n').map(|n| n + 1).unwrap_or(next_marker)
    }

    let session_body_start = body_start(s, i_session);
    let session_body_end = body_end(s, i_msg);
    let session_block = s[session_body_start..session_body_end.max(session_body_start)].to_string();

    let message_body_start = body_start(s, i_msg);
    let message_body_end = body_end(s, i_part);
    let message_block = s[message_body_start..message_body_end.max(message_body_start)].to_string();

    let part_body_start = body_start(s, i_part);
    let part_block = s[part_body_start..].to_string();

    Ok((session_block, message_block, part_block))
}

/// Apply the three JSON-array payloads to the cache db inside a single
/// transaction.  Returns updated watermarks (max time_* observed in each
/// section). Empty input → returned watermarks equal the input ones.
pub(crate) fn apply_payloads(
    conn: &mut Connection,
    initial: &Watermarks,
    session_json: &str,
    message_json: &str,
    part_json: &str,
) -> Result<Watermarks, RemoteError> {
    fn parse_array(name: &str, src: &str) -> Result<Vec<Value>, RemoteError> {
        let trimmed = src.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let v: Value = serde_json::from_str(trimmed).map_err(|e| RemoteError::Exec {
            code: -3,
            stderr: format!("parse {name}: {e}"),
        })?;
        match v {
            Value::Array(a) => Ok(a),
            _ => Err(RemoteError::Exec {
                code: -3,
                stderr: format!("{name} not a JSON array"),
            }),
        }
    }

    let sessions = parse_array("session", session_json)?;
    let messages = parse_array("message", message_json)?;
    let parts = parse_array("part", part_json)?;

    let mut wm = initial.clone();
    let tx = conn.transaction().map_err(io_to_remote)?;

    {
        let mut stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO session \
                 (id, parent_id, directory, title, time_created, time_updated, version, share_url) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            )
            .map_err(io_to_remote)?;
        for v in &sessions {
            let id = v.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let pid = v.get("parent_id").and_then(Value::as_str).map(str::to_string);
            let dir = v.get("directory").and_then(Value::as_str).unwrap_or("").to_string();
            let title = v.get("title").and_then(Value::as_str).unwrap_or("").to_string();
            let tc = v.get("time_created").and_then(Value::as_i64).unwrap_or(0);
            let tu = v.get("time_updated").and_then(Value::as_i64).unwrap_or(0);
            let version = v.get("version").and_then(Value::as_str).map(str::to_string);
            let share = v.get("share_url").and_then(Value::as_str).map(str::to_string);
            stmt.execute(params![id, pid, dir, title, tc, tu, version, share])
                .map_err(io_to_remote)?;
            if tu > wm.session {
                wm.session = tu;
            }
        }
    }

    {
        let mut stmt = tx
            .prepare(
                "INSERT OR IGNORE INTO message \
                 (id, role, session_id, time_created, data) \
                 VALUES (?1,?2,?3,?4,?5)",
            )
            .map_err(io_to_remote)?;
        for v in &messages {
            let id = v.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let role = v.get("role").and_then(Value::as_str).unwrap_or("").to_string();
            let sid = v.get("session_id").and_then(Value::as_str).unwrap_or("").to_string();
            let tc = v.get("time_created").and_then(Value::as_i64).unwrap_or(0);
            let data = v.get("data").and_then(Value::as_str).unwrap_or("").to_string();
            stmt.execute(params![id, role, sid, tc, data])
                .map_err(io_to_remote)?;
            if tc > wm.message {
                wm.message = tc;
            }
        }
    }

    {
        let mut stmt = tx
            .prepare(
                "INSERT OR IGNORE INTO part \
                 (id, message_id, type, tool, time_created, data) \
                 VALUES (?1,?2,?3,?4,?5,?6)",
            )
            .map_err(io_to_remote)?;
        for v in &parts {
            let id = v.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let mid = v.get("message_id").and_then(Value::as_str).unwrap_or("").to_string();
            let kind = v.get("type").and_then(Value::as_str).unwrap_or("").to_string();
            let tool = v.get("tool").and_then(Value::as_str).map(str::to_string);
            let tc = v.get("time_created").and_then(Value::as_i64).unwrap_or(0);
            let data = v.get("data").and_then(Value::as_str).unwrap_or("").to_string();
            stmt.execute(params![id, mid, kind, tool, tc, data])
                .map_err(io_to_remote)?;
            if tc > wm.part {
                wm.part = tc;
            }
        }
    }

    {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let mut stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO aaa_sync_state (table_name, watermark, updated_at) VALUES (?1,?2,?3)",
            )
            .map_err(io_to_remote)?;
        stmt.execute(params!["session", wm.session, now_ms])
            .map_err(io_to_remote)?;
        stmt.execute(params!["message", wm.message, now_ms])
            .map_err(io_to_remote)?;
        stmt.execute(params!["part", wm.part, now_ms])
            .map_err(io_to_remote)?;
    }

    tx.commit().map_err(io_to_remote)?;
    debug!(
        "incremental apply ok: sessions={} messages={} parts={}",
        sessions.len(),
        messages.len(),
        parts.len()
    );
    Ok(wm)
}

fn io_to_remote(e: rusqlite::Error) -> RemoteError {
    RemoteError::Sftp(format!("cache db: {}", e))
}

/// Run the full L2 incremental flow against `<remote_root>/<db_relpath>` →
/// `<local_root>/<db_relpath>`. opencode and ngagent share the same three-table
/// schema (session/message/part), so the same routine handles both — caller
/// just passes a different `db_relpath` (e.g. `"opencode.db"` or
/// `"db/ngagent.db"`).
///
/// Errors propagate; the caller (`open_for_provider`) decides whether to fall
/// back to L3 byte-level SFTP for this specific db.
pub async fn sync_opencode_incremental(
    fs: &mut dyn RemoteFs,
    remote_root: &str,
    local_root: &Path,
    db_relpath: &str,
    ctx: &mut SyncContext,
) -> Result<SyncStats, RemoteError> {
    let started = std::time::Instant::now();
    let cache_db = local_root.join(db_relpath);
    if !cache_db.exists() {
        return Err(RemoteError::Sftp(format!(
            "incremental requires existing cache db at {:?}; first sync should have used SFTP",
            cache_db
        )));
    }

    ctx.check_cancel()?;
    ctx.report(&SyncProgress {
        phase: SyncPhase::IncrementalQuery,
        current_file: Some(format!("{} session/message/part", db_relpath)),
        files_done: 0,
        files_total: 3,
        bytes_done: 0,
        bytes_total: 0,
    });

    if let Some(parent) = cache_db.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| RemoteError::Sftp(format!("mkdir cache parent: {}", e)))?;
    }
    let mut conn = open_cache_db(&cache_db)
        .map_err(|e| RemoteError::Sftp(format!("open cache db {:?}: {}", cache_db, e)))?;
    let wm = read_watermarks(&conn)
        .map_err(|e| RemoteError::Sftp(format!("read watermarks: {}", e)))?;

    let remote_db = format!("{}/{}", remote_root.trim_end_matches('/'), db_relpath);
    let stdin = build_query_script(&wm);
    let argv = ["sqlite3", "-readonly", "-json", remote_db.as_str()];

    ctx.check_cancel()?;
    let stdout = fs.exec(&argv, stdin.as_bytes(), MAX_STDOUT).await?;

    let bytes_done = stdout.len() as u64;
    ctx.check_cancel()?;
    ctx.report(&SyncProgress {
        phase: SyncPhase::IncrementalApply,
        current_file: Some(format!("{} session/message/part", db_relpath)),
        files_done: 0,
        files_total: 3,
        bytes_done,
        bytes_total: bytes_done,
    });

    let (s_block, m_block, p_block) = split_sections(&stdout)?;
    let new_wm = apply_payloads(&mut conn, &wm, &s_block, &m_block, &p_block)?;

    let stats = SyncStats {
        files_pulled: 0,
        files_skipped: 0,
        files_deleted_locally: 0,
        bytes_pulled: bytes_done,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    info!(
        "{} incremental ok: bytes={} wm session={}→{} message={}→{} part={}→{}",
        db_relpath,
        bytes_done,
        wm.session,
        new_wm.session,
        wm.message,
        new_wm.message,
        wm.part,
        new_wm.part,
    );
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::{DirEntry, FileMeta};
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use tempfile::TempDir;

    /// FakeFs that can mock `exec()` results keyed by joined argv.
    pub(crate) struct FakeExecFs {
        pub exec_responses: HashMap<String, Result<Vec<u8>, RemoteError>>,
        pub exec_log: Mutex<Vec<(Vec<String>, Vec<u8>)>>,
    }

    impl FakeExecFs {
        pub fn new() -> Self {
            Self {
                exec_responses: HashMap::new(),
                exec_log: Mutex::new(Vec::new()),
            }
        }
        pub fn with_response(
            mut self,
            argv_joined: &str,
            body: Result<Vec<u8>, RemoteError>,
        ) -> Self {
            self.exec_responses.insert(argv_joined.into(), body);
            self
        }
    }

    #[async_trait]
    impl RemoteFs for FakeExecFs {
        async fn home_dir(&mut self) -> Result<String, RemoteError> {
            Ok("/home/u".into())
        }
        async fn metadata(&mut self, _: &str) -> Result<FileMeta, RemoteError> {
            unreachable!()
        }
        async fn read_dir(&mut self, _: &str) -> Result<Vec<DirEntry>, RemoteError> {
            unreachable!()
        }
        async fn download(&mut self, _: &str, _: &Path) -> Result<u64, RemoteError> {
            unreachable!()
        }
        async fn exec(
            &mut self,
            argv: &[&str],
            stdin: &[u8],
            _max_stdout: u64,
        ) -> Result<Vec<u8>, RemoteError> {
            let owned: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
            self.exec_log
                .lock()
                .unwrap()
                .push((owned.clone(), stdin.to_vec()));
            let key = owned.join(" ");
            self.exec_responses.get(&key).cloned().unwrap_or_else(|| {
                Err(RemoteError::Exec {
                    code: 127,
                    stderr: format!("FakeExecFs has no response for {}", key),
                })
            })
        }
    }

    impl Clone for RemoteError {
        fn clone(&self) -> Self {
            // Simple clone for tests; real RemoteError is non-Clone because of
            // upstream trait constraints, but we only need this in tests.
            match self {
                RemoteError::Exec { code, stderr } => RemoteError::Exec {
                    code: *code,
                    stderr: stderr.clone(),
                },
                RemoteError::Sftp(s) => RemoteError::Sftp(s.clone()),
                _ => RemoteError::Sftp("uncloneable".into()),
            }
        }
    }

    #[tokio::test]
    async fn probe_returns_true_on_recent_sqlite() {
        let mut fs = FakeExecFs::new().with_response(
            "sh -c command -v sqlite3 >/dev/null && sqlite3 -version",
            Ok(b"3.40.0 2022-11-16 ...\n".to_vec()),
        );
        assert!(probe_sqlite3(&mut fs).await);
    }

    #[tokio::test]
    async fn probe_returns_false_when_binary_missing() {
        let mut fs = FakeExecFs::new().with_response(
            "sh -c command -v sqlite3 >/dev/null && sqlite3 -version",
            Err(RemoteError::Exec {
                code: 127,
                stderr: "not found".into(),
            }),
        );
        assert!(!probe_sqlite3(&mut fs).await);
    }

    #[test]
    fn watermarks_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("c.db");
        let conn = open_cache_db(&p).unwrap();
        let initial = read_watermarks(&conn).unwrap();
        assert_eq!(initial.session, 0);
        assert_eq!(initial.message, 0);
        assert_eq!(initial.part, 0);
        write_watermarks(
            &conn,
            &Watermarks {
                session: 100,
                message: 200,
                part: 300,
            },
        )
        .unwrap();
        let after = read_watermarks(&conn).unwrap();
        assert_eq!(after.session, 100);
        assert_eq!(after.message, 200);
        assert_eq!(after.part, 300);
    }

    #[test]
    fn split_sections_extracts_three_blocks() {
        let stdout = b"\
[{\"col\":\"---SECTION:session---\"}]\n\
[{\"id\":\"a\"},{\"id\":\"b\"}]\n\
[{\"col\":\"---SECTION:message---\"}]\n\
[{\"id\":\"m1\"}]\n\
[{\"col\":\"---SECTION:part---\"}]\n\
[]\n";
        let (s, m, p) = split_sections(stdout).unwrap();
        assert!(s.contains("\"a\""));
        assert!(s.contains("\"b\""));
        assert!(m.contains("m1"));
        assert!(p.trim() == "[]");
    }

    #[test]
    fn split_sections_rejects_missing_markers() {
        let bad = b"hello world";
        assert!(split_sections(bad).is_err());
    }

    #[test]
    fn apply_inserts_new_rows_and_advances_watermarks() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("c.db");
        let mut conn = open_cache_db(&p).unwrap();
        let wm0 = Watermarks::default();
        let session_json = r#"[{"id":"s1","parent_id":null,"directory":"/x","title":"t","time_created":100,"time_updated":200,"version":null,"share_url":null}]"#;
        let message_json = r#"[{"id":"m1","role":"user","session_id":"s1","time_created":150,"data":"{}"}]"#;
        let part_json = r#"[{"id":"p1","message_id":"m1","type":"text","tool":null,"time_created":160,"data":"{}"}]"#;
        let wm1 =
            apply_payloads(&mut conn, &wm0, session_json, message_json, part_json).unwrap();
        assert_eq!(wm1.session, 200);
        assert_eq!(wm1.message, 150);
        assert_eq!(wm1.part, 160);

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM session", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn apply_is_idempotent_on_messages_and_parts() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("c.db");
        let mut conn = open_cache_db(&p).unwrap();
        let wm0 = Watermarks::default();
        let s = r#"[{"id":"s1","parent_id":null,"directory":"","title":"","time_created":0,"time_updated":1,"version":null,"share_url":null}]"#;
        let m = r#"[{"id":"m1","role":"user","session_id":"s1","time_created":1,"data":""}]"#;
        let p_json = r#"[{"id":"p1","message_id":"m1","type":"text","tool":null,"time_created":1,"data":""}]"#;
        apply_payloads(&mut conn, &wm0, s, m, p_json).unwrap();
        // Re-apply same payload — message + part use INSERT OR IGNORE, no error.
        apply_payloads(&mut conn, &wm0, s, m, p_json).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM message", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn apply_replaces_session_when_title_bumps() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("c.db");
        let mut conn = open_cache_db(&p).unwrap();
        let s_v1 = r#"[{"id":"s1","parent_id":null,"directory":"","title":"old","time_created":0,"time_updated":1,"version":null,"share_url":null}]"#;
        let s_v2 = r#"[{"id":"s1","parent_id":null,"directory":"","title":"new","time_created":0,"time_updated":2,"version":null,"share_url":null}]"#;
        apply_payloads(&mut conn, &Watermarks::default(), s_v1, "[]", "[]").unwrap();
        apply_payloads(&mut conn, &Watermarks::default(), s_v2, "[]", "[]").unwrap();
        let title: String = conn
            .query_row("SELECT title FROM session WHERE id='s1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "new");
    }

    fn make_seeded_cache(path: &Path) -> Connection {
        let conn = open_cache_db(path).unwrap();
        // Seed an existing session/message/part row pretending we did a prior
        // full SFTP sync — watermarks stay 0 because we did not run incremental yet.
        conn.execute(
            "INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, version, share_url)
             VALUES ('s_old', NULL, '/old', 'old', 1, 1, NULL, NULL)",
            [],
        )
        .unwrap();
        conn
    }

    #[tokio::test]
    async fn end_to_end_incremental_appends_new_rows() {
        let tmp = TempDir::new().unwrap();
        let cache = tmp.path().join("opencode.db");
        drop(make_seeded_cache(&cache));

        let stdout = b"\
[{\"col\":\"---SECTION:session---\"}]\n\
[{\"id\":\"s_new\",\"parent_id\":null,\"directory\":\"/n\",\"title\":\"hi\",\"time_created\":10,\"time_updated\":20,\"version\":null,\"share_url\":null}]\n\
[{\"col\":\"---SECTION:message---\"}]\n\
[{\"id\":\"m1\",\"role\":\"user\",\"session_id\":\"s_new\",\"time_created\":15,\"data\":\"\"}]\n\
[{\"col\":\"---SECTION:part---\"}]\n\
[{\"id\":\"p1\",\"message_id\":\"m1\",\"type\":\"text\",\"tool\":null,\"time_created\":16,\"data\":\"\"}]\n";

        let mut fs = FakeExecFs::new().with_response(
            "sqlite3 -readonly -json /remote/opencode.db",
            Ok(stdout.to_vec()),
        );
        let mut ctx = SyncContext::noop();
        let stats = sync_opencode_incremental(&mut fs, "/remote", tmp.path(), "opencode.db", &mut ctx)
            .await
            .unwrap();
        assert_eq!(stats.bytes_pulled, stdout.len() as u64);

        let conn = Connection::open(&cache).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM session", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2); // seeded + new
        let wm: i64 = conn
            .query_row(
                "SELECT watermark FROM aaa_sync_state WHERE table_name='session'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(wm, 20);
    }

    #[tokio::test]
    async fn end_to_end_incremental_errors_when_cache_missing() {
        let tmp = TempDir::new().unwrap();
        let mut fs = FakeExecFs::new();
        let mut ctx = SyncContext::noop();
        let err = sync_opencode_incremental(&mut fs, "/remote", tmp.path(), "opencode.db", &mut ctx)
            .await
            .unwrap_err();
        match err {
            RemoteError::Sftp(s) => assert!(s.contains("requires existing cache")),
            other => panic!("unexpected: {:?}", other),
        }
    }
}
