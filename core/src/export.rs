//! Unified session-export bundle builder.
//!
//! Input: a list of (provider_id, source_path) pairs. Output: a directory
//! layout containing manifest.json + index.jsonl + analysis-guide.md and a
//! sessions/<id>/ subdir per session with events.jsonl + transcript.md +
//! raw.json. Same code path serves the toolbar export button and the
//! AI-analysis dialog — single = N=1, all = N=K.

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
        known_skills: collect_known_skills(&inputs.provider_id),
    };
    fs::write(
        bundle_dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;

    let provider = crate::providers::find(&inputs.provider_id)
        .ok_or_else(|| anyhow::anyhow!("unknown provider: {}", inputs.provider_id))?;

    let mut index_file = fs::File::create(bundle_dir.join("index.jsonl"))?;
    let sessions_dir = bundle_dir.join("sessions");
    let mut session_anomalies: Vec<(String, Vec<String>)> = Vec::new();

    for src in &inputs.source_paths {
        let detail = provider.load_session(src)?;
        let sid = detail.summary.session_id.clone();
        let session_subdir = sessions_dir.join(&sid);
        fs::create_dir_all(&session_subdir)?;
        let row = build_index_row(&detail, &sid);
        session_anomalies.push((sid.clone(), row.anomalies.clone()));
        writeln!(index_file, "{}", serde_json::to_string(&row)?)?;
        // events.jsonl / transcript.md / raw.json — Tasks 4-6 will fill these in.
        fs::write(session_subdir.join("events.jsonl"), "")?;
        fs::write(session_subdir.join("transcript.md"), "")?;
        fs::write(
            session_subdir.join("raw.json"),
            serde_json::to_string_pretty(&detail)?,
        )?;
    }

    fs::write(bundle_dir.join("analysis-guide.md"), "")?;

    Ok(BundlePaths {
        bundle_dir,
        session_count: inputs.source_paths.len(),
    })
}

fn collect_known_skills(provider_id: &str) -> Vec<ManifestSkill> {
    let Some(provider) = crate::providers::find(provider_id) else {
        return Vec::new();
    };
    let roots = provider.skill_roots(None);
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
    // Stub for Task 4: we'll fill ctx_jump / tool_retry detection there.
    // For now, flag peak_ctx > 80% of best-known model window only when easy;
    // otherwise leave empty so the row is well-formed.
    let _ = detail;
    Vec::new()
}
