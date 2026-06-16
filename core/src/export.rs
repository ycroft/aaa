//! Unified session-export bundle builder.
//!
//! Input: a list of (provider_id, source_path) pairs. Output: a directory
//! layout containing manifest.json + index.jsonl + analysis-guide.md and a
//! sessions/<id>/ subdir per session with events.jsonl + transcript.md +
//! raw.json. Same code path serves the toolbar export button and the
//! AI-analysis dialog — single = N=1, all = N=K.

use std::path::{Path, PathBuf};

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

pub fn build_bundle(_inputs: &BundleInputs, _target_dir: &Path) -> anyhow::Result<BundlePaths> {
    anyhow::bail!("not yet implemented");
}
