//! Unified session-export bundle builder.
//!
//! Input: a list of (provider_id, source_path) pairs. Output: a directory
//! layout containing manifest.json + index.jsonl + analysis-guide.md and a
//! sessions/<id>/ subdir per session with events.jsonl + transcript.md +
//! raw.json. Same code path serves the toolbar export button and the
//! AI-analysis dialog — single = N=1, all = N=K.

use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportScope {
    Single,
    All,
}

#[derive(Debug, Clone)]
pub struct BundleInputs {
    pub provider_id: String,
    pub source_paths: Vec<PathBuf>,
    pub root: Option<PathBuf>,
    pub scope: ExportScope,
}

#[derive(Debug, Clone)]
pub struct BundlePaths {
    pub bundle_dir: PathBuf,
    pub session_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManifestSkill {
    pub id: String,
    pub display_name: String,
    pub source_path: String,
    pub fingerprint_first_128b: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Manifest {
    pub aaa_version: String,
    pub schema_version: u32,
    pub provider: String,
    pub root: Option<String>,
    pub export_ts: String,
    pub scope: &'static str,
    pub session_count: usize,
    pub known_skills: Vec<ManifestSkill>,
}

pub const BUNDLE_SCHEMA_VERSION: u32 = 1;

pub fn build_bundle(inputs: &BundleInputs, target_dir: &Path) -> anyhow::Result<BundlePaths> {
    let ts = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let dir_name = match inputs.scope {
        ExportScope::Single => format!(
            "aaa-export-{}-{}-{}",
            inputs.provider_id,
            inputs
                .source_paths
                .first()
                .and_then(|p| p.file_stem().and_then(|s| s.to_str()))
                .map(|s| &s[..s.len().min(16)])
                .unwrap_or("session"),
            ts
        ),
        ExportScope::All => format!("aaa-export-{}-all-{}", inputs.provider_id, ts),
    };
    let bundle_dir = target_dir.join(&dir_name);
    fs::create_dir_all(bundle_dir.join("sessions"))?;

    let provider = crate::providers::find(&inputs.provider_id)
        .ok_or_else(|| anyhow::anyhow!("unknown provider: {}", inputs.provider_id))?;

    let mut index_file = fs::File::create(bundle_dir.join("index.jsonl"))?;
    let sessions_dir = bundle_dir.join("sessions");
    let mut session_anomalies: Vec<(String, Vec<String>)> = Vec::new();
    // Collect cwds across sessions so the manifest's known_skills inventory
    // includes project-level SKILL.md (e.g. opencode's <cwd>/.opencode/skills),
    // not just the global roots from skill_roots(None).
    let mut seen_cwds: BTreeSet<PathBuf> = BTreeSet::new();

    for src in &inputs.source_paths {
        let detail = provider.load_session(src)?;
        if let Some(c) = detail.summary.cwd.as_deref() {
            seen_cwds.insert(PathBuf::from(c));
        }
        let sid = detail.summary.session_id.clone();
        let session_subdir = sessions_dir.join(&sid);
        fs::create_dir_all(&session_subdir)?;
        let row = build_index_row(&detail, &sid);
        session_anomalies.push((sid.clone(), row.anomalies.clone()));
        writeln!(index_file, "{}", serde_json::to_string(&row)?)?;
        // events.jsonl
        let mut events_file = fs::File::create(session_subdir.join("events.jsonl"))?;
        write_events_jsonl(&detail, &mut events_file)?;
        // transcript.md
        let mut transcript_file = fs::File::create(session_subdir.join("transcript.md"))?;
        write_transcript_md(&detail, &mut transcript_file)?;
        // raw.json — fidelity escape hatch.
        fs::write(
            session_subdir.join("raw.json"),
            serde_json::to_string_pretty(&detail)?,
        )?;
    }

    // Manifest is written *after* the session loop so known_skills can include
    // the union of project-level skill roots (one per session cwd) plus the
    // global roots from skill_roots(None).
    let manifest = Manifest {
        aaa_version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: BUNDLE_SCHEMA_VERSION,
        provider: inputs.provider_id.clone(),
        root: inputs.root.as_ref().map(|p| p.to_string_lossy().into_owned()),
        export_ts: ts,
        scope: match inputs.scope {
            ExportScope::Single => "single",
            ExportScope::All => "all",
        },
        session_count: inputs.source_paths.len(),
        known_skills: collect_known_skills(&inputs.provider_id, &seen_cwds),
    };
    fs::write(
        bundle_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;

    fs::write(bundle_dir.join("analysis-guide.md"), render_analysis_guide(&manifest, &session_anomalies))?;

    Ok(BundlePaths {
        bundle_dir,
        session_count: inputs.source_paths.len(),
    })
}

fn collect_known_skills(provider_id: &str, cwds: &BTreeSet<PathBuf>) -> Vec<ManifestSkill> {
    let Some(provider) = crate::providers::find(provider_id) else {
        return Vec::new();
    };
    // Union of (global roots) ∪ (per-cwd roots), de-duped by path.
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for r in provider.skill_roots(None) {
        if seen.insert(r.clone()) {
            roots.push(r);
        }
    }
    for cwd in cwds {
        for r in provider.skill_roots(Some(cwd)) {
            if seen.insert(r.clone()) {
                roots.push(r);
            }
        }
    }
    let reg = crate::skills::SkillRegistry::build(&roots);
    reg.skills()
        .iter()
        .map(|s| ManifestSkill {
            id: s.id.clone(),
            display_name: s.display_name.clone(),
            source_path: s.source_path.to_string_lossy().into_owned(),
            fingerprint_first_128b: s.fingerprint.clone(),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexRow {
    pub session_id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub branch: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub total_turns: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub peak_ctx_tokens: u64,
    pub used_skills: Vec<String>,
    pub skill_invocations: u32,
    pub tool_calls: u32,
    pub tool_errors: u32,
    pub anomalies: Vec<String>,
    pub files: IndexFiles,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexFiles {
    pub events: String,
    pub transcript: String,
    pub raw: String,
}

fn build_index_row(detail: &crate::model::SessionDetail, sid: &str) -> IndexRow {
    let s = &detail.summary;
    let mut tool_calls: u32 = 0;
    let mut tool_errors: u32 = 0;
    for n in &detail.nodes {
        for p in &n.parts {
            match p {
                crate::model::MessagePart::ToolUse { .. } => tool_calls += 1,
                crate::model::MessagePart::ToolResult { is_error: true, .. } => tool_errors += 1,
                _ => {}
            }
        }
    }
    let skill_rows = crate::stats::skill_usage(detail);
    let skill_invocations: u32 = skill_rows.iter().map(|r| r.count).sum();
    let anomalies = detect_anomalies(detail);
    IndexRow {
        session_id: sid.to_string(),
        title: s.title.clone(),
        cwd: s.cwd.clone(),
        branch: s.git_branch.clone(),
        started_at: s.started_at.clone(),
        ended_at: s.ended_at.clone(),
        total_turns: s.message_count,
        input_tokens: s.total_input_tokens,
        output_tokens: s.total_output_tokens,
        peak_ctx_tokens: s.peak_context_tokens,
        used_skills: s.used_skills.clone(),
        skill_invocations,
        tool_calls,
        tool_errors,
        anomalies,
        files: IndexFiles {
            events: format!("sessions/{}/events.jsonl", sid),
            transcript: format!("sessions/{}/transcript.md", sid),
            raw: format!("sessions/{}/raw.json", sid),
        },
    }
}

fn detect_anomalies(detail: &crate::model::SessionDetail) -> Vec<String> {
    let mut out = Vec::new();
    let mut prev_ctx: Option<u64> = None;
    let mut retry_count = 0u32;
    let mut last_seen: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();
    for n in &detail.nodes {
        if let Some(curr) = n.cumulative_context_tokens {
            if let Some(prev) = prev_ctx {
                if prev > 0 && curr > prev {
                    let pct = (curr - prev) as f64 / prev as f64;
                    if pct >= 0.30 {
                        out.push(format!("ctx_jump@{}", n.id));
                    }
                }
            }
            prev_ctx = Some(curr);
        }
        for p in &n.parts {
            if let crate::model::MessagePart::ToolUse { name, input, .. } = p {
                let key = (name.clone(), input.clone());
                if last_seen.contains_key(&key) {
                    retry_count += 1;
                    if retry_count >= 4 {
                        out.push(format!("tool_retry_loop@{}", n.id));
                        retry_count = 0;
                    }
                } else {
                    retry_count = 0;
                    last_seen.insert(key, n.id.clone());
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct EventRow {
    pub i: u32,
    pub id: String,
    pub ts: Option<String>,
    pub kind: String,
    pub model: Option<String>,
    pub tool: Option<String>,
    pub tool_input_brief: Option<String>,
    pub ctx_after: Option<u64>,
    pub ctx_jump_pct: Option<f64>,
    pub tok_in: Option<u64>,
    pub tok_out: Option<u64>,
    pub dur_ms: Option<u64>,
    pub skill_id: Option<String>,
    pub is_error: bool,
    pub retry_of: Option<String>,
    pub text_brief: Option<String>,
}

fn write_events_jsonl(
    detail: &crate::model::SessionDetail,
    file: &mut fs::File,
) -> anyhow::Result<()> {
    use crate::model::MessagePart;

    // Run the canonical skill detector once; map node_id -> skill_id for fast lookup.
    let provider = crate::providers::find(&detail.summary.provider_id);
    let cwd = detail.summary.cwd.as_deref().map(std::path::Path::new);
    let roots = provider.as_ref().map(|p| p.skill_roots(cwd)).unwrap_or_default();
    let registry = crate::skills::SkillRegistry::build(&roots);
    let mut detector = crate::skill_detect::SkillDetector::new(&registry);
    crate::skill_detect::walk_session_nodes(&detail.nodes, &mut detector);
    let usage = detector.into_usage_rows();
    let mut node_skill: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for u in &usage {
        for nid in &u.node_ids {
            node_skill.insert(nid.clone(), u.skill_id.clone());
        }
    }

    // Track tool retry chains: identical (tool_name, input) within the session
    // points back to its predecessor node id.
    let mut last_seen: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();
    let mut prev_ctx: Option<u64> = None;

    for (i, n) in detail.nodes.iter().enumerate() {
        let mut tool: Option<String> = None;
        let mut tool_input_brief: Option<String> = None;
        let mut retry_of: Option<String> = None;
        let mut is_error = false;
        let mut text_brief: Option<String> = None;
        for p in &n.parts {
            match p {
                MessagePart::ToolUse { name, input, .. } => {
                    if tool.is_none() {
                        tool = Some(name.clone());
                        tool_input_brief = Some(brief(input, 120));
                        let key = (name.clone(), input.clone());
                        if let Some(prev_id) = last_seen.get(&key) {
                            retry_of = Some(prev_id.clone());
                        }
                        last_seen.insert(key, n.id.clone());
                    }
                }
                MessagePart::ToolResult { is_error: e, .. } => {
                    if *e { is_error = true; }
                }
                MessagePart::Text { text } | MessagePart::Thinking { text } => {
                    if text_brief.is_none() && !text.is_empty() {
                        text_brief = Some(brief(text, 120));
                    }
                }
                _ => {}
            }
        }

        let ctx_after = n.cumulative_context_tokens;
        let ctx_jump_pct = match (prev_ctx, ctx_after) {
            (Some(prev), Some(curr)) if prev > 0 && curr >= prev => {
                Some((curr - prev) as f64 / prev as f64)
            }
            _ => None,
        };
        if ctx_after.is_some() { prev_ctx = ctx_after; }

        let row = EventRow {
            i: i as u32,
            id: n.id.clone(),
            ts: n.timestamp.clone(),
            kind: kind_str(&n.kind).to_string(),
            model: n.model.clone(),
            tool,
            tool_input_brief,
            ctx_after,
            ctx_jump_pct,
            tok_in: n.usage.as_ref().map(|u| u.input_tokens),
            tok_out: n.usage.as_ref().map(|u| u.output_tokens),
            dur_ms: n.usage.as_ref().and_then(|u| u.generation_duration_ms),
            skill_id: node_skill.get(&n.id).cloned(),
            is_error,
            retry_of,
            text_brief,
        };
        writeln!(file, "{}", serde_json::to_string(&row)?)?;
    }
    Ok(())
}

fn kind_str(k: &crate::model::NodeKind) -> &'static str {
    use crate::model::NodeKind::*;
    match k {
        User => "user", Assistant => "assistant", System => "system",
        ToolResult => "tool_result", Sidechain => "sidechain", Meta => "meta",
    }
}

fn brief(s: &str, max_chars: usize) -> String {
    let trimmed: String = s.chars().take(max_chars).collect();
    let cleaned = trimmed.replace('\n', " ").replace('\r', " ");
    if s.chars().count() > max_chars { format!("{}…", cleaned) } else { cleaned }
}

const TOOL_RESULT_HEAD_LINES: usize = 20;
const TOOL_RESULT_TAIL_LINES: usize = 5;

fn write_transcript_md(detail: &crate::model::SessionDetail, file: &mut fs::File) -> anyhow::Result<()> {
    use crate::model::MessagePart;
    let s = &detail.summary;
    writeln!(file, "# {}", s.title.clone().unwrap_or_else(|| s.session_id.clone()))?;
    writeln!(file, "")?;
    writeln!(file, "- session_id: `{}`", s.session_id)?;
    writeln!(file, "- provider: `{}`", s.provider_id)?;
    if let Some(c) = &s.cwd { writeln!(file, "- cwd: `{}`", c)?; }
    if let Some(b) = &s.git_branch { writeln!(file, "- branch: `{}`", b)?; }
    if let Some(t) = &s.started_at { writeln!(file, "- started_at: {}", t)?; }
    if let Some(t) = &s.ended_at { writeln!(file, "- ended_at: {}", t)?; }
    writeln!(file, "")?;

    for (i, n) in detail.nodes.iter().enumerate() {
        let kind = kind_str(&n.kind);
        let ts = n.timestamp.clone().unwrap_or_default();
        writeln!(file, "## [{}] {} {}", i, kind, ts)?;
        if let Some(m) = &n.model { writeln!(file, "_model: {}_", m)?; }
        writeln!(file, "")?;
        for p in &n.parts {
            match p {
                MessagePart::Text { text } => writeln!(file, "{}\n", text)?,
                MessagePart::Thinking { text } => writeln!(file, "> _thinking:_ {}\n", brief(text, 400))?,
                MessagePart::ToolUse { name, input, output, tool_use_id } => {
                    writeln!(file, "**tool_use** `{}` (id `{}`)\n```\n{}\n```\n", name, tool_use_id, brief(input, 400))?;
                    if let Some(out) = output {
                        // opencode collapses the call+result pair into a
                        // single record; surface the result text underneath
                        // so the markdown reads the same as the in-app view.
                        writeln!(file, "_output:_\n```\n{}\n```\n", brief(out, 400))?;
                    }
                }
                MessagePart::ToolResult { tool_use_id, content, is_error } => {
                    let head_marker = if *is_error { "**tool_result (ERROR)**" } else { "**tool_result**" };
                    writeln!(file, "{} ← `{}`\n```", head_marker, tool_use_id)?;
                    writeln!(file, "{}", truncate_lines(content, TOOL_RESULT_HEAD_LINES, TOOL_RESULT_TAIL_LINES))?;
                    writeln!(file, "```\n")?;
                }
                MessagePart::Image { media_type, bytes } => writeln!(file, "_image: {} ({} bytes)_\n", media_type, bytes)?,
                MessagePart::Attachment { path, .. } => writeln!(file, "_attachment: {}_\n", path)?,
                MessagePart::Note { text } => writeln!(file, "> _note:_ {}\n", brief(text, 400))?,
            }
        }
    }
    Ok(())
}

fn truncate_lines(s: &str, head: usize, tail: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    if lines.len() <= head + tail { return s.to_string(); }
    let omitted = lines.len() - head - tail;
    let mut out = lines[..head].join("\n");
    out.push_str(&format!("\n[+{} more lines]\n", omitted));
    out.push_str(&lines[lines.len() - tail..].join("\n"));
    out
}

fn render_analysis_guide(manifest: &Manifest, anomalies: &[(String, Vec<String>)]) -> String {
    let mut hi = String::new();
    for (sid, items) in anomalies {
        if items.is_empty() { continue; }
        hi.push_str(&format!("- `{}`: {}\n", sid, items.join(", ")));
    }
    if hi.is_empty() { hi.push_str("- (none flagged)\n"); }

    let mut out = String::new();
    out.push_str("# AAA Session Export — Analysis Guide\n");
    out.push_str("\n");
    out.push_str("> This bundle is the canonical input for AI-driven analysis of AAA sessions.\n");
    out.push_str(&format!(
        "> aaa version: `{}` · schema_version: `{}` · provider: `{}` · scope: `{}` · session_count: {}\n",
        manifest.aaa_version, manifest.schema_version,
        manifest.provider, manifest.scope, manifest.session_count
    ));
    out.push_str("\n");
    out.push_str("## Bundle layout\n");
    out.push_str("\n");
    out.push_str("```\n");
    out.push_str("manifest.json              head + known_skills inventory\n");
    out.push_str("index.jsonl                one row per session (peak_ctx, used_skills, anomalies)\n");
    out.push_str("analysis-guide.md          this file\n");
    out.push_str("sessions/<id>/\n");
    out.push_str("    events.jsonl           one row per node (skill_id, ctx_after, tool, retry_of)\n");
    out.push_str("    transcript.md          narrative drill-down with truncated tool_result bodies\n");
    out.push_str("    raw.json               full SessionDetail; fidelity escape hatch\n");
    out.push_str("```\n");
    out.push_str("\n");
    out.push_str("## Reading order\n");
    out.push_str("\n");
    out.push_str("1. Skim `index.jsonl` to pick interesting sessions (peak_ctx_pct, anomalies, skill counts).\n");
    out.push_str("2. Open `sessions/<id>/events.jsonl` for grep / per-node analysis.\n");
    out.push_str("3. Use `transcript.md` only when prose context is needed.\n");
    out.push_str("4. `raw.json` is for fidelity / regression — avoid as first read.\n");
    out.push_str("\n");
    out.push_str("## Pre-computed signals (don't re-derive)\n");
    out.push_str("\n");
    out.push_str("- `events.jsonl.skill_id` — already filled by the canonical `core::skill_detect` pipeline.\n");
    out.push_str("- `events.jsonl.ctx_jump_pct` — running pct against previous node's `cumulative_context_tokens`.\n");
    out.push_str("- `events.jsonl.retry_of` — same `(tool, input)` predecessor node id.\n");
    out.push_str("- `index.jsonl.anomalies` — strings like `ctx_jump@<node>`, `tool_retry_loop@<node>`.\n");
    out.push_str("- `manifest.json.known_skills` — every SKILL.md the provider can see; use this for \"should this skill have triggered?\" reasoning.\n");
    out.push_str("\n");
    out.push_str("## Sessions with flagged anomalies\n");
    out.push_str("\n");
    out.push_str(&hi);
    out
}
