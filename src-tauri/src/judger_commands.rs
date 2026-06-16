//! Tauri command surface for the Judger feature.
//!
//! Wraps `aaa_core::judger` so the frontend can:
//!   - start a new judgment (`judger_start`) — builds workdir + bundle, then
//!     spawns the agent CLI via `commands::launch_agent` (with cleanup
//!     disabled so the workdir survives for inspection).
//!   - list past judgments (`judger_list`) — mtime-desc, with status.
//!   - load full detail (`judger_get`) — meta, rubric (if parsed), prompt
//!     bodies, raw result.json, file tree.
//!   - remove a judgment (`judger_delete`).
//!   - open the workdir in the OS file manager (`judger_open_workdir`).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use aaa_core::judger::{
    result as result_mod,
    runner::{self, StartJudgmentArgs},
    schema::{JudgmentMeta, Rubric},
    workdir,
};

use crate::commands::launch_agent;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JudgmentStatus {
    Pending,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct JudgmentListItem {
    pub meta: JudgmentMeta,
    pub status: JudgmentStatus,
}

#[derive(Debug, Clone, Serialize)]
pub struct JudgmentDetail {
    pub meta: JudgmentMeta,
    pub status: JudgmentStatus,
    pub rubric: Option<Rubric>,
    pub system_prompt: String,
    pub prompt_txt: String,
    pub result_raw: Option<String>,
    pub workdir_path: String,
    pub files: Vec<String>,
}

fn judgments_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    Ok(workdir::judgments_root(&dir))
}

#[tauri::command]
pub fn judger_start(app: AppHandle, args: StartJudgmentArgs) -> Result<String, String> {
    let root = judgments_root(&app)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let started = runner::prepare_judgment(&root, &args).map_err(|e| e.to_string())?;
    let workdir_str = started.workdir.to_string_lossy().to_string();
    // cleanup_workdir = Some(false): keep the workdir around after the agent
    // exits so the user can inspect meta.json / system-prompt.md / result.json.
    launch_agent(
        args.agent_cmd.clone(),
        workdir_str,
        started.prompt_txt,
        Some(false),
    )?;
    Ok(started.run_id)
}

#[tauri::command]
pub fn judger_list(app: AppHandle) -> Result<Vec<JudgmentListItem>, String> {
    let root = judgments_root(&app)?;
    let ids = workdir::list_run_ids(&root).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let dir = workdir::workdir_path(&root, &id);
        let meta = match workdir::read_meta(&dir) {
            Ok(m) => m,
            Err(_) => continue, // skip malformed
        };
        let status = compute_status(&dir);
        out.push(JudgmentListItem { meta, status });
    }
    Ok(out)
}

#[tauri::command]
pub fn judger_get(app: AppHandle, run_id: String) -> Result<JudgmentDetail, String> {
    workdir::validate_run_id(&run_id).map_err(|e| e.to_string())?;
    let root = judgments_root(&app)?;
    let dir = workdir::workdir_path(&root, &run_id);
    if !dir.is_dir() {
        return Err(format!("workdir not found: {run_id}"));
    }
    let meta = workdir::read_meta(&dir).map_err(|e| e.to_string())?;
    let status = compute_status(&dir);
    let rubric = result_mod::read_rubric(&dir).ok().flatten();
    let system_prompt = std::fs::read_to_string(dir.join("system-prompt.md")).unwrap_or_default();
    let prompt_txt = std::fs::read_to_string(dir.join("prompt.txt")).unwrap_or_default();
    let result_raw = std::fs::read_to_string(dir.join("result.json")).ok();
    let files = walk_workdir_files(&dir);

    Ok(JudgmentDetail {
        meta,
        status,
        rubric,
        system_prompt,
        prompt_txt,
        result_raw,
        workdir_path: dir.to_string_lossy().to_string(),
        files,
    })
}

#[tauri::command]
pub fn judger_delete(app: AppHandle, run_id: String) -> Result<(), String> {
    let root = judgments_root(&app)?;
    workdir::delete_workdir(&root, &run_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn judger_open_workdir(app: AppHandle, run_id: String) -> Result<(), String> {
    workdir::validate_run_id(&run_id).map_err(|e| e.to_string())?;
    let root = judgments_root(&app)?;
    let dir = workdir::workdir_path(&root, &run_id);
    if !dir.is_dir() {
        return Err(format!("workdir not found: {run_id}"));
    }
    open_in_file_manager(&dir)
}

fn compute_status(workdir: &std::path::Path) -> JudgmentStatus {
    let result_path = workdir.join("result.json");
    if !result_path.exists() {
        return JudgmentStatus::Pending;
    }
    match result_mod::read_rubric(workdir) {
        Ok(Some(_)) => JudgmentStatus::Done,
        Ok(None) => JudgmentStatus::Pending,
        Err(_) => JudgmentStatus::Failed,
    }
}

fn walk_workdir_files(root: &std::path::Path) -> Vec<String> {
    fn walk(dir: &std::path::Path, base: &std::path::Path, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for ent in rd.flatten() {
            let p = ent.path();
            if let Ok(rel) = p.strip_prefix(base) {
                out.push(rel.to_string_lossy().to_string());
            }
            if p.is_dir() {
                walk(&p, base, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

fn open_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let cmd = ("xdg-open", vec![path.as_os_str().to_owned()]);
    #[cfg(target_os = "macos")]
    let cmd = ("open", vec![path.as_os_str().to_owned()]);
    #[cfg(target_os = "windows")]
    let cmd = ("explorer", vec![path.as_os_str().to_owned()]);

    std::process::Command::new(cmd.0)
        .args(&cmd.1)
        .spawn()
        .map_err(|e| format!("open file manager: {e}"))?;
    Ok(())
}
