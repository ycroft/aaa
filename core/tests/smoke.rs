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
