//! Shared parser for the Claude-Code-shape JSONL session format.
//!
//! Multiple providers ship the exact same on-disk layout — one `.jsonl`
//! file per session under `<root>/<encoded-cwd>/<sessionId>.jsonl`, each
//! line a JSON record keyed by `type` (user / assistant / system / …).
//! Sub-agents live alongside as `<sessionId>/subagents/agent-<id>.jsonl`
//! plus a sibling `agent-<id>.meta.json`.
//!
//! `parse_session_file` and `scan_summary` take the calling provider's id
//! as a parameter so the resulting [`SessionSummary`] is tagged correctly.
//! Anything that needs to dispatch on `summary.provider_id` downstream
//! (skill stats, the UI's per-provider rendering tweaks) sees the right
//! string without the parser knowing or caring.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use log::{debug, warn};
use serde_json::Value;

use crate::model::{
    MessagePart, NodeKind, SessionDetail, SessionNode, SessionSummary, SubAgentKind,
    SubAgentSession, TokenUsage,
};
use crate::stats::SkillUsage;

// ============================================================================
//  Public entry points (called by provider shells)
// ============================================================================

/// Walk `<root>/<project>/*.jsonl` and produce a summary per session,
/// newest first. Tags each summary with the given `provider_id`.
pub fn list_sessions(root: &Path, provider_id: &str) -> Result<Vec<SessionSummary>> {
    if !root.exists() {
        debug!("list_sessions: root {:?} does not exist", root);
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for project_entry in fs::read_dir(root).context("read jsonl projects root")? {
        let project_entry = match project_entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let project_path = project_entry.path();
        if !project_path.is_dir() {
            continue;
        }
        for f in fs::read_dir(&project_path).into_iter().flatten().flatten() {
            let p = f.path();
            if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            match scan_summary(&p, provider_id) {
                Ok(summary) => out.push(summary),
                Err(e) => warn!("scan_summary skipped {:?}: {}", p, e),
            }
        }
    }
    debug!("list_sessions root={:?} => {} sessions", root, out.len());
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

/// Parse one session file plus its sub-agents into a full SessionDetail.
pub fn load_session(source_path: &Path, provider_id: &str) -> Result<SessionDetail> {
    debug!("load_session source_path={:?}", source_path);
    let (summary, nodes) = parse_session_file(source_path, provider_id)?;
    let subagents = load_subagents(source_path, provider_id).unwrap_or_else(|e| {
        warn!("load_subagents failed for {:?}: {}", source_path, e);
        Vec::new()
    });
    let mut detail = SessionDetail {
        summary,
        nodes,
        subagents,
        tps_session: None,
        tps_per_agent: HashMap::new(),
    };
    detail.tps_session = crate::tps::compute_session_tps(&detail);
    detail.tps_per_agent = crate::tps::compute_per_agent_tps(&detail);
    Ok(detail)
}

/// Skill-usage extraction for any provider that emits structured
/// `name == "Skill"` tool_use records (claude-code, code-agent-3x).
/// See `core/src/stats.rs` module docs for the design rationale.
pub fn collect_skill_usage(detail: &SessionDetail) -> Vec<SkillUsage> {
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

// ============================================================================
//  Internal: parse_session_file / scan_summary (verbatim from claude_code.rs
//  with provider_id parameterized)
// ============================================================================

fn parse_session_file(path: &Path, provider_id: &str) -> Result<(SessionSummary, Vec<SessionNode>)> {
    let f = File::open(path).with_context(|| format!("open session file {:?}", path))?;
    let reader = BufReader::new(f);

    let mut summary = SessionSummary {
        provider_id: provider_id.to_string(),
        session_id: path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string(),
        title: None,
        cwd: None,
        git_branch: None,
        started_at: None,
        ended_at: None,
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        peak_context_tokens: 0,
        source_path: path.to_string_lossy().into_owned(),
    };

    let mut nodes: Vec<SessionNode> = Vec::new();
    let mut peak_context: u64 = 0;
    let mut last_branch: Option<String> = None;

    // For TPS we want a "duration" per assistant turn. claude-code persists
    // each content block of a turn as its own JSONL record (sharing the same
    // `message.id` and the *same* `usage` payload), so we:
    //   - capture the timestamp of the previous event the first time we see
    //     a given message id  → that's the start of this turn,
    //   - keep tracking the latest record-index for that message id,
    //   - after parsing, fill `generation_duration_ms` only on the LAST
    //     record for each message id (earlier records of the same turn keep
    //     `None` and are naturally excluded from TPS by the qualifier).
    //
    // The result is "turn duration including TTFT / API queue" — biased low
    // vs the model's true streaming rate, but consistent enough across turns
    // that the relative numbers within a session stay meaningful. See the
    // docstring on `TokenUsage::generation_duration_ms` for the full story.
    let mut prev_event_ts: Option<String> = None;
    let mut msg_id_first_prev_ts: HashMap<String, Option<String>> = HashMap::new();
    let mut msg_id_last_node_idx: HashMap<String, usize> = HashMap::new();

    for (lineno, line) in reader.lines().enumerate() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                log::trace!("io error reading {:?} line {}: {}", path, lineno, e);
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let raw_size = line.len() as u64;
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                log::trace!("malformed JSON in {:?} line {}: {}", path, lineno, e);
                continue; // skip malformed lines without aborting
            }
        };

        let rec_type = v.get("type").and_then(Value::as_str).unwrap_or("");

        let ts = v.get("timestamp").and_then(Value::as_str).map(str::to_string);
        let uuid = v
            .get("uuid")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("line-{}", lineno));
        let parent = v
            .get("parentUuid")
            .and_then(Value::as_str)
            .map(str::to_string);
        let is_sidechain = v
            .get("isSidechain")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        if let Some(c) = v.get("cwd").and_then(Value::as_str) {
            if summary.cwd.is_none() {
                summary.cwd = Some(c.to_string());
            }
        }
        if let Some(b) = v.get("gitBranch").and_then(Value::as_str) {
            last_branch = Some(b.to_string());
        }
        if summary.started_at.is_none() {
            if let Some(t) = ts.as_ref() {
                summary.started_at = Some(t.clone());
            }
        }
        if let Some(t) = ts.as_ref() {
            summary.ended_at = Some(t.clone());
        }

        match rec_type {
            "ai-title" => {
                summary.title = v
                    .get("aiTitle")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            "user" => {
                let parts = parse_message_content(v.get("message").and_then(|m| m.get("content")));
                let kind = if is_sidechain {
                    NodeKind::Sidechain
                } else if parts
                    .iter()
                    .any(|p| matches!(p, MessagePart::ToolResult { .. }))
                {
                    NodeKind::ToolResult
                } else {
                    NodeKind::User
                };
                nodes.push(SessionNode {
                    id: uuid,
                    parent_id: parent,
                    kind,
                    timestamp: ts.clone(),
                    model: None,
                    parts,
                    usage: None,
                    cumulative_context_tokens: Some(peak_context),
                    raw_size_bytes: raw_size,
                });
                summary.message_count += 1;
            }
            "assistant" => {
                let msg = v.get("message").cloned().unwrap_or(Value::Null);
                let model = msg
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let msg_id = msg
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let parts = parse_message_content(msg.get("content"));
                let usage = msg.get("usage").and_then(|u| parse_usage(u));
                if let Some(u) = &usage {
                    summary.total_input_tokens += u.input_tokens;
                    summary.total_output_tokens += u.output_tokens;
                    let ctx = u.context_window();
                    if ctx > peak_context {
                        peak_context = ctx;
                    }
                }
                // Snapshot the pre-this-turn timestamp the first time we see
                // this msg_id. Multi-block records reuse the same starting
                // point — the duration spans the whole turn, not block-to-block.
                if let Some(mid) = msg_id.as_ref() {
                    msg_id_first_prev_ts
                        .entry(mid.clone())
                        .or_insert_with(|| prev_event_ts.clone());
                    msg_id_last_node_idx.insert(mid.clone(), nodes.len());
                }
                nodes.push(SessionNode {
                    id: uuid,
                    parent_id: parent,
                    kind: if is_sidechain {
                        NodeKind::Sidechain
                    } else {
                        NodeKind::Assistant
                    },
                    timestamp: ts.clone(),
                    model,
                    parts,
                    usage,
                    cumulative_context_tokens: Some(peak_context),
                    raw_size_bytes: raw_size,
                });
                summary.message_count += 1;
            }
            "system" => {
                let subtype = v
                    .get("subtype")
                    .and_then(Value::as_str)
                    .unwrap_or("system");
                let mut text = format!("[{}]", subtype);
                if let Some(d) = v.get("durationMs").and_then(Value::as_u64) {
                    text.push_str(&format!(" duration={}ms", d));
                }
                if let Some(c) = v.get("messageCount").and_then(Value::as_u64) {
                    text.push_str(&format!(" msgs={}", c));
                }
                if let Some(c) = v.get("content").and_then(Value::as_str) {
                    text.push_str(" ");
                    text.push_str(c);
                }
                nodes.push(SessionNode {
                    id: uuid,
                    parent_id: parent,
                    kind: NodeKind::System,
                    timestamp: ts.clone(),
                    model: None,
                    parts: vec![MessagePart::Note { text }],
                    usage: None,
                    cumulative_context_tokens: Some(peak_context),
                    raw_size_bytes: raw_size,
                });
            }
            "attachment" => {
                let att = v.get("attachment").cloned().unwrap_or(Value::Null);
                let path_s = att
                    .get("path")
                    .or_else(|| att.get("displayPath"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let mime = att.get("type").and_then(Value::as_str).map(str::to_string);
                nodes.push(SessionNode {
                    id: uuid,
                    parent_id: parent,
                    kind: NodeKind::Meta,
                    timestamp: ts.clone(),
                    model: None,
                    parts: vec![MessagePart::Attachment { path: path_s, mime }],
                    usage: None,
                    cumulative_context_tokens: Some(peak_context),
                    raw_size_bytes: raw_size,
                });
            }
            _ => {
                // skip pure-metadata events
            }
        }

        // Update the running "previous event timestamp" used to bracket the
        // start of the next assistant turn. We update *after* the match so
        // the first record of any new msg_id captures the prior line's ts,
        // not its own.
        if let Some(t) = ts {
            prev_event_ts = Some(t);
        }
    }

    // Backfill generation_duration_ms on the last record of each msg_id.
    // For multi-block turns, only the final block carries the duration so
    // that the TPS qualifier counts each turn exactly once. Earlier records
    // of the same turn keep generation_duration_ms = None.
    for (mid, idx) in &msg_id_last_node_idx {
        let last_ts = nodes.get(*idx).and_then(|n| n.timestamp.clone());
        let prev_ts = msg_id_first_prev_ts.get(mid).cloned().flatten();
        let (Some(last_ts), Some(prev_ts)) = (last_ts, prev_ts) else { continue };
        let Some(dur_ms) = duration_ms_iso(&prev_ts, &last_ts) else { continue };
        if let Some(node) = nodes.get_mut(*idx) {
            if let Some(u) = node.usage.as_mut() {
                u.generation_duration_ms = Some(dur_ms);
            }
        }
    }

    summary.peak_context_tokens = peak_context;
    summary.git_branch = last_branch;

    if summary.title.is_none() {
        if let Some(node) = nodes.iter().find(|n| {
            matches!(n.kind, NodeKind::User | NodeKind::Sidechain)
        }) {
            if let Some(MessagePart::Text { text }) = node.parts.first() {
                let mut s: String = text.chars().take(80).collect();
                if text.chars().count() > 80 {
                    s.push('…');
                }
                summary.title = Some(s);
            }
        }
    }

    Ok((summary, nodes))
}

/// Walk `<parent_stem>/subagents/agent-*.jsonl` and pair each with its
/// sibling `agent-*.meta.json` (carrying agentType/description/toolUseId).
///
/// Three on-disk filename shapes are produced by Claude Code:
///   - `agent-<hex16>.jsonl`                   → real sub-agent (Task tool)
///   - `agent-aside_question-<hex>.jsonl`      → `/aside` mirror
///   - `agent-acompact-<hex>.jsonl`            → auto-compact pre-snapshot
///
/// We extract the `<NAME>` segment when present and use it both as the
/// `agent_type` (when meta.json is missing — the special files don't get one)
/// and as a way to drop the acompact snapshots, which aren't sub-agents.
fn load_subagents(parent: &Path, provider_id: &str) -> Result<Vec<SubAgentSession>> {
    let stem = parent
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow!("parent path has no file stem"))?;
    let dir = parent
        .parent()
        .ok_or_else(|| anyhow!("parent path has no parent dir"))?
        .join(stem)
        .join("subagents");
    if !dir.exists() {
        return Ok(Vec::new());
    }

    struct Entry {
        jsonl: PathBuf,
        meta: PathBuf,
        agent_id: String,
        /// agentType extracted from the filename, if any (e.g. "aside_question").
        /// `None` for the bare `agent-<hex>.jsonl` shape.
        filename_type: Option<String>,
    }

    let mut entries: Vec<Entry> = Vec::new();
    for entry in fs::read_dir(&dir).with_context(|| format!("read subagents dir {:?}", dir))? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let p = entry.path();
        let fname = match p.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if !fname.starts_with("agent-") || !fname.ends_with(".jsonl") {
            continue;
        }
        let body = &fname["agent-".len()..fname.len() - ".jsonl".len()];

        // Filename shapes: `<hex16>` or `<NAME>-<HEX>` where NAME contains a-z/_.
        // Only treat the first dash as a type separator if the prefix isn't itself
        // a hex-only id — that lets us spot "aside_question", "acompact", etc.
        // without misclassifying ids that just happen to start with hex digits.
        let (filename_type, agent_id) = match body.find('-') {
            Some(idx) => {
                let head = &body[..idx];
                if !head.is_empty() && head.chars().all(|c| c.is_ascii_alphabetic() || c == '_') {
                    (Some(head.to_string()), body.to_string())
                } else {
                    (None, body.to_string())
                }
            }
            None => (None, body.to_string()),
        };

        // Auto-compact snapshots aren't sub-agents — skip them. The parent
        // jsonl has the actual conversation; the snapshot only duplicates it.
        if filename_type.as_deref() == Some("acompact") {
            log::debug!("skipping acompact snapshot {:?}", p);
            continue;
        }

        let meta = p.with_extension("meta.json");
        entries.push(Entry {
            jsonl: p,
            meta,
            agent_id,
            filename_type,
        });
    }

    // Stable order — sort by file path so the type-ordinal is reproducible.
    entries.sort_by(|a, b| a.jsonl.cmp(&b.jsonl));

    let mut type_counters: HashMap<String, u32> = HashMap::new();
    let mut out = Vec::with_capacity(entries.len());

    for e in entries {
        let (mut summary, nodes) = match parse_session_file(&e.jsonl, provider_id) {
            Ok(x) => x,
            Err(err) => {
                warn!("subagent parse failed for {:?}: {}", e.jsonl, err);
                continue;
            }
        };
        summary.session_id = e.agent_id.clone();

        // meta.json is only emitted for normal sub-agents. aside_question /
        // acompact files don't have one, so we fall back to the filename type.
        let (meta_type, description, parent_tool_use_id) = read_meta(&e.meta);
        let agent_type = meta_type
            .or_else(|| e.filename_type.clone())
            .unwrap_or_else(|| "subagent".to_string());

        let kind = match agent_type.as_str() {
            // Filename-derived special types. `Compact` shouldn't reach here
            // (filtered above) but we keep it for forward compatibility.
            "aside_question" => SubAgentKind::AsideQuestion,
            "acompact" => SubAgentKind::Compact,
            _ => SubAgentKind::Normal,
        };

        let counter = type_counters.entry(agent_type.clone()).or_insert(0);
        *counter += 1;
        let type_ordinal = *counter;

        if let Some(desc) = description.as_ref() {
            if !desc.is_empty() {
                summary.title = Some(desc.clone());
            }
        }

        out.push(SubAgentSession {
            agent_id: e.agent_id,
            agent_type,
            kind,
            type_ordinal,
            description,
            parent_tool_use_id,
            summary,
            nodes,
        });
    }

    Ok(out)
}

/// Difference between two RFC 3339 / ISO-8601 timestamps in milliseconds.
/// Returns `None` if either value can't be parsed or if `b` precedes `a`.
fn duration_ms_iso(a: &str, b: &str) -> Option<u64> {
    use chrono::DateTime;
    let ta = DateTime::parse_from_rfc3339(a).ok()?;
    let tb = DateTime::parse_from_rfc3339(b).ok()?;
    let diff = tb.timestamp_millis().checked_sub(ta.timestamp_millis())?;
    if diff < 0 {
        None
    } else {
        Some(diff as u64)
    }
}

fn read_meta(meta_path: &Path) -> (Option<String>, Option<String>, Option<String>) {
    let raw = match fs::read_to_string(meta_path) {
        Ok(s) => s,
        Err(_) => return (None, None, None),
    };
    let v: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return (None, None, None),
    };
    let agent_type = v
        .get("agentType")
        .and_then(Value::as_str)
        .map(str::to_string);
    let description = v
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_string);
    let tool_use_id = v
        .get("toolUseId")
        .and_then(Value::as_str)
        .map(str::to_string);
    (agent_type, description, tool_use_id)
}

fn parse_usage(u: &Value) -> Option<TokenUsage> {
    Some(TokenUsage {
        input_tokens: u.get("input_tokens").and_then(Value::as_u64).unwrap_or(0),
        output_tokens: u.get("output_tokens").and_then(Value::as_u64).unwrap_or(0),
        cache_creation_input_tokens: u
            .get("cache_creation_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_read_input_tokens: u
            .get("cache_read_input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        service_tier: u
            .get("service_tier")
            .and_then(Value::as_str)
            .map(str::to_string),
        // Filled later in parse_session_file once we know the prev-event ts.
        generation_duration_ms: None,
    })
}

fn parse_message_content(content: Option<&Value>) -> Vec<MessagePart> {
    let Some(content) = content else {
        return Vec::new();
    };
    match content {
        // user: {"content": "plain string"}
        Value::String(s) => vec![MessagePart::Text { text: s.clone() }],
        // assistant / new-style user: {"content": [block, block, ...]}
        Value::Array(items) => items.iter().filter_map(parse_block).collect(),
        _ => Vec::new(),
    }
}

fn parse_block(b: &Value) -> Option<MessagePart> {
    let kind = b.get("type").and_then(Value::as_str)?;
    match kind {
        "text" => Some(MessagePart::Text {
            text: b
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        }),
        "thinking" => Some(MessagePart::Thinking {
            text: b
                .get("thinking")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        }),
        "tool_use" => {
            let id = b
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let name = b
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let input = b
                .get("input")
                .map(|v| serde_json::to_string_pretty(v).unwrap_or_default())
                .unwrap_or_default();
            Some(MessagePart::ToolUse {
                tool_use_id: id,
                name,
                input,
            })
        }
        "tool_result" => {
            let id = b
                .get("tool_use_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let is_error = b
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let content = match b.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(arr)) => arr
                    .iter()
                    .map(|v| match v.get("type").and_then(Value::as_str) {
                        Some("text") => v
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        _ => serde_json::to_string(v).unwrap_or_default(),
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                Some(other) => serde_json::to_string(other).unwrap_or_default(),
                None => String::new(),
            };
            Some(MessagePart::ToolResult {
                tool_use_id: id,
                content,
                is_error,
            })
        }
        "image" => {
            let media_type = b
                .get("source")
                .and_then(|s| s.get("media_type"))
                .and_then(Value::as_str)
                .unwrap_or("image/*")
                .to_string();
            let bytes = b
                .get("source")
                .and_then(|s| s.get("data"))
                .and_then(Value::as_str)
                .map(|d| d.len() as u64)
                .unwrap_or(0);
            Some(MessagePart::Image { media_type, bytes })
        }
        _ => Some(MessagePart::Note {
            text: format!("[unknown block type: {}]", kind),
        }),
    }
}

fn scan_summary(p: &Path, provider_id: &str) -> Result<SessionSummary> {
    // Cheap pass: only inspect a few fields so listing many sessions stays fast.
    let f = File::open(p).with_context(|| format!("open {:?}", p))?;
    let reader = BufReader::new(f);

    let mut summary = SessionSummary {
        provider_id: provider_id.into(),
        session_id: p
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .into(),
        title: None,
        cwd: None,
        git_branch: None,
        started_at: None,
        ended_at: None,
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        peak_context_tokens: 0,
        source_path: p.to_string_lossy().into_owned(),
    };
    let mut peak: u64 = 0;
    let mut first_user_text: Option<String> = None;

    for line in reader.lines().flatten() {
        if line.trim().is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(c) = v.get("cwd").and_then(Value::as_str) {
            if summary.cwd.is_none() {
                summary.cwd = Some(c.to_string());
            }
        }
        if let Some(b) = v.get("gitBranch").and_then(Value::as_str) {
            summary.git_branch = Some(b.to_string());
        }
        if let Some(t) = v.get("timestamp").and_then(Value::as_str) {
            if summary.started_at.is_none() {
                summary.started_at = Some(t.to_string());
            }
            summary.ended_at = Some(t.to_string());
        }
        match v.get("type").and_then(Value::as_str) {
            Some("ai-title") => {
                summary.title = v.get("aiTitle").and_then(Value::as_str).map(String::from);
            }
            Some("user") => {
                summary.message_count += 1;
                if first_user_text.is_none() {
                    if let Some(c) = v
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(Value::as_str)
                    {
                        first_user_text = Some(c.to_string());
                    }
                }
            }
            Some("assistant") => {
                summary.message_count += 1;
                if let Some(u) = v
                    .get("message")
                    .and_then(|m| m.get("usage"))
                {
                    let usage = parse_usage(u).unwrap_or_default();
                    summary.total_input_tokens += usage.input_tokens;
                    summary.total_output_tokens += usage.output_tokens;
                    let ctx = usage.context_window();
                    if ctx > peak {
                        peak = ctx;
                    }
                }
            }
            _ => {}
        }
    }
    summary.peak_context_tokens = peak;
    if summary.title.is_none() {
        if let Some(t) = first_user_text {
            let mut s: String = t.chars().take(80).collect();
            if t.chars().count() > 80 {
                s.push('…');
            }
            summary.title = Some(s);
        }
    }
    if summary.title.is_none() {
        return Err(anyhow!("session has no recognisable content"));
    }
    Ok(summary)
}

// ============================================================================
//  Internal: skill_usage scanner (moved from stats.rs)
// ============================================================================

/// Mutable accumulator while we're scanning nodes. Becomes a `SkillUsage`
/// at the end. Splitting it out keeps the merge step a plain map walk.
#[derive(Default)]
struct Acc {
    count: u32,
    error_count: u32,
    first_at: Option<String>,
    last_at: Option<String>,
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
