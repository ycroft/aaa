//! Cross-provider session statistics that don't belong on the unified
//! [`SessionDetail`] itself — anything we want to compute on-demand from a
//! parsed session, without bloating every provider's parse path or every
//! response payload.
//!
//! Right now this houses skill-usage aggregation. Future stats (model
//! switches, longest tool runs, …) can land here too.
//!
//! ## Skill detection — why per-provider, not in the trait
//!
//! "Skill" is not a universal concept across backends:
//!
//! * **Claude Code** records each invocation as a structured `tool_use` with
//!   `name == "Skill"` and an `input` JSON `{ "skill": "<id>", "args": "..." }`.
//!   That gives us a clean, reliable signal — see [`collect_claude_code`].
//!
//! * **opencode** has no first-class skill record. Skills are injected as a
//!   plain `role=user` text part — indistinguishable from a long pasted
//!   prompt without out-of-band knowledge of the skill template content.
//!   On a fresh database, `part.data` and `message.data` simply contain no
//!   `skill` key whatsoever.
//!
//! Rather than push that asymmetry into the [`SessionProvider`] trait, we
//! match on `provider_id` here. The trait stays focused on "parse native log
//! into nodes"; `stats.rs` does the cross-cutting work.
//!
//! ## TODO(phase-2): opencode heuristic skill detection
//!
//! When/if we want to surface opencode skills:
//!
//! 1. Build a fingerprint library from the on-disk skill templates. Likely
//!    sources (need to confirm by checking a fresh install with skills set up):
//!      - `~/.config/opencode/command/*.md`
//!      - `<project>/.opencode/command/*.md`
//!      - bundled definitions inside the opencode npm package under
//!        `~/.config/opencode/node_modules/@opencode-ai/...`
//!    Each entry → `(skill_id, normalised_template_hash, first_n_chars)`.
//!
//! 2. For every `MessagePart::Text` on a `NodeKind::User` node, normalise
//!    whitespace + strip user-supplied trailing args, then look up the
//!    fingerprint. Hits become `SkillUsage` rows.
//!
//! 3. Tag those rows so the UI can show "heuristic match" — distinct from
//!    Claude Code's exact match. A confidence field on [`SkillUsage`] would
//!    suffice; add it then, not now (premature).
//!
//! 4. Be conservative on false positives: a 3000-char prompt that happens to
//!    start with `# PRD` shouldn't match unless the body also matches.
//!    Prefix-only matching is too loose.
//!
//! Until that work happens, [`skill_usage`] returns an empty vec for any
//! provider other than Claude Code, which is honest about what we can see.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::{MessagePart, SessionDetail, SessionNode};

/// One row of the skill-usage report. Aggregated by `skill_id` across the
/// parent session and all its sub-agents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillUsage {
    /// Skill identifier as it appears in the tool input (e.g.
    /// `superpowers:brainstorming` or a bare name like `prd`). We don't
    /// strip namespaces — users sometimes invoke with and without one,
    /// and merging them would hide that.
    pub skill_id: String,
    /// Total invocations.
    pub count: u32,
    /// How many of those invocations had a paired tool_result with `is_error == true`.
    pub error_count: u32,
    /// First and last timestamp seen for this skill, ISO-8601 strings as
    /// produced by the provider. Either may be `None` if the source node had
    /// no timestamp.
    pub first_at: Option<String>,
    pub last_at: Option<String>,
}

/// Collect skill-usage rows from a session detail.
///
/// Walks the parent session and every sub-agent's nodes. Returns a vec
/// sorted by `count` desc, then `skill_id` asc, so the UI can render it
/// straight without re-sorting.
///
/// Provider-specific behaviour:
/// - `claude-code`: exact, structured detection (see module docstring).
/// - everything else: returns an empty vec. See the phase-2 TODO above.
pub fn skill_usage(detail: &SessionDetail) -> Vec<SkillUsage> {
    match detail.summary.provider_id.as_str() {
        "claude-code" => collect_claude_code(detail),
        _ => Vec::new(),
    }
}

/// Mutable accumulator while we're scanning nodes. Becomes a `SkillUsage`
/// at the end. Splitting it out keeps the merge step a plain map walk.
#[derive(Default)]
struct Acc {
    count: u32,
    error_count: u32,
    first_at: Option<String>,
    last_at: Option<String>,
}

fn collect_claude_code(detail: &SessionDetail) -> Vec<SkillUsage> {
    let mut acc: HashMap<String, Acc> = HashMap::new();

    scan_nodes(&detail.nodes, &mut acc);
    for sa in &detail.subagents {
        scan_nodes(&sa.nodes, &mut acc);
    }

    let mut out: Vec<SkillUsage> = acc
        .into_iter()
        .map(|(skill_id, a)| SkillUsage {
            skill_id,
            count: a.count,
            error_count: a.error_count,
            first_at: a.first_at,
            last_at: a.last_at,
        })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.skill_id.cmp(&b.skill_id)));
    out
}

fn scan_nodes(nodes: &[SessionNode], acc: &mut HashMap<String, Acc>) {
    // First pass: collect (tool_use_id -> skill_id) for all `Skill` ToolUse
    // parts, plus the count + timestamps. Second pass: walk ToolResult parts
    // and bump error_count on the matching skill_id when is_error is true.
    //
    // Two passes (instead of pairing inline) keeps ordering robust — in
    // Claude Code's jsonl, the assistant's tool_use block and the
    // following user's tool_result usually arrive in adjacent records, but
    // we don't want to rely on that.
    let mut tool_use_to_skill: HashMap<String, String> = HashMap::new();

    for node in nodes {
        for part in &node.parts {
            if let MessagePart::ToolUse {
                tool_use_id,
                name,
                input,
            } = part
            {
                if name != "Skill" {
                    continue;
                }
                let Some(skill_id) = parse_skill_id(input) else {
                    // Skipping rather than counting under a synthetic key:
                    // a `Skill` tool_use with no `input.skill` field is malformed
                    // and wouldn't help any consumer of these stats.
                    continue;
                };
                tool_use_to_skill.insert(tool_use_id.clone(), skill_id.clone());

                let entry = acc.entry(skill_id).or_default();
                entry.count += 1;
                if let Some(ts) = node.timestamp.as_ref() {
                    if entry.first_at.is_none() {
                        entry.first_at = Some(ts.clone());
                    }
                    entry.last_at = Some(ts.clone());
                }
            }
        }
    }

    for node in nodes {
        for part in &node.parts {
            if let MessagePart::ToolResult {
                tool_use_id,
                is_error,
                ..
            } = part
            {
                if !is_error {
                    continue;
                }
                if let Some(skill_id) = tool_use_to_skill.get(tool_use_id) {
                    if let Some(entry) = acc.get_mut(skill_id) {
                        entry.error_count += 1;
                    }
                }
            }
        }
    }
}

/// `input` is a pretty-printed JSON string produced by the Claude Code
/// provider. We only read the `skill` field — `args`, when present, is
/// payload that doesn't affect the count.
fn parse_skill_id(input: &str) -> Option<String> {
    let v: Value = serde_json::from_str(input).ok()?;
    v.get("skill")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        NodeKind, SessionDetail, SessionNode, SessionSummary, SubAgentKind, SubAgentSession,
    };

    fn empty_summary(provider: &str) -> SessionSummary {
        SessionSummary {
            provider_id: provider.into(),
            session_id: "s1".into(),
            title: None,
            cwd: None,
            git_branch: None,
            started_at: None,
            ended_at: None,
            message_count: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            peak_context_tokens: 0,
            source_path: "/tmp/x".into(),
        }
    }

    fn skill_node(id: &str, ts: Option<&str>, tool_use_id: &str, skill: &str) -> SessionNode {
        SessionNode {
            id: id.into(),
            parent_id: None,
            kind: NodeKind::Assistant,
            timestamp: ts.map(str::to_string),
            model: None,
            parts: vec![MessagePart::ToolUse {
                tool_use_id: tool_use_id.into(),
                name: "Skill".into(),
                input: format!("{{\"skill\":\"{}\"}}", skill),
            }],
            usage: None,
            cumulative_context_tokens: None,
            raw_size_bytes: 0,
        }
    }

    fn result_node(id: &str, tool_use_id: &str, is_error: bool) -> SessionNode {
        SessionNode {
            id: id.into(),
            parent_id: None,
            kind: NodeKind::ToolResult,
            timestamp: None,
            model: None,
            parts: vec![MessagePart::ToolResult {
                tool_use_id: tool_use_id.into(),
                content: "ok".into(),
                is_error,
            }],
            usage: None,
            cumulative_context_tokens: None,
            raw_size_bytes: 0,
        }
    }

    #[test]
    fn opencode_returns_empty_for_now() {
        let detail = SessionDetail {
            summary: empty_summary("opencode"),
            nodes: vec![skill_node("n1", None, "t1", "prd")],
            subagents: vec![],
            tps_session: None,
            tps_per_agent: std::collections::HashMap::new(),
        };
        assert!(skill_usage(&detail).is_empty());
    }

    #[test]
    fn claude_code_counts_skills_and_pairs_errors() {
        let detail = SessionDetail {
            summary: empty_summary("claude-code"),
            nodes: vec![
                skill_node("n1", Some("2026-05-14T09:30:47Z"), "t1", "superpowers:brainstorming"),
                result_node("r1", "t1", false),
                skill_node("n2", Some("2026-05-14T10:00:00Z"), "t2", "superpowers:brainstorming"),
                result_node("r2", "t2", true),
                skill_node("n3", Some("2026-05-14T10:30:00Z"), "t3", "prd"),
            ],
            subagents: vec![],
            tps_session: None,
            tps_per_agent: std::collections::HashMap::new(),
        };
        let rows = skill_usage(&detail);
        assert_eq!(rows.len(), 2);
        let brainstorm = rows.iter().find(|r| r.skill_id.ends_with("brainstorming")).unwrap();
        assert_eq!(brainstorm.count, 2);
        assert_eq!(brainstorm.error_count, 1);
        assert_eq!(brainstorm.first_at.as_deref(), Some("2026-05-14T09:30:47Z"));
        assert_eq!(brainstorm.last_at.as_deref(), Some("2026-05-14T10:00:00Z"));
        let prd = rows.iter().find(|r| r.skill_id == "prd").unwrap();
        assert_eq!(prd.count, 1);
        assert_eq!(prd.error_count, 0);
        // sort: brainstorm (count 2) before prd (count 1)
        assert_eq!(rows[0].skill_id, "superpowers:brainstorming");
    }

    #[test]
    fn claude_code_aggregates_subagent_skills() {
        let mut detail = SessionDetail {
            summary: empty_summary("claude-code"),
            nodes: vec![skill_node("n1", None, "t1", "prd")],
            subagents: vec![],
            tps_session: None,
            tps_per_agent: std::collections::HashMap::new(),
        };
        detail.subagents.push(SubAgentSession {
            agent_id: "a1".into(),
            agent_type: "explore".into(),
            kind: SubAgentKind::Normal,
            type_ordinal: 1,
            description: None,
            parent_tool_use_id: None,
            summary: empty_summary("claude-code"),
            nodes: vec![skill_node("n2", None, "t2", "prd")],
        });
        let rows = skill_usage(&detail);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].skill_id, "prd");
        assert_eq!(rows[0].count, 2);
    }

    #[test]
    fn malformed_input_is_skipped() {
        // Missing skill field — must not produce a synthetic row.
        let mut node = skill_node("n1", None, "t1", "prd");
        if let MessagePart::ToolUse { input, .. } = &mut node.parts[0] {
            *input = "{\"args\":\"oops\"}".into();
        }
        let detail = SessionDetail {
            summary: empty_summary("claude-code"),
            nodes: vec![node],
            subagents: vec![],
            tps_session: None,
            tps_per_agent: std::collections::HashMap::new(),
        };
        assert!(skill_usage(&detail).is_empty());
    }
}
