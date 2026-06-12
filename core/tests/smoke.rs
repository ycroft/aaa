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
