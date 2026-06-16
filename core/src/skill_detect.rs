//! Unified skill-detection pipeline.
//!
//! Both list-view (cheap, raw-record streaming) and full-view (over parsed
//! [`SessionNode`]s) push events into a single [`SkillDetector`]. The
//! detector then yields either a flat list of skill ids (for
//! `SessionSummary.used_skills`) or aggregated [`SkillUsage`] rows.
//!
//! Two event kinds are recognised:
//!
//! * **User-text fingerprint match** — first text part of a `User`-kind node
//!   matched a known SKILL.md fingerprint. Catches Claude Code
//!   `/skill-name` slash invocations and opencode's user-text injection.
//! * **Assistant skill tool_use** — a `tool_use` part whose tool name is
//!   `Skill` (Claude Code) or `skill` (opencode) and whose input names a
//!   skill id. Tool name matching is **case-insensitive** so providers don't
//!   need to agree on the exact spelling, and the input parser accepts both
//!   `{"skill": "..."}` (Claude) and `{"name": "..."}` (opencode) shapes.
//!
//! ToolResult parts with `is_error == true` get paired back to their
//! tool_use_id and increment the matching skill's `error_count`. opencode
//! collapses success-tool-use into a single `ToolUse` part and routes
//! failures through `ToolResult`, so the same pairing logic works for both.

use std::collections::{BTreeSet, HashMap};

use serde_json::Value;

use crate::model::{MessagePart, NodeKind, SessionNode};
use crate::skills::SkillRegistry;
use crate::stats::{SkillSource, SkillUsage};

pub struct SkillDetector<'a> {
    reg: &'a SkillRegistry,
    obs: Vec<Observation>,
    /// `tool_use_id → skill_id` for `ToolResult` error pairing.
    tool_use_to_skill: HashMap<String, String>,
    /// `skill_id → count` of `is_error` tool results, attributed to the
    /// Assistant-source row of that skill at the end.
    error_counts: HashMap<String, u32>,
}

struct Observation {
    source: SkillSource,
    skill_id: String,
    skill_name: Option<String>,
    node_id: Option<String>,
    timestamp: Option<String>,
}

impl<'a> SkillDetector<'a> {
    pub fn new(reg: &'a SkillRegistry) -> Self {
        Self {
            reg,
            obs: Vec::new(),
            tool_use_to_skill: HashMap::new(),
            error_counts: HashMap::new(),
        }
    }

    /// Record a user-text part. The detector runs the registry match
    /// internally — callers don't need to. No-op when the registry is empty
    /// or the text doesn't match.
    pub fn observe_user_text(
        &mut self,
        node_id: Option<&str>,
        timestamp: Option<&str>,
        text: &str,
    ) {
        if self.reg.is_empty() {
            return;
        }
        let Some(skill) = self.reg.match_text(text) else {
            return;
        };
        self.obs.push(Observation {
            source: SkillSource::User,
            skill_id: skill.id.clone(),
            skill_name: Some(skill.display_name.clone()),
            node_id: node_id.map(String::from),
            timestamp: timestamp.map(String::from),
        });
    }

    /// Record an assistant-side skill tool invocation. `skill_id` is the
    /// resolved id (already extracted from the input); `tool_use_id` allows
    /// later [`Self::observe_tool_result`] calls to pair errors back.
    pub fn observe_assistant_skill_tool(
        &mut self,
        node_id: Option<&str>,
        timestamp: Option<&str>,
        tool_use_id: &str,
        skill_id: &str,
    ) {
        if skill_id.is_empty() {
            return;
        }
        let skill_name = self
            .reg
            .skills()
            .iter()
            .find(|s| s.id == skill_id)
            .map(|s| s.display_name.clone());
        self.tool_use_to_skill
            .insert(tool_use_id.to_string(), skill_id.to_string());
        self.obs.push(Observation {
            source: SkillSource::Assistant,
            skill_id: skill_id.to_string(),
            skill_name,
            node_id: node_id.map(String::from),
            timestamp: timestamp.map(String::from),
        });
    }

    /// Record a tool result. Bumps the error count for the linked skill when
    /// `is_error == true`; otherwise a no-op.
    pub fn observe_tool_result(&mut self, tool_use_id: &str, is_error: bool) {
        if !is_error {
            return;
        }
        if let Some(sid) = self.tool_use_to_skill.get(tool_use_id) {
            *self.error_counts.entry(sid.clone()).or_insert(0) += 1;
        }
    }

    /// Sorted, deduped skill ids encountered across all observations.
    /// Cheap — no aggregation. Use this to populate `SessionSummary.used_skills`.
    pub fn used_skill_ids(&self) -> Vec<String> {
        let set: BTreeSet<&str> = self.obs.iter().map(|o| o.skill_id.as_str()).collect();
        set.into_iter().map(String::from).collect()
    }

    /// Aggregate observations into `SkillUsage` rows keyed by
    /// `(skill_id, source)`. User and Assistant invocations of the same
    /// skill produce two separate rows so the UI can show who triggered it.
    pub fn into_usage_rows(self) -> Vec<SkillUsage> {
        // (skill_id, source) → accumulator
        type Key = (String, SkillSource);
        struct Row {
            skill_name: Option<String>,
            count: u32,
            first_at: Option<String>,
            last_at: Option<String>,
            node_ids: Vec<String>,
        }
        let mut by_key: HashMap<Key, Row> = HashMap::new();
        for o in &self.obs {
            let key = (o.skill_id.clone(), o.source);
            let entry = by_key.entry(key).or_insert_with(|| Row {
                skill_name: o.skill_name.clone(),
                count: 0,
                first_at: None,
                last_at: None,
                node_ids: Vec::new(),
            });
            entry.count += 1;
            if let Some(nid) = &o.node_id {
                entry.node_ids.push(nid.clone());
            }
            if let Some(ts) = &o.timestamp {
                if entry.first_at.is_none() {
                    entry.first_at = Some(ts.clone());
                }
                entry.last_at = Some(ts.clone());
            }
        }
        let mut out: Vec<SkillUsage> = by_key
            .into_iter()
            .map(|((skill_id, source), r)| {
                // Errors only attach to Assistant-source rows (User-source
                // never has a paired tool_result).
                let error_count = if matches!(source, SkillSource::Assistant) {
                    self.error_counts.get(&skill_id).copied().unwrap_or(0)
                } else {
                    0
                };
                SkillUsage {
                    skill_id,
                    skill_name: r.skill_name,
                    source,
                    count: r.count,
                    error_count,
                    first_at: r.first_at,
                    last_at: r.last_at,
                    node_ids: r.node_ids,
                }
            })
            .collect();
        out.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| a.skill_id.cmp(&b.skill_id))
        });
        out
    }
}

/// Walk a list of `SessionNode`s and feed every relevant event into
/// `detector`. Generic across providers — both Claude-Code-shape JSONL and
/// opencode SQLite produce the same `MessagePart` model after parsing.
pub fn walk_session_nodes(nodes: &[SessionNode], detector: &mut SkillDetector<'_>) {
    for node in nodes {
        let ts = node.timestamp.as_deref();
        match node.kind {
            NodeKind::User => {
                if let Some(text) = first_text_part(&node.parts) {
                    detector.observe_user_text(Some(&node.id), ts, text);
                }
            }
            NodeKind::Assistant => {
                for part in &node.parts {
                    if let MessagePart::ToolUse {
                        tool_use_id,
                        name,
                        input,
                        ..
                    } = part
                    {
                        if !is_skill_tool_name(name) {
                            continue;
                        }
                        if let Some(sid) = extract_skill_id_from_input(input) {
                            detector.observe_assistant_skill_tool(
                                Some(&node.id),
                                ts,
                                tool_use_id,
                                &sid,
                            );
                        }
                    }
                    // opencode collapses error-tool-use into a ToolResult on
                    // the same assistant node — Claude-Code shape emits it on
                    // a following user/tool_result node. Either way, observe.
                    if let MessagePart::ToolResult {
                        tool_use_id,
                        is_error,
                        ..
                    } = part
                    {
                        detector.observe_tool_result(tool_use_id, *is_error);
                    }
                }
            }
            NodeKind::ToolResult => {
                for part in &node.parts {
                    if let MessagePart::ToolResult {
                        tool_use_id,
                        is_error,
                        ..
                    } = part
                    {
                        detector.observe_tool_result(tool_use_id, *is_error);
                    }
                }
            }
            _ => {}
        }
    }
}

/// Pick the first non-empty text part. opencode wraps tool-shim user-texts in
/// `MessagePart::Note` so we never accidentally fingerprint those.
pub fn first_text_part(parts: &[MessagePart]) -> Option<&str> {
    parts.iter().find_map(|p| match p {
        MessagePart::Text { text } if !text.trim().is_empty() => Some(text.as_str()),
        _ => None,
    })
}

/// Tool-name comparison for "is this a skill invocation?". Case-insensitive
/// because Claude Code uses `Skill` and opencode uses `skill`.
pub fn is_skill_tool_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("skill")
}

/// Pull the skill id out of a tool_use input JSON string. Accepts:
/// * `{"skill": "..."}` — Claude Code shape
/// * `{"name": "..."}` — opencode shape
///
/// Returns `None` for malformed JSON or empty / missing field.
pub fn extract_skill_id_from_input(input: &str) -> Option<String> {
    let v: Value = serde_json::from_str(input).ok()?;
    for key in ["skill", "name"] {
        if let Some(s) = v.get(key).and_then(Value::as_str) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SessionNode;

    fn user_node(id: &str, ts: Option<&str>, text: &str) -> SessionNode {
        SessionNode {
            id: id.into(),
            parent_id: None,
            kind: NodeKind::User,
            timestamp: ts.map(String::from),
            model: None,
            parts: vec![MessagePart::Text { text: text.into() }],
            usage: None,
            cumulative_context_tokens: None,
            raw_size_bytes: 0,
        }
    }

    fn assistant_skill_use(id: &str, ts: Option<&str>, tool_use_id: &str, input: &str) -> SessionNode {
        SessionNode {
            id: id.into(),
            parent_id: None,
            kind: NodeKind::Assistant,
            timestamp: ts.map(String::from),
            model: None,
            parts: vec![MessagePart::ToolUse {
                tool_use_id: tool_use_id.into(),
                name: "Skill".into(),
                input: input.into(),
                output: None,
            }],
            usage: None,
            cumulative_context_tokens: None,
            raw_size_bytes: 0,
        }
    }

    fn opencode_skill_use(id: &str, tool_use_id: &str, skill_name: &str) -> SessionNode {
        SessionNode {
            id: id.into(),
            parent_id: None,
            kind: NodeKind::Assistant,
            timestamp: None,
            model: None,
            parts: vec![MessagePart::ToolUse {
                tool_use_id: tool_use_id.into(),
                // lowercase — opencode's tool name shape
                name: "skill".into(),
                input: format!("{{\"name\": \"{}\"}}", skill_name),
                output: None,
            }],
            usage: None,
            cumulative_context_tokens: None,
            raw_size_bytes: 0,
        }
    }

    fn tool_result_node(id: &str, tool_use_id: &str, is_error: bool) -> SessionNode {
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
    fn extract_skill_id_handles_both_shapes() {
        assert_eq!(
            extract_skill_id_from_input(r#"{"skill": "foo"}"#),
            Some("foo".into())
        );
        assert_eq!(
            extract_skill_id_from_input(r#"{"name": "bar"}"#),
            Some("bar".into())
        );
        assert_eq!(extract_skill_id_from_input("not json"), None);
        assert_eq!(extract_skill_id_from_input(r#"{"skill": ""}"#), None);
    }

    #[test]
    fn is_skill_tool_name_is_case_insensitive() {
        assert!(is_skill_tool_name("Skill"));
        assert!(is_skill_tool_name("skill"));
        assert!(is_skill_tool_name("SKILL"));
        assert!(!is_skill_tool_name("Read"));
    }

    #[test]
    fn user_text_match_emits_user_row() {
        let reg = SkillRegistry::for_testing(vec![("foo", "Foo Skill", "# Hello world")]);
        let mut det = SkillDetector::new(&reg);
        walk_session_nodes(
            &[user_node("u1", Some("2026-06-15T10:00:00Z"), "# Hello world body")],
            &mut det,
        );
        let rows = det.into_usage_rows();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].skill_id, "foo");
        assert_eq!(rows[0].source, SkillSource::User);
        assert_eq!(rows[0].count, 1);
        assert_eq!(rows[0].error_count, 0);
        assert_eq!(rows[0].node_ids, vec!["u1".to_string()]);
        assert_eq!(rows[0].skill_name.as_deref(), Some("Foo Skill"));
    }

    #[test]
    fn assistant_claude_skill_tool_emits_assistant_row() {
        let reg = SkillRegistry::default();
        let mut det = SkillDetector::new(&reg);
        walk_session_nodes(
            &[
                assistant_skill_use("a1", Some("ts"), "t1", r#"{"skill":"prd"}"#),
                tool_result_node("r1", "t1", true),
            ],
            &mut det,
        );
        let rows = det.into_usage_rows();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].skill_id, "prd");
        assert_eq!(rows[0].source, SkillSource::Assistant);
        assert_eq!(rows[0].error_count, 1);
    }

    #[test]
    fn opencode_skill_tool_emits_assistant_row_via_name_field() {
        let reg = SkillRegistry::default();
        let mut det = SkillDetector::new(&reg);
        walk_session_nodes(&[opencode_skill_use("a1", "call_1", "test-skill")], &mut det);
        let rows = det.into_usage_rows();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].skill_id, "test-skill");
        assert_eq!(rows[0].source, SkillSource::Assistant);
    }

    #[test]
    fn user_and_assistant_same_skill_yield_two_rows() {
        let reg = SkillRegistry::for_testing(vec![("test-skill", "Test", "# test skill")]);
        let mut det = SkillDetector::new(&reg);
        walk_session_nodes(
            &[
                user_node("u1", None, "# test skill body"),
                opencode_skill_use("a1", "call_1", "test-skill"),
            ],
            &mut det,
        );
        let rows = det.into_usage_rows();
        assert_eq!(rows.len(), 2);
        let ids: BTreeSet<&str> = rows.iter().map(|r| r.skill_id.as_str()).collect();
        assert_eq!(ids, BTreeSet::from(["test-skill"]));
        let sources: BTreeSet<SkillSource> = rows.iter().map(|r| r.source).collect();
        assert_eq!(
            sources,
            BTreeSet::from([SkillSource::User, SkillSource::Assistant])
        );
    }

    #[test]
    fn used_skill_ids_dedups_across_sources() {
        let reg = SkillRegistry::for_testing(vec![("foo", "Foo", "# Foo body")]);
        let mut det = SkillDetector::new(&reg);
        walk_session_nodes(
            &[
                user_node("u1", None, "# Foo body and more"),
                assistant_skill_use("a1", None, "t1", r#"{"skill":"foo"}"#),
            ],
            &mut det,
        );
        assert_eq!(det.used_skill_ids(), vec!["foo".to_string()]);
    }

    #[test]
    fn empty_registry_still_catches_assistant_tool_calls() {
        // The whole point: assistant-side detection doesn't depend on the
        // disk registry, so we should still get rows even when no SKILL.md
        // is on disk.
        let reg = SkillRegistry::default();
        let mut det = SkillDetector::new(&reg);
        walk_session_nodes(
            &[assistant_skill_use("a1", None, "t1", r#"{"skill":"foo"}"#)],
            &mut det,
        );
        assert_eq!(det.into_usage_rows().len(), 1);
    }

    /// Regression: opencode used to fold tool stdout into the same `input`
    /// string as the JSON args, which broke `extract_skill_id_from_input`'s
    /// `serde_json::from_str(input)` and silently dropped every successful
    /// assistant-side skill invocation. The fix moved stdout onto a dedicated
    /// `output` field, so `input` is once again pure JSON. This test pins
    /// that invariant: the detector must still pick up the call (and record
    /// the node id, so the per-node chip renders) when `output` is populated.
    #[test]
    fn assistant_skill_tool_with_output_still_detected() {
        let reg = SkillRegistry::default();
        let mut det = SkillDetector::new(&reg);
        let node = SessionNode {
            id: "a1".into(),
            parent_id: None,
            kind: NodeKind::Assistant,
            timestamp: None,
            model: None,
            parts: vec![MessagePart::ToolUse {
                tool_use_id: "call_1".into(),
                name: "skill".into(),
                input: r#"{"name": "test-skill"}"#.into(),
                output: Some("ok — tool finished".into()),
            }],
            usage: None,
            cumulative_context_tokens: None,
            raw_size_bytes: 0,
        };
        walk_session_nodes(&[node], &mut det);
        let rows = det.into_usage_rows();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].skill_id, "test-skill");
        assert_eq!(rows[0].node_ids, vec!["a1".to_string()]);
    }
}
