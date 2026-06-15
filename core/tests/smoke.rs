use std::path::PathBuf;

use aaa_core::providers::{claude_code::ClaudeCodeProvider, opencode::OpencodeProvider, SessionProvider};

#[test]
fn parses_a_real_claude_session_when_one_is_present() {
    let Some(home) = dirs::home_dir() else { return };
    let root = home.join(".claude").join("projects");
    if !root.exists() {
        return;
    }
    let provider = ClaudeCodeProvider;
    let summaries = provider.list_sessions(&root).expect("list_sessions");
    if summaries.is_empty() {
        eprintln!("no Claude sessions on disk; smoke test skipped");
        return;
    }

    let s = &summaries[0];
    assert_eq!(s.provider_id, "claude-code");

    let path = PathBuf::from(&s.source_path);
    let detail = provider.load_session(&path).expect("load_session");
    assert_eq!(detail.summary.session_id, s.session_id);
    assert!(!detail.nodes.is_empty(), "session has zero nodes");

    let mut cum_max = 0u64;
    for n in &detail.nodes {
        if let Some(c) = n.cumulative_context_tokens {
            assert!(c >= cum_max, "cumulative ctx went backwards");
            cum_max = c;
        }
    }
    assert!(detail.summary.peak_context_tokens >= cum_max);

    // Sanity-check classification: most sessions should produce a mix
    // of user, assistant and tool_result kinds.
    let kinds: std::collections::HashSet<_> = detail
        .nodes
        .iter()
        .map(|n| format!("{:?}", n.kind))
        .collect();
    eprintln!("kinds present: {:?}", kinds);
    eprintln!(
        "session: {} nodes, peak ctx {} tokens, title {:?}",
        detail.nodes.len(),
        detail.summary.peak_context_tokens,
        detail.summary.title
    );
}

#[test]
fn parses_a_real_opencode_session_when_one_is_present() {
    let Some(root) = dirs::data_local_dir().map(|d| d.join("opencode")) else { return };
    if !root.join("opencode.db").exists() {
        return;
    }
    let provider = OpencodeProvider;
    let summaries = provider.list_sessions(&root).expect("list_sessions");
    if summaries.is_empty() {
        eprintln!("no opencode sessions in db; smoke test skipped");
        return;
    }

    eprintln!("opencode sessions found: {}", summaries.len());
    for s in &summaries {
        eprintln!(
            "  {} | msgs={} peak_ctx={} title={:?}",
            s.session_id, s.message_count, s.peak_context_tokens, s.title
        );
        assert_eq!(s.provider_id, "opencode");
        assert!(s.source_path.contains('#'), "source_path must encode db#sid");
    }

    // Pick the largest session (by message count) so we exercise tool/reasoning paths.
    let s = summaries.iter().max_by_key(|s| s.message_count).unwrap();
    let path = PathBuf::from(&s.source_path);
    let detail = provider.load_session(&path).expect("load_session");
    assert_eq!(detail.summary.session_id, s.session_id);
    assert!(!detail.nodes.is_empty(), "session has zero nodes");

    let mut cum_max = 0u64;
    for n in &detail.nodes {
        if let Some(c) = n.cumulative_context_tokens {
            assert!(c >= cum_max, "cumulative ctx went backwards");
            cum_max = c;
        }
    }
    assert!(detail.summary.peak_context_tokens >= cum_max);

    let kinds: std::collections::HashSet<_> = detail
        .nodes
        .iter()
        .map(|n| format!("{:?}", n.kind))
        .collect();
    eprintln!("opencode kinds present: {:?}", kinds);
    eprintln!(
        "opencode session: {} nodes, peak ctx {} tokens, title {:?}",
        detail.nodes.len(),
        detail.summary.peak_context_tokens,
        detail.summary.title
    );
}

#[test]
fn parses_a_real_code_agent_3x_session_when_one_is_present() {
    use aaa_core::providers::code_agent_3x::CodeAgent3xProvider;

    let Some(home) = dirs::home_dir() else { return };
    let root = home.join(".cac").join("projects");
    if !root.exists() {
        return;
    }
    let provider = CodeAgent3xProvider;
    let summaries = provider.list_sessions(&root).expect("list_sessions");
    if summaries.is_empty() {
        eprintln!("no Code Agent 3.x sessions on disk; smoke test skipped");
        return;
    }

    let s = &summaries[0];
    assert_eq!(s.provider_id, "code-agent-3x");

    let path = PathBuf::from(&s.source_path);
    let detail = provider.load_session(&path).expect("load_session");
    assert_eq!(detail.summary.session_id, s.session_id);
    assert!(!detail.nodes.is_empty(), "session has zero nodes");

    let mut cum_max = 0u64;
    for n in &detail.nodes {
        if let Some(c) = n.cumulative_context_tokens {
            assert!(c >= cum_max, "cumulative ctx went backwards");
            cum_max = c;
        }
    }
    assert!(detail.summary.peak_context_tokens >= cum_max);

    eprintln!(
        "code-agent-3x session: {} nodes, peak ctx {} tokens, title {:?}",
        detail.nodes.len(),
        detail.summary.peak_context_tokens,
        detail.summary.title
    );
}

#[test]
fn code_agent_3x_provider_parses_a_minimal_fixture() {
    use aaa_core::providers::code_agent_3x::CodeAgent3xProvider;
    use std::fs;
    use tempfile::TempDir;

    let tmp = TempDir::new().unwrap();
    let project_dir = tmp.path().join("-home-user-proj");
    fs::create_dir_all(&project_dir).unwrap();
    let session_path = project_dir.join("01ABCDEF.jsonl");
    fs::write(
        &session_path,
        concat!(
            r#"{"type":"user","uuid":"u1","timestamp":"2026-06-15T09:00:00Z","cwd":"/home/user/proj","message":{"content":"hello"}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"a1","timestamp":"2026-06-15T09:00:01Z","message":{"id":"msg_1","model":"claude-opus-4-6","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#,
            "\n",
        ),
    )
    .unwrap();

    let provider = CodeAgent3xProvider;
    let summaries = provider
        .list_sessions(&tmp.path().to_path_buf())
        .expect("list_sessions");
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].provider_id, "code-agent-3x");

    let detail = provider
        .load_session(&std::path::PathBuf::from(&summaries[0].source_path))
        .expect("load_session");
    assert_eq!(detail.summary.provider_id, "code-agent-3x");
    assert_eq!(detail.summary.session_id, "01ABCDEF");
    assert_eq!(detail.nodes.len(), 2);
}


#[tokio::test(flavor = "multi_thread")]
async fn opencode_incremental_smoke_against_real_sqlite_db() {
    use aaa_core::remote::incremental::{
        ensure_opencode_schema, open_cache_db, sync_opencode_incremental,
    };
    use aaa_core::remote::{DirEntry, FileMeta, RemoteError, RemoteFs, SyncContext};
    use async_trait::async_trait;
    use rusqlite::Connection;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use tempfile::TempDir;

    // Skip silently if `sqlite3` isn't on this machine — CI may not have it.
    if Command::new("sqlite3").arg("-version").output().is_err() {
        eprintln!("smoke: sqlite3 binary missing, skipping incremental smoke");
        return;
    }

    let tmp = TempDir::new().expect("tempdir");
    // 1. Build a "remote" db with one session + one message + one part.
    let remote_db = tmp.path().join("remote.db");
    {
        let conn = Connection::open(&remote_db).unwrap();
        ensure_opencode_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) \
             VALUES ('s1', NULL, '/', 'first', 100, 100)",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO message (id, role, session_id, time_created, data) \
             VALUES ('m1', 'user', 's1', 110, '{}')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO part (id, message_id, type, tool, time_created, data) \
             VALUES ('p1', 'm1', 'text', NULL, 120, '{}')",
            [],
        ).unwrap();
    }

    // 2. Pre-seed the cache db (simulating a prior full SFTP sync) by copying.
    let cache_dir = tmp.path().join("cache");
    std::fs::create_dir_all(&cache_dir).unwrap();
    let cache_db = cache_dir.join("opencode.db");
    std::fs::copy(&remote_db, &cache_db).unwrap();
    // Ensure aaa_sync_state table is present on the cache db.
    drop(open_cache_db(&cache_db).unwrap());

    // 3. Local sqlite3 CLI as the "remote".
    struct LocalSqliteFs(std::path::PathBuf);
    #[async_trait]
    impl RemoteFs for LocalSqliteFs {
        async fn home_dir(&mut self) -> Result<String, RemoteError> {
            Ok("/".into())
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
            _max: u64,
        ) -> Result<Vec<u8>, RemoteError> {
            // Substitute the placeholder remote path with the local file.
            let real_argv: Vec<String> = argv
                .iter()
                .map(|a| {
                    if *a == "/remote/opencode.db" {
                        self.0.to_string_lossy().into_owned()
                    } else {
                        (*a).to_string()
                    }
                })
                .collect();
            let mut child = Command::new(&real_argv[0])
                .args(&real_argv[1..])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| RemoteError::Exec {
                    code: -1,
                    stderr: e.to_string(),
                })?;
            use std::io::Write;
            child.stdin.as_mut().unwrap().write_all(stdin).unwrap();
            let out = child.wait_with_output().map_err(|e| RemoteError::Exec {
                code: -1,
                stderr: e.to_string(),
            })?;
            if !out.status.success() {
                return Err(RemoteError::Exec {
                    code: out.status.code().unwrap_or(-1),
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                });
            }
            Ok(out.stdout)
        }
    }

    let mut fs = LocalSqliteFs(remote_db.clone());
    let mut ctx = SyncContext::noop();
    let stats = sync_opencode_incremental(&mut fs, "/remote", &cache_dir, &mut ctx)
        .await
        .expect("first incremental sync");
    assert!(stats.bytes_pulled > 0);

    // 4. Add a new session row remotely; second sync should pick it up.
    {
        let conn = Connection::open(&remote_db).unwrap();
        conn.execute(
            "INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) \
             VALUES ('s2', NULL, '/', 'second', 200, 200)",
            [],
        ).unwrap();
    }
    sync_opencode_incremental(&mut fs, "/remote", &cache_dir, &mut SyncContext::noop())
        .await
        .expect("second incremental sync");
    let conn = Connection::open(&cache_db).unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM session", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 2);
}


