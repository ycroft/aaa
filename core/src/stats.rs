//! Cross-provider session statistics that don't belong on the unified
//! [`SessionDetail`] itself — anything we want to compute on-demand from a
//! parsed session, without bloating every provider's parse path or every
//! response payload.
//!
//! Right now this houses skill-usage aggregation. Future stats (model
//! switches, longest tool runs, …) can land here too.
//!
//! ## Skill detection — owned by each provider
//!
//! `SkillUsage` is the cross-provider output type. Extraction lives on the
//! [`SessionProvider`] trait (`fn skill_usage(&self, detail) -> Vec<SkillUsage>`)
//! with a default that returns empty, so each provider decides whether and
//! how it can extract structured skill records.
//!
//! Two detection modes are available:
//! * **Assistant-source**: scan `tool_use { name == "Skill" }` records — only
//!   Claude-Code-shape providers emit these. Implemented in
//!   [`crate::providers::anthropic_jsonl::collect_skill_usage`].
//! * **User-source**: build a [`crate::skills::SkillRegistry`] from the
//!   provider's `skill_roots()` and fingerprint-match user-text part heads.
//!   Catches Claude Code `/skill-name` slash invocations and opencode's
//!   built-in/external skill injections.

use serde::{Deserialize, Serialize};

use crate::model::SessionDetail;

/// Where a skill invocation came from.
///
/// `User` — fingerprint match on a user-text part (Claude Code `/skill-name`
/// slash invocation, or any opencode skill injection).
/// `Assistant` — structured `tool_use { name: "Skill" }` record (only Claude
/// Code emits these today).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillSource {
    User,
    Assistant,
}

impl Default for SkillSource {
    fn default() -> Self {
        SkillSource::Assistant
    }
}

/// One row of the skill-usage report. Aggregated by `(skill_id, source)`
/// across the parent session and all its sub-agents — User and Assistant
/// invocations of the same skill stay as separate rows so the UI can show
/// who triggered it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillUsage {
    /// Skill identifier — directory name on disk for User-source rows, or the
    /// `input.skill` value for Assistant-source rows. We don't strip
    /// namespaces — users sometimes invoke with and without one, and merging
    /// would hide that.
    pub skill_id: String,
    /// Display name from the SKILL.md frontmatter `name:` field. None for
    /// Assistant-source rows where we couldn't match the id back to a known
    /// SKILL.md.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_name: Option<String>,
    /// Whether the trigger was a user-text fingerprint or an assistant
    /// tool_use. Defaults to Assistant for backwards compatibility with
    /// payloads written before this field existed.
    #[serde(default)]
    pub source: SkillSource,
    /// Total invocations.
    pub count: u32,
    /// How many of those invocations had a paired tool_result with `is_error == true`.
    /// Always 0 for User-source rows (no tool_result pairing possible).
    pub error_count: u32,
    /// First and last timestamp seen for this skill, ISO-8601 strings as
    /// produced by the provider. Either may be `None` if the source node had
    /// no timestamp.
    pub first_at: Option<String>,
    pub last_at: Option<String>,
    /// Node ids where this skill was detected, in occurrence order. Used by
    /// the UI to attach a per-node chip.
    #[serde(default)]
    pub node_ids: Vec<String>,
}

/// Collect skill-usage rows from a session detail.
///
/// Dispatches through the provider registry — each provider decides how
/// (or whether) to extract structured skill records. See the module docstring
/// for the design rationale.
pub fn skill_usage(detail: &SessionDetail) -> Vec<SkillUsage> {
    crate::providers::find(&detail.summary.provider_id)
        .map(|p| p.skill_usage(detail))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        MessagePart, NodeKind, SessionDetail, SessionNode, SessionSummary, SubAgentKind,
        SubAgentSession,
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
            used_skills: Vec::new(),
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
                output: None,
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
    fn provider_dispatch_returns_empty_for_unknown() {
        // The dispatcher returns empty for any provider id we don't know
        // about — protects callers from panics on stale data.
        let detail = SessionDetail {
            summary: empty_summary("unknown-provider"),
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
