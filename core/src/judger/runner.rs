//! Orchestrates `start_judgment`: build workdir + meta + system prompt +
//! export bundle in one shot. Caller (Tauri command) is responsible for
//! firing `launch_agent` afterwards using the returned `prompt_txt` and
//! workdir path.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::export::{self, BundleInputs, ExportScope};
use crate::providers;

use super::prompt::build_system_prompt;
use super::schema::{Dimension, JudgmentMeta, SessionRef, META_SCHEMA_VERSION};
use super::workdir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartJudgmentArgs {
    pub provider_id: String,
    pub session: SessionRef,
    pub agent_cmd: String,
    pub dimensions: Vec<Dimension>,
    /// If `Some` and non-empty, replaces the auto-rendered system prompt.
    #[serde(default)]
    pub prompt_override: Option<String>,
}

pub struct StartedJudgment {
    pub run_id: String,
    pub workdir: PathBuf,
    /// Rendered prompt.txt body (system prompt + bundle/result paths).
    /// Caller passes this to launch_agent.
    pub prompt_txt: String,
}

/// Build workdir + meta + prompt + export bundle. Does NOT spawn the agent —
/// caller (Tauri command) invokes launch_agent with `prompt_txt` and `workdir`.
/// On any failure after workdir creation, the partial workdir is removed.
pub fn prepare_judgment(
    judgments_root: &Path,
    args: &StartJudgmentArgs,
) -> Result<StartedJudgment> {
    let run_id = workdir::generate_run_id(&args.provider_id, &args.session.session_id);
    let dir = workdir::create_workdir(judgments_root, &run_id)?;

    // Wrap subsequent ops so we can rollback on error.
    let result = (|| -> Result<StartedJudgment> {
        let meta = JudgmentMeta {
            run_id: run_id.clone(),
            provider_id: args.provider_id.clone(),
            session: args.session.clone(),
            started_at: Utc::now().to_rfc3339(),
            agent_cmd: args.agent_cmd.clone(),
            dimensions_enabled: args.dimensions.clone(),
            schema_version: META_SCHEMA_VERSION,
        };
        workdir::write_meta(&dir, &meta)?;

        let prompt_md = match &args.prompt_override {
            Some(s) if !s.trim().is_empty() => s.clone(),
            _ => build_system_prompt(&meta),
        };
        workdir::write_system_prompt(&dir, &prompt_md)?;

        // Build the export bundle into <workdir>/export/.
        // Keep the provider lookup so we surface a clean error before
        // build_bundle's own provider lookup runs.
        let _provider = providers::find(&args.provider_id)
            .with_context(|| format!("unknown provider: {}", args.provider_id))?;
        let inputs = BundleInputs {
            provider_id: args.provider_id.clone(),
            source_paths: vec![PathBuf::from(&args.session.source_path)],
            root: None,
            scope: ExportScope::Single,
        };
        let bundle = export::build_bundle(&inputs, &dir.join("export"))?;
        let bundle_root = bundle.bundle_dir.clone();

        let result_path = dir.join("result.json");
        let prompt_txt = format!(
            "{prompt_md}\n\n---\nbundle 目录: {bundle}\n结果写入: {result}\n",
            prompt_md = prompt_md,
            bundle = bundle_root.display(),
            result = result_path.display(),
        );
        workdir::write_prompt_txt(&dir, &prompt_txt)?;

        Ok(StartedJudgment {
            run_id: run_id.clone(),
            workdir: dir.clone(),
            prompt_txt,
        })
    })();

    if result.is_err() {
        let _ = workdir::delete_workdir(judgments_root, &run_id);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn args() -> StartJudgmentArgs {
        StartJudgmentArgs {
            provider_id: "claude-code".into(),
            session: SessionRef {
                session_id: "0123456789abcdef".into(),
                // Point at a nonexistent path: build_bundle will fail and we'll
                // verify the rollback. For the happy path, dispatch a fixture
                // session in the tauri smoke test (Task 12).
                source_path: "/nonexistent/path.jsonl".into(),
                title: None,
                cwd: None,
            },
            agent_cmd: "true".into(),
            dimensions: vec![Dimension::Context, Dimension::Safety],
            prompt_override: None,
        }
    }

    #[test]
    fn prepare_rolls_back_workdir_on_export_failure() {
        let tmp = tempdir().unwrap();
        let res = prepare_judgment(tmp.path(), &args());
        assert!(res.is_err(), "expected failure");

        // No leftover workdirs in root.
        let entries: Vec<_> = std::fs::read_dir(tmp.path()).unwrap().collect();
        assert!(entries.is_empty(), "workdir was not rolled back");
    }
}
