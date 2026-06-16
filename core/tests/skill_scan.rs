use aaa_core::providers::{claude_code::ClaudeCodeProvider, SessionProvider};

/// After the async-skill-scan refactor, `list_sessions` must NOT populate
/// `summary.used_skills`. Filling it is the job of `scan_session_skills`,
/// invoked off the listing critical path.
#[test]
fn list_sessions_does_not_populate_used_skills_anymore() {
    use std::fs;
    use tempfile::TempDir;

    let tmp = TempDir::new().unwrap();
    let project_dir = tmp.path().join("-home-user-proj");
    fs::create_dir_all(&project_dir).unwrap();
    let session_path = project_dir.join("01ABCDEF.jsonl");
    // Minimal session containing an assistant `tool_use` of name "Skill" —
    // exactly the shape the *old* scan_summary would have decoded into
    // `used_skills`. After the refactor it must come back empty.
    fs::write(
        &session_path,
        concat!(
            r#"{"type":"user","uuid":"u1","timestamp":"2026-06-15T09:00:00Z","cwd":"/home/user/proj","message":{"content":"hello"}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"a1","timestamp":"2026-06-15T09:00:01Z","message":{"id":"msg_1","model":"claude-opus-4-6","content":[{"type":"tool_use","id":"tu1","name":"Skill","input":{"skill":"superpowers:brainstorming"}}],"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#,
            "\n",
        ),
    )
    .unwrap();

    let provider = ClaudeCodeProvider;
    let summaries = provider
        .list_sessions(&tmp.path().to_path_buf())
        .expect("list_sessions");
    assert_eq!(summaries.len(), 1);
    assert!(
        summaries[0].used_skills.is_empty(),
        "list_sessions must not populate used_skills (got {:?})",
        summaries[0].used_skills
    );
}

/// `scan_session_skills` is the new trait method that does the per-session
/// skill detection asynchronously. It must extract the same skill IDs the
/// previous inline scan would have produced.
#[test]
fn scan_session_skills_extracts_skills_from_jsonl() {
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
            r#"{"type":"assistant","uuid":"a1","timestamp":"2026-06-15T09:00:01Z","message":{"id":"msg_1","model":"claude-opus-4-6","content":[{"type":"tool_use","id":"tu1","name":"Skill","input":{"skill":"superpowers:brainstorming"}}],"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}"#,
            "\n",
        ),
    )
    .unwrap();

    let provider = ClaudeCodeProvider;
    let used = provider
        .scan_session_skills(&session_path)
        .expect("scan_session_skills");
    assert!(
        used.iter().any(|s| s.contains("brainstorming")),
        "expected a 'brainstorming' skill id, got {:?}",
        used
    );
}

/// On machines with a real opencode db, listing sessions must also leave
/// `used_skills` empty. Skips silently when no opencode db is on disk so the
/// test isn't a CI tripwire.
#[test]
fn opencode_list_sessions_does_not_populate_used_skills_anymore() {
    use aaa_core::providers::opencode::OpencodeProvider;

    let Some(root) = dirs::data_local_dir().map(|d| d.join("opencode")) else {
        return;
    };
    if !root.join("opencode.db").exists() {
        return;
    }
    let provider = OpencodeProvider;
    let summaries = provider.list_sessions(&root).expect("list_sessions");
    if summaries.is_empty() {
        return;
    }
    for s in &summaries {
        assert!(
            s.used_skills.is_empty(),
            "opencode list_sessions must not populate used_skills (sid={}, got {:?})",
            s.session_id,
            s.used_skills
        );
    }
}
