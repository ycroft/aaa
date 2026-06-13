//! opencode provider — reads `~/.local/share/opencode/opencode.db` (SQLite).
//!
//! opencode persists every session, message, and part as a row in three
//! tables: `session`, `message`, `part`. The `data` column on each row is a
//! JSON blob; we translate the relevant shapes into the unified
//! [`SessionNode`] model.
//!
//! Single-DB layout means we represent a session's `source_path` as
//! `<db>#<session_id>` so [`load_session`] can re-open just that row.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use log::{debug, info, warn};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::model::{
    MessagePart, NodeKind, SessionDetail, SessionNode, SessionSummary, SubAgentKind,
    SubAgentSession, TokenUsage,
};
use crate::providers::SessionProvider;

const PROVIDER_ID: &str = "opencode";
const DB_FILE: &str = "opencode.db";
const NGAGENT_DB_SUBDIR: &str = "db";
const NGAGENT_DB_NAME: &str = "ngagent.db";

pub struct OpencodeProvider;

impl SessionProvider for OpencodeProvider {
    fn id(&self) -> &str {
        PROVIDER_ID
    }
    fn display_name(&self) -> &str {
        "opencode"
    }
    fn default_root(&self) -> Option<PathBuf> {
        // Windows: opencode stores under %USERPROFILE%\.config\opencode (not
        // %LOCALAPPDATA%\opencode that dirs::data_local_dir() would suggest).
        // Linux: ~/.local/share/opencode (XDG data).
        // macOS: ~/Library/Application Support/opencode.
        #[cfg(target_os = "windows")]
        {
            return dirs::home_dir().map(|d| d.join(".config").join("opencode"));
        }
        #[cfg(not(target_os = "windows"))]
        {
            dirs::data_local_dir().map(|d| d.join("opencode"))
        }
    }
    fn remote_root_candidates(&self) -> Vec<&'static str> {
        vec![
            "{home}/.local/share/opencode",
            "{home}/Library/Application Support/opencode",
        ]
    }

    /// Only the SQLite trio is needed; the rest of opencode's data dir is
    /// caches/binaries/etc. that can balloon the sync size for nothing.
    /// `-wal` / `-shm` are absent on a clean shutdown — `sync_files` skips
    /// missing names instead of erroring.
    fn remote_sync_files(&self) -> Option<Vec<&'static str>> {
        Some(vec![
            "opencode.db",
            "opencode.db-wal",
            "opencode.db-shm",
            "db/ngagent.db",
            "db/ngagent.db-wal",
            "db/ngagent.db-shm",
        ])
    }

    fn list_sessions(&self, root: &PathBuf) -> Result<Vec<SessionSummary>> {
        let dbs = find_dbs(root);
        info!(
            "opencode list_sessions root={:?} discovered_dbs={:?}",
            root, dbs
        );
        if dbs.is_empty() {
            warn!(
                "opencode list_sessions: no SQLite db found under {:?} \
                 (looked for {} and {}/{})",
                root, DB_FILE, NGAGENT_DB_SUBDIR, NGAGENT_DB_NAME
            );
        }
        let mut out = Vec::new();
        for db_path in &dbs {
            match open_ro(db_path) {
                Err(e) => { warn!("open_ro failed {:?}: {}", db_path, e); continue; }
                Ok(conn) => {
                    // Diagnostic: dump session-table schema + total row count
                    // before running the actual list query. This is the cheapest
                    // way to spot ngagent.db drift (missing parent_id column,
                    // type mismatches, …) without having to add ad-hoc patches
                    // every time a fork strays from opencode's schema.
                    log_session_schema(&conn, db_path);
                    match scan_summaries(&conn, db_path) {
                        Err(e) => {
                            warn!(
                                "opencode scan_summaries FAILED for {:?}: {} \
                                 (db will contribute 0 sessions to the list)",
                                db_path, e
                            );
                        }
                        Ok(mut sessions) => {
                            info!(
                                "opencode scan_summaries {:?} => {} sessions returned",
                                db_path,
                                sessions.len()
                            );
                            out.append(&mut sessions);
                        }
                    }
                }
            }
        }
        // Sort by ended_at descending (most recent first) after merging.
        out.sort_by(|a, b| b.ended_at.cmp(&a.ended_at));
        info!("opencode list_sessions => total {} sessions", out.len());
        Ok(out)
    }

    fn load_session(&self, source_path: &PathBuf) -> Result<SessionDetail> {
        debug!("load_session source_path={:?}", source_path);
        let (db_path, session_id) = parse_source_path(source_path)?;
        let conn = open_ro(&db_path)?;
        let res = load_session_detail(&conn, &db_path, &session_id);
        if let Err(ref e) = res { warn!("load_session_detail FAILED: {}", e); }
        res
    }
}

/// Find all SQLite databases under the opencode data dir.
/// Returns the classic `opencode.db` and/or `db/ngagent.db` if they exist.
/// If `root` itself is a file, treat it as a single explicit db path.
fn find_dbs(root: &Path) -> Vec<PathBuf> {
    if root.is_file() {
        info!("opencode find_dbs: root {:?} is a file — using directly", root);
        return vec![root.to_path_buf()];
    }
    let mut dbs = Vec::new();
    let main_db = root.join(DB_FILE);
    info!(
        "opencode find_dbs: root={:?} main_db={:?} exists={}",
        root,
        main_db,
        main_db.exists()
    );
    if main_db.exists() {
        dbs.push(main_db);
    }
    let ngagent_db = root.join(NGAGENT_DB_SUBDIR).join(NGAGENT_DB_NAME);
    info!(
        "opencode find_dbs: ngagent_db={:?} exists={}",
        ngagent_db,
        ngagent_db.exists()
    );
    if ngagent_db.exists() {
        dbs.push(ngagent_db);
    }
    dbs
}

/// Diagnostic: print the `session` table schema + row count for a db.
///
/// Writes everything via `info!` so a regular run shows enough to tell
/// "ngagent.db's session table doesn't have parent_id" apart from
/// "list_sessions returned an empty vec because the db is empty" without
/// having to bump log level. Failures are logged at `warn!` and swallowed
/// so the surrounding scan still runs.
fn log_session_schema(conn: &Connection, db: &Path) {
    let cols: Vec<(String, String, i32)> = match conn.prepare("PRAGMA table_info(session)") {
        Ok(mut stmt) => match stmt.query_map([], |r| {
            // table_info columns: cid, name, type, notnull, dflt_value, pk
            Ok((
                r.get::<_, String>(1).unwrap_or_default(),
                r.get::<_, String>(2).unwrap_or_default(),
                r.get::<_, i32>(3).unwrap_or(0),
            ))
        }) {
            Ok(rows) => rows.flatten().collect(),
            Err(e) => {
                warn!(
                    "opencode schema probe: query_map failed for {:?}: {}",
                    db, e
                );
                return;
            }
        },
        Err(e) => {
            warn!(
                "opencode schema probe: PRAGMA table_info failed for {:?}: {}",
                db, e
            );
            return;
        }
    };
    if cols.is_empty() {
        warn!(
            "opencode schema probe: db {:?} has no `session` table — \
             list_sessions will be empty for this file",
            db
        );
        return;
    }
    let summary: Vec<String> = cols
        .iter()
        .map(|(n, t, nn)| format!("{}:{}{}", n, t, if *nn != 0 { " NOT NULL" } else { "" }))
        .collect();
    info!(
        "opencode schema probe {:?}: session columns = [{}]",
        db,
        summary.join(", ")
    );
    let has_parent_id = cols.iter().any(|(n, _, _)| n == "parent_id");
    if !has_parent_id {
        warn!(
            "opencode schema probe {:?}: session table is MISSING `parent_id` — \
             scan_summaries query (`WHERE parent_id IS NULL`) will fail with \
             `no such column: parent_id`. This is the most likely root cause \
             when a forked db (e.g. ngagent.db) shows zero sessions.",
            db
        );
    }
    // Row counts — total vs the parent_id IS NULL slice. Lets us tell apart
    // "scan returns 0 because the filter excluded everything" from "scan
    // failed before reaching here".
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM session", [], |r| r.get(0))
        .unwrap_or(-1);
    let top_level: i64 = if has_parent_id {
        conn.query_row(
            "SELECT COUNT(*) FROM session WHERE parent_id IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(-1)
    } else {
        -2 // sentinel: column doesn't exist, query would error
    };
    info!(
        "opencode schema probe {:?}: session rows total={} top_level(parent_id IS NULL)={}",
        db, total, top_level
    );
}

fn open_ro(path: &Path) -> Result<Connection> {
    let res = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI,
    );
    match &res {
        Ok(_) => debug!("open_ro ok {:?}", path),
        Err(e) => warn!("open_ro FAILED {:?}: {}", path, e),
    }
    res.with_context(|| format!("open opencode db {:?}", path))
}

/// Encode a session's identity as `<db>#<session_id>`. Tauri's
/// `load_session(source_path)` is just a string, so we have to fit the DB +
/// row id into one slot.
fn make_source_path(db: &Path, session_id: &str) -> String {
    format!("{}#{}", db.to_string_lossy(), session_id)
}

fn parse_source_path(source: &Path) -> Result<(PathBuf, String)> {
    let s = source.to_string_lossy();
    let (db, sid) = s
        .rsplit_once('#')
        .ok_or_else(|| anyhow!("opencode source_path must be '<db>#<session_id>': {}", s))?;
    if sid.is_empty() {
        return Err(anyhow!("opencode source_path missing session id: {}", s));
    }
    Ok((PathBuf::from(db), sid.to_string()))
}

fn scan_summaries(conn: &Connection, db: &Path) -> Result<Vec<SessionSummary>> {
    // Filter out child sessions (parent_id IS NOT NULL) — those are sub-agents
    // spawned via the `task` tool and shouldn't appear at the top level.
    // They'll be loaded as SubAgentSession when their parent is opened.
    //
    // NOTE on schema drift: this query assumes the `session` table has columns
    // `id, directory, title, time_created, time_updated, parent_id`. Forks
    // like ngagent.db have at times shipped without `parent_id`, in which
    // case `prepare` fails with `no such column: parent_id` and the whole
    // scan errors out before yielding any rows. `log_session_schema` runs
    // before us and will have already reported that, so we don't repeat the
    // diagnosis here — just let the error surface with a bit of context.
    info!("opencode scan_summaries: preparing list query for {:?}", db);
    let mut stmt = conn
        .prepare(
            "SELECT id, directory, title, time_created, time_updated \
             FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC",
        )
        .context("prepare session list query (likely a schema mismatch — see schema probe above)")?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SessionRow {
                id: row.get(0)?,
                directory: row.get(1)?,
                title: row.get(2)?,
                time_created: row.get(3)?,
                time_updated: row.get(4)?,
            })
        })
        .context("query session list")?;

    let mut out = Vec::new();
    let mut row_decode_failures: u32 = 0;
    let mut summarise_failures: u32 = 0;
    for row in rows {
        let row = match row {
            Ok(r) => r,
            Err(e) => {
                // Don't bail on the whole db — one row with an unexpected NULL
                // or wrong type shouldn't hide every other session. Most
                // likely culprit: ngagent.db's `directory` column being
                // nullable while this code expects String. Keep going.
                row_decode_failures += 1;
                warn!(
                    "opencode scan_summaries {:?}: row decode failed (e.g. \
                     unexpected NULL/type for id/directory/title/time_*): {} \
                     — skipping this row",
                    db, e
                );
                continue;
            }
        };
        match summarise_session(conn, db, &row) {
            Ok(s) => out.push(s),
            Err(e) => {
                summarise_failures += 1;
                warn!("summarise_session FAILED sid={}: {}", row.id, e);
                continue;
            }
        }
    }
    info!(
        "opencode scan_summaries {:?} => {} sessions kept, {} row-decode skips, {} summarise skips",
        db,
        out.len(),
        row_decode_failures,
        summarise_failures
    );
    Ok(out)
}

struct SessionRow {
    id: String,
    directory: String,
    title: String,
    time_created: i64,
    time_updated: i64,
}

fn summarise_session(conn: &Connection, db: &Path, row: &SessionRow) -> Result<SessionSummary> {
    // Aggregate token totals + peak context across this session's assistant messages
    // in a single SQL pass — listing sessions can hit dozens of rows, so we avoid
    // touching the (much bigger) `part` table here.
    let mut stmt = conn.prepare(
        "SELECT data FROM message WHERE session_id = ?1 ORDER BY time_created",
    )?;
    let mut iter = stmt.query([&row.id])?;

    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut peak_ctx: u64 = 0;
    let mut msg_count: u32 = 0;

    while let Some(r) = iter.next()? {
        let raw: String = r.get(0)?;
        let v: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        msg_count += 1;
        if v.get("role").and_then(Value::as_str) == Some("assistant") {
            if let Some(usage) = parse_tokens(v.get("tokens")) {
                total_input += usage.input_tokens;
                total_output += usage.output_tokens;
                let ctx = usage.context_window();
                if ctx > peak_ctx {
                    peak_ctx = ctx;
                }
            }
        }
    }

    let title = if row.title.trim().is_empty() {
        None
    } else {
        Some(row.title.clone())
    };

    Ok(SessionSummary {
        provider_id: PROVIDER_ID.to_string(),
        session_id: row.id.clone(),
        title,
        cwd: Some(row.directory.clone()),
        git_branch: None, // opencode tracks vcs at the project level, not per session
        started_at: ms_to_iso(row.time_created),
        ended_at: ms_to_iso(row.time_updated),
        message_count: msg_count,
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        peak_context_tokens: peak_ctx,
        source_path: make_source_path(db, &row.id),
    })
}

fn load_session_detail(conn: &Connection, db: &Path, sid: &str) -> Result<SessionDetail> {
    debug!("load_session_detail db={:?} sid={}", db, sid);
    let srow = fetch_session_row(conn, sid)
        .with_context(|| format!("session {} not found", sid))?;
    debug!("load_session_detail found session row sid={}", sid);

    let (summary, nodes) = build_summary_and_nodes(conn, db, &srow)?;

    // Sub-agents — opencode persists them as separate `session` rows whose
    // `parent_id` points to this session. Each child is spawned by the parent's
    // `task` tool, which records the child's session id in its
    // `state.metadata.sessionId`. We use that to recover description /
    // subagent_type / parent callID and stitch each child onto the right parent
    // node in the UI.
    //
    // TODO(nested-subagents): only one level walked; if opencode ever lets a
    // sub-agent spawn its own sub-agent we'd need to recurse here.
    let task_index = build_task_index(conn, sid).unwrap_or_else(|e| {
        warn!("build_task_index failed for {}: {}", sid, e);
        std::collections::HashMap::new()
    });
    let subagents = load_subagents(conn, db, sid, &task_index).unwrap_or_else(|e| {
        warn!("load_subagents (opencode) failed for {}: {}", sid, e);
        Vec::new()
    });

    Ok(SessionDetail {
        summary,
        nodes,
        subagents,
    })
}

fn fetch_session_row(conn: &Connection, sid: &str) -> Result<SessionRow> {
    let mut stmt = conn.prepare(
        "SELECT id, directory, title, time_created, time_updated \
         FROM session WHERE id = ?1",
    ).context("prepare session row")?;
    let row = stmt.query_row([sid], |r| {
        Ok(SessionRow {
            id: r.get(0)?,
            directory: r.get(1)?,
            title: r.get(2)?,
            time_created: r.get(3)?,
            time_updated: r.get(4)?,
        })
    })?;
    Ok(row)
}

/// Walk the session's messages + parts and produce both a summary and the
/// timeline. Used for the main session and for each sub-agent session.
fn build_summary_and_nodes(
    conn: &Connection,
    db: &Path,
    srow: &SessionRow,
) -> Result<(SessionSummary, Vec<SessionNode>)> {
    let mut msg_stmt = conn.prepare(
        "SELECT id, time_created, data FROM message \
         WHERE session_id = ?1 ORDER BY time_created",
    ).context("prepare message query")?;
    let mut nodes: Vec<SessionNode> = Vec::new();
    let mut peak_ctx: u64 = 0;
    let mut total_input: u64 = 0;
    let mut total_output: u64 = 0;
    let mut msg_count: u32 = 0;

    let mut msg_iter = msg_stmt.query([&srow.id])?;
    while let Some(mr) = msg_iter.next()? {
        let mid: String = mr.get(0)?;
        let m_time: i64 = mr.get(1)?;
        let mdata: String = mr.get(2)?;
        let raw_size = mdata.len() as u64;
        let mv: Value = match serde_json::from_str(&mdata) {
            Ok(v) => v,
            Err(_) => continue,
        };
        msg_count += 1;
        let role = mv.get("role").and_then(Value::as_str).unwrap_or("");

        let parts = collect_parts(conn, &mid)?;
        let parts_size: u64 = parts.iter().map(|p| p.raw_size).sum();
        let kind = node_kind_for(role, &parts);

        let usage = parse_tokens(mv.get("tokens"));
        if let Some(u) = &usage {
            if role == "assistant" {
                total_input += u.input_tokens;
                total_output += u.output_tokens;
                let ctx = u.context_window();
                if ctx > peak_ctx {
                    peak_ctx = ctx;
                }
            }
        }

        let model = mv
            .get("modelID")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                mv.get("model")
                    .and_then(|m| m.get("modelID"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });

        let parent_id = mv
            .get("parentID")
            .and_then(Value::as_str)
            .map(str::to_string);

        let display_parts: Vec<MessagePart> = parts.into_iter().map(|p| p.part).collect();

        if !display_parts.is_empty() || usage.is_some() {
            nodes.push(SessionNode {
                id: mid,
                parent_id,
                kind,
                timestamp: ms_to_iso(m_time),
                model,
                parts: display_parts,
                usage,
                cumulative_context_tokens: Some(peak_ctx),
                raw_size_bytes: raw_size + parts_size,
            });
        }
    }

    let title = if srow.title.trim().is_empty() {
        // Fallback: first user text part.
        nodes
            .iter()
            .find(|n| matches!(n.kind, NodeKind::User))
            .and_then(|n| n.parts.iter().find_map(|p| match p {
                MessagePart::Text { text } => Some(truncate_chars(text, 80)),
                _ => None,
            }))
    } else {
        Some(srow.title.clone())
    };

    let summary = SessionSummary {
        provider_id: PROVIDER_ID.to_string(),
        session_id: srow.id.clone(),
        title,
        cwd: Some(srow.directory.clone()),
        git_branch: None,
        started_at: ms_to_iso(srow.time_created),
        ended_at: ms_to_iso(srow.time_updated),
        message_count: msg_count,
        total_input_tokens: total_input,
        total_output_tokens: total_output,
        peak_context_tokens: peak_ctx,
        source_path: make_source_path(db, &srow.id),
    };

    Ok((summary, nodes))
}

/// What we recover from a single `task` tool_use in the parent session.
/// Indexed by the child session id (read from the tool's `state.metadata.sessionId`).
struct TaskInfo {
    /// `state.input.subagent_type`, e.g. "explore" / "general".
    subagent_type: Option<String>,
    /// `state.input.description` — short human-friendly label.
    description: Option<String>,
    /// `callID` — opencode's equivalent of Claude Code's `tool_use_id`.
    call_id: Option<String>,
}

fn build_task_index(
    conn: &Connection,
    parent_sid: &str,
) -> Result<std::collections::HashMap<String, TaskInfo>> {
    let mut out = std::collections::HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT p.data FROM part p JOIN message m ON p.message_id = m.id \
         WHERE m.session_id = ?1 \
           AND json_extract(p.data, '$.type') = 'tool' \
           AND json_extract(p.data, '$.tool') = 'task'",
    )?;
    let mut iter = stmt.query([parent_sid])?;
    while let Some(r) = iter.next()? {
        let raw: String = r.get(0)?;
        let v: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let state = v.get("state").cloned().unwrap_or(Value::Null);
        let child_sid = state
            .get("metadata")
            .and_then(|m| m.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let Some(child_sid) = child_sid else { continue };

        let input = state.get("input").cloned().unwrap_or(Value::Null);
        let info = TaskInfo {
            subagent_type: input
                .get("subagent_type")
                .and_then(Value::as_str)
                .map(str::to_string),
            description: input
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            call_id: v
                .get("callID")
                .and_then(Value::as_str)
                .map(str::to_string),
        };
        out.insert(child_sid, info);
    }
    Ok(out)
}

fn load_subagents(
    conn: &Connection,
    db: &Path,
    parent_sid: &str,
    task_index: &std::collections::HashMap<String, TaskInfo>,
) -> Result<Vec<SubAgentSession>> {
    let mut stmt = conn.prepare(
        "SELECT id, directory, title, time_created, time_updated \
         FROM session WHERE parent_id = ?1 ORDER BY time_created",
    )?;
    let mut iter = stmt.query([parent_sid])?;
    let mut rows: Vec<SessionRow> = Vec::new();
    while let Some(r) = iter.next()? {
        rows.push(SessionRow {
            id: r.get(0)?,
            directory: r.get(1)?,
            title: r.get(2)?,
            time_created: r.get(3)?,
            time_updated: r.get(4)?,
        });
    }

    let mut type_counters: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();
    let mut out = Vec::with_capacity(rows.len());

    for srow in rows {
        let info = task_index.get(&srow.id);

        // agent_type priority: parent task's subagent_type → fall back to
        // "subagent". (We don't try to parse it out of the title — opencode's
        // title format may evolve.)
        let agent_type = info
            .and_then(|i| i.subagent_type.clone())
            .unwrap_or_else(|| "subagent".to_string());

        let counter = type_counters.entry(agent_type.clone()).or_insert(0);
        *counter += 1;
        let type_ordinal = *counter;

        let description = info.and_then(|i| i.description.clone());
        let parent_tool_use_id = info.and_then(|i| i.call_id.clone());

        let (mut summary, nodes) = match build_summary_and_nodes(conn, db, &srow) {
            Ok(x) => x,
            Err(e) => {
                warn!("build_summary_and_nodes failed for subagent {}: {}", srow.id, e);
                continue;
            }
        };

        // Prefer the description when it's available — it's shorter and was
        // chosen by the model as the call's purpose.
        if let Some(desc) = description.as_ref() {
            if !desc.is_empty() {
                summary.title = Some(desc.clone());
            }
        }

        out.push(SubAgentSession {
            agent_id: srow.id,
            agent_type,
            kind: SubAgentKind::Normal,
            type_ordinal,
            description,
            parent_tool_use_id,
            summary,
            nodes,
        });
    }

    Ok(out)
}

struct PartWithSize {
    part: MessagePart,
    raw_size: u64,
}

fn collect_parts(conn: &Connection, message_id: &str) -> Result<Vec<PartWithSize>> {
    let mut stmt = conn.prepare(
        "SELECT data FROM part WHERE message_id = ?1 ORDER BY time_created",
    )?;
    let mut rows = stmt.query([message_id])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let raw: String = r.get(0)?;
        let raw_size = raw.len() as u64;
        let v: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(part) = part_from_value(&v) {
            out.push(PartWithSize { part, raw_size });
        }
    }
    Ok(out)
}

fn part_from_value(v: &Value) -> Option<MessagePart> {
    let kind = v.get("type").and_then(Value::as_str)?;
    match kind {
        "text" => {
            let text = v
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            // Synthetic text parts are tool-call/result shims opencode injects to
            // make the timeline read like a chat. They're noise next to the real
            // tool node, but useful when nothing else is around.
            if v.get("synthetic").and_then(Value::as_bool).unwrap_or(false) {
                Some(MessagePart::Note { text })
            } else {
                Some(MessagePart::Text { text })
            }
        }
        "reasoning" => Some(MessagePart::Thinking {
            text: v
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        }),
        "tool" => {
            let name = v.get("tool").and_then(Value::as_str).unwrap_or("").to_string();
            // opencode collapses the Anthropic call/result pair into one row;
            // see `combine_tool` for how we fold input + output into a single
            // MessagePart.
            Some(combine_tool(v, &name))
        }
        "file" => {
            let path = v
                .get("filename")
                .and_then(Value::as_str)
                .or_else(|| v.get("url").and_then(Value::as_str))
                .unwrap_or("")
                .to_string();
            let mime = v.get("mime").and_then(Value::as_str).map(str::to_string);
            Some(MessagePart::Attachment { path, mime })
        }
        "patch" => {
            let files = v
                .get("files")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|f| f.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            let hash = v.get("hash").and_then(Value::as_str).unwrap_or("");
            Some(MessagePart::Note {
                text: format!("[patch {}] {}", hash, files),
            })
        }
        "image" => {
            let mime = v
                .get("mime")
                .and_then(Value::as_str)
                .unwrap_or("image/*")
                .to_string();
            // opencode stores images by URL, not raw bytes; we report 0 since we
            // don't know the size without fetching.
            Some(MessagePart::Image {
                media_type: mime,
                bytes: 0,
            })
        }
        // step-start / step-finish are framework bookkeeping; drop them so the
        // timeline only shows things the user cares about.
        _ => None,
    }
}

/// Render a `tool` part into a ToolUse-style entry. Output text is appended
/// to the input section so a single MessagePart still carries both halves.
fn combine_tool(v: &Value, name: &str) -> MessagePart {
    let call_id = v
        .get("callID")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let state = v.get("state").cloned().unwrap_or(Value::Null);
    let status = state
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("");
    let is_error = status == "error";
    let input_str = state
        .get("input")
        .map(|i| serde_json::to_string_pretty(i).unwrap_or_default())
        .unwrap_or_default();

    if is_error {
        let err_text = state
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("(unknown error)")
            .to_string();
        return MessagePart::ToolResult {
            tool_use_id: call_id,
            content: format!("tool={}\ninput={}\nerror={}", name, input_str, err_text),
            is_error: true,
        };
    }

    // For completed tools, emit the ToolUse view; the human-readable output is
    // included as the `input` payload so the viewer shows it without needing a
    // separate ToolResult node (opencode doesn't model that pairing).
    let output = state
        .get("output")
        .and_then(Value::as_str)
        .map(|s| s.to_string());
    let mut input = input_str;
    if let Some(out) = output {
        if !out.trim().is_empty() {
            input.push_str("\n\n--- output ---\n");
            input.push_str(&out);
        }
    }
    MessagePart::ToolUse {
        tool_use_id: call_id,
        name: name.to_string(),
        input,
    }
}

fn parse_tokens(v: Option<&Value>) -> Option<TokenUsage> {
    let v = v?;
    let input = v.get("input").and_then(Value::as_u64).unwrap_or(0);
    let output = v.get("output").and_then(Value::as_u64).unwrap_or(0);
    let cache_read = v
        .get("cache")
        .and_then(|c| c.get("read"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_write = v
        .get("cache")
        .and_then(|c| c.get("write"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if input == 0 && output == 0 && cache_read == 0 && cache_write == 0 {
        return None;
    }
    Some(TokenUsage {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cache_write,
        cache_read_input_tokens: cache_read,
        service_tier: None,
    })
}

fn node_kind_for(role: &str, parts: &[PartWithSize]) -> NodeKind {
    match role {
        "user" => {
            // Some opencode "user" messages are actually tool result shims (after
            // an assistant invokes a tool). They show up as synthetic text with
            // no actual user content.
            let any_real_text = parts.iter().any(|p| {
                matches!(&p.part, MessagePart::Text { text } if !text.trim().is_empty())
            });
            if any_real_text {
                NodeKind::User
            } else {
                NodeKind::ToolResult
            }
        }
        "assistant" => NodeKind::Assistant,
        "system" => NodeKind::System,
        _ => NodeKind::Meta,
    }
}

fn ms_to_iso(ms: i64) -> Option<String> {
    use chrono::{TimeZone, Utc};
    if ms <= 0 {
        return None;
    }
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn truncate_chars(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push('…');
    }
    out
}
