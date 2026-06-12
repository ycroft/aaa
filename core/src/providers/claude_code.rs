//! Claude Code provider — reads `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
//!
//! Each line is a JSON record with a top-level `type` field. We translate
//! the relevant ones into our unified [`SessionNode`] model.

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
use crate::providers::SessionProvider;

pub struct ClaudeCodeProvider;

impl SessionProvider for ClaudeCodeProvider {
    fn id(&self) -> &str {
        "claude-code"
    }
    fn display_name(&self) -> &str {
        "Claude Code"
    }
    fn default_root(&self) -> Option<PathBuf> {
        dirs::home_dir().map(|h| h.join(".claude").join("projects"))
    }

    fn remote_root_candidates(&self) -> Vec<&'static str> {
        vec!["{home}/.claude/projects"]
    }

    fn list_sessions(&self, root: &PathBuf) -> Result<Vec<SessionSummary>> {
        if !root.exists() {
            debug!("list_sessions: root {:?} does not exist", root);
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        // Layout: <root>/<encoded-project-dir>/<sessionId>.jsonl
        for project_entry in fs::read_dir(root).context("read claude projects root")? {
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
                match scan_summary(&p) {
                    Ok(summary) => out.push(summary),
                    Err(e) => warn!("scan_summary skipped {:?}: {}", p, e),
                }
            }
        }
        debug!("list_sessions root={:?} => {} sessions", root, out.len());
        // Newest first.
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(out)
    }

    fn load_session(&self, source_path: &PathBuf) -> Result<SessionDetail> {
        debug!("load_session source_path={:?}", source_path);
        let (summary, nodes) = parse_session_file(source_path)?;

        // Sub-agents live alongside the parent jsonl as
        //   <stem>/subagents/agent-<id>.jsonl  + agent-<id>.meta.json
        // The harness writes meta.json with {agentType, description, toolUseId};
        // toolUseId is the parent's `Agent` tool_use, which lets the UI link
        // the parent timeline to the sub-agent.
        //
        // TODO(nested-subagents): currently we only walk one level. If the
        // harness ever writes nested `subagents/` dirs (a sub-agent spawning
        // its own sub-agent), we'd need to recurse here and on the UI side.
        let subagents = load_subagents(source_path).unwrap_or_else(|e| {
            warn!("load_subagents failed for {:?}: {}", source_path, e);
            Vec::new()
        });

        Ok(SessionDetail {
            summary,
            nodes,
            subagents,
        })
    }
}

/// Parse a single Claude Code jsonl file into (summary, nodes).
/// Used both for the main session and for each sub-agent file.
fn parse_session_file(path: &Path) -> Result<(SessionSummary, Vec<SessionNode>)> {
    let f = File::open(path).with_context(|| format!("open session file {:?}", path))?;
    let reader = BufReader::new(f);

    let mut summary = SessionSummary {
        provider_id: "claude-code".to_string(),
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
                    timestamp: ts,
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
                nodes.push(SessionNode {
                    id: uuid,
                    parent_id: parent,
                    kind: if is_sidechain {
                        NodeKind::Sidechain
                    } else {
                        NodeKind::Assistant
                    },
                    timestamp: ts,
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
                    timestamp: ts,
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
                    timestamp: ts,
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
fn load_subagents(parent: &Path) -> Result<Vec<SubAgentSession>> {
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

    let mut type_counters: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();
    let mut out = Vec::with_capacity(entries.len());

    for e in entries {
        let (mut summary, nodes) = match parse_session_file(&e.jsonl) {
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

fn scan_summary(p: &Path) -> Result<SessionSummary> {
    // Cheap pass: only inspect a few fields so listing many sessions stays fast.
    let f = File::open(p).with_context(|| format!("open {:?}", p))?;
    let reader = BufReader::new(f);

    let mut summary = SessionSummary {
        provider_id: "claude-code".into(),
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
