//! Unified session-export bundle builder.
//!
//! Input: a list of (provider_id, source_path) pairs. Output: a directory
//! layout containing manifest.json + index.jsonl + analysis-guide.md and a
//! sessions/<id>/ subdir per session with events.jsonl + transcript.md +
//! raw.json. Same code path serves the toolbar export button and the
//! AI-analysis dialog — single = N=1, all = N=K.

use std::fs;
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
    fs::write(bundle_dir.join("index.jsonl"), "")?;
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
