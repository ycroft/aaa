//! Tauri command surface — what the frontend can call.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use aaa_core::model::{ProviderInfo, SessionDetail, SessionSummary};
use aaa_core::providers;
use aaa_core::remote::{
    cache_root, known_hosts, list_caches_for_host, open_for_provider, probe_remote, RemoteAuth,
    RemoteCacheInfo, RemoteHost, RemoteHostInfo, RemoteOpenResult, RemoteProviderInfo, Secret,
    SyncContext, SyncProgress,
};
use aaa_core::settings::{self, AppSettings};
use aaa_core::stats::{self, SkillUsage};
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

fn err_to_string<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Wrap a `Result<_, String>` with a warn! on error so failures are visible
/// in the log without each command repeating the boilerplate.
fn warn_on_err<T>(cmd: &'static str, res: Result<T, String>) -> Result<T, String> {
    if let Err(ref e) = res {
        warn!("command {} failed: {}", cmd, e);
    }
    res
}

/// Per-task cancel flags keyed by `task_id`. The frontend passes the same id to
/// `remote_cancel`; the open task polls the flag between SFTP ops.
#[derive(Default)]
pub struct RemoteTasks(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Debug, Clone, Serialize)]
struct ProgressEvent<'a> {
    task_id: &'a str,
    progress: &'a SyncProgress,
}

/// Static "About" payload — version comes from Cargo metadata at compile time,
/// release notes are embedded from `tools/aaa/release-notes.txt` via include_str!,
/// so the running binary and its notes are always in lock-step.
#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub author: &'static str,
    pub description: &'static str,
    pub release_notes: &'static str,
}

const RELEASE_NOTES: &str = include_str!("../../release-notes.txt");

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        name: "AAA · Agent Analyzer",
        version: env!("CARGO_PKG_VERSION"),
        author: "Yin Yuhao",
        description: "跨后端的本地 AI 编码代理会话日志分析工具。读取磁盘上各家 agent（Claude Code、opencode、…）的原生日志，统一成共享数据模型，在桌面 UI 里呈现：会话列表、可折叠时间线、token 成本与上下文窗口走势，标红峰值节点和上下文跳跃点，方便定位『窗口炸在哪条消息』。",
        release_notes: RELEASE_NOTES,
    }
}

#[tauri::command]
pub fn list_providers() -> Result<Vec<ProviderInfo>, String> {
    debug!("cmd list_providers");
    let res: Result<Vec<ProviderInfo>, String> = (|| {
        let settings = settings::load().map_err(err_to_string)?;
        Ok(providers::all()
            .iter()
            .map(|p| {
                let override_root = settings
                    .provider_roots
                    .get(p.id())
                    .map(PathBuf::from);
                providers::info_of(p.as_ref(), override_root.as_ref())
            })
            .collect())
    })();
    warn_on_err("list_providers", res)
}

#[tauri::command]
pub fn list_sessions(provider_id: String, root: Option<String>) -> Result<Vec<SessionSummary>, String> {
    debug!("cmd list_sessions provider={} root={:?}", provider_id, root);
    let res: Result<Vec<SessionSummary>, String> = (|| {
        let provider = providers::find(&provider_id)
            .ok_or_else(|| format!("unknown provider: {}", provider_id))?;
        let resolved = match root {
            Some(r) if !r.is_empty() => PathBuf::from(r),
            _ => provider
                .default_root()
                .ok_or_else(|| "provider has no default directory; please configure one".to_string())?,
        };
        provider.list_sessions(&resolved).map_err(err_to_string)
    })();
    warn_on_err("list_sessions", res)
}

#[tauri::command]
pub fn load_session(provider_id: String, source_path: String) -> Result<SessionDetail, String> {
    debug!("cmd load_session provider={} source_path={}", provider_id, source_path);
    let res: Result<SessionDetail, String> = (|| {
        let provider = providers::find(&provider_id)
            .ok_or_else(|| format!("unknown provider: {}", provider_id))?;
        provider
            .load_session(&PathBuf::from(source_path))
            .map_err(err_to_string)
    })();
    warn_on_err("load_session", res)
}

/// Phase-1 skill usage. Re-loads the session (cheap — no separate cache layer
/// today) and runs [`stats::skill_usage`]. Returns an empty vec for providers
/// that don't expose structured skill records (i.e. anything other than
/// claude-code right now); see the stats module docstring for the phase-2
/// heuristic plan.
#[tauri::command]
pub fn session_skill_usage(
    provider_id: String,
    source_path: String,
) -> Result<Vec<SkillUsage>, String> {
    debug!(
        "cmd session_skill_usage provider={} source_path={}",
        provider_id, source_path
    );
    let res: Result<Vec<SkillUsage>, String> = (|| {
        let provider = providers::find(&provider_id)
            .ok_or_else(|| format!("unknown provider: {}", provider_id))?;
        let detail = provider
            .load_session(&PathBuf::from(source_path))
            .map_err(err_to_string)?;
        Ok(stats::skill_usage(&detail))
    })();
    warn_on_err("session_skill_usage", res)
}

#[tauri::command]
pub fn get_settings() -> Result<AppSettings, String> {
    debug!("cmd get_settings");
    warn_on_err("get_settings", settings::load().map_err(err_to_string))
}

#[tauri::command]
pub fn save_settings(mut settings: AppSettings) -> Result<(), String> {
    debug!("cmd save_settings");
    // remotes are managed exclusively by save_remote / delete_remote.
    // Preserve whatever is on disk so the generic settings dialog cannot
    // accidentally clobber freshly-added hosts whose data the frontend
    // draft never picked up.
    let existing = settings::load().unwrap_or_default();
    settings.remotes = existing.remotes;
    warn_on_err("save_settings", settings::save(&settings).map_err(err_to_string))
}

// ---------------- Remote commands ----------------

#[derive(Deserialize)]
pub struct RemoteAuthInput {
    pub kind: String, // "password" | "private_key"
    pub password: Option<String>,
    pub path: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Deserialize)]
pub struct RemoteHostInput {
    pub id: Option<String>,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: Option<RemoteAuthInput>, // None = preserve existing on edit
    #[serde(default)]
    pub provider_root_overrides: std::collections::HashMap<String, String>,
}

fn auth_from_input(a: RemoteAuthInput) -> Result<RemoteAuth, String> {
    match a.kind.as_str() {
        "password" => Ok(RemoteAuth::Password {
            password: Secret(a.password.unwrap_or_default()),
        }),
        "private_key" => Ok(RemoteAuth::PrivateKey {
            path: a
                .path
                .ok_or_else(|| "private_key requires path".to_string())?,
            passphrase: a.passphrase.map(Secret),
        }),
        other => Err(format!("unknown auth kind: {}", other)),
    }
}

fn auth_kind_str(a: &RemoteAuth) -> &'static str {
    match a {
        RemoteAuth::Password { .. } => "password",
        RemoteAuth::PrivateKey { .. } => "private_key",
    }
}

fn to_info(h: &RemoteHost, kh: &known_hosts::KnownHosts) -> RemoteHostInfo {
    RemoteHostInfo {
        id: h.id.clone(),
        label: h.label.clone(),
        host: h.host.clone(),
        port: h.port,
        user: h.user.clone(),
        auth_kind: auth_kind_str(&h.auth).into(),
        provider_root_overrides: h.provider_root_overrides.clone(),
        last_synced_at: None,
        host_key_known: kh.get(&h.id).is_some(),
    }
}

#[tauri::command]
pub fn list_remotes() -> Result<Vec<RemoteHostInfo>, String> {
    debug!("cmd list_remotes");
    let res: Result<Vec<RemoteHostInfo>, String> = (|| {
        let s = settings::load().map_err(err_to_string)?;
        let kh = known_hosts::KnownHosts::open().map_err(err_to_string)?;
        Ok(s.remotes.iter().map(|h| to_info(h, &kh)).collect())
    })();
    warn_on_err("list_remotes", res)
}

#[tauri::command]
pub fn save_remote(input: RemoteHostInput) -> Result<RemoteHostInfo, String> {
    info!("cmd save_remote host={}@{}:{}", input.user, input.host, input.port);
    let res: Result<RemoteHostInfo, String> = (|| {
        let mut s = settings::load().map_err(err_to_string)?;
        let id = input.id.clone().unwrap_or_else(|| ulid::Ulid::new().to_string());
        let existing_pos = s.remotes.iter().position(|h| h.id == id);
        let auth = match input.auth {
            Some(a) => auth_from_input(a)?,
            None => existing_pos
                .map(|i| s.remotes[i].auth.clone())
                .ok_or_else(|| "auth required for new remote".to_string())?,
        };
        let host = RemoteHost {
            id: id.clone(),
            label: input.label,
            host: input.host,
            port: input.port,
            user: input.user,
            auth,
            provider_root_overrides: input.provider_root_overrides,
        };
        match existing_pos {
            Some(i) => s.remotes[i] = host.clone(),
            None => s.remotes.push(host.clone()),
        }
        settings::save(&s).map_err(err_to_string)?;
        let kh = known_hosts::KnownHosts::open().map_err(err_to_string)?;
        Ok(to_info(&host, &kh))
    })();
    warn_on_err("save_remote", res)
}

#[tauri::command]
pub fn delete_remote(remote_id: String) -> Result<(), String> {
    info!("cmd delete_remote id={}", remote_id);
    let res: Result<(), String> = (|| {
        let mut s = settings::load().map_err(err_to_string)?;
        s.remotes.retain(|h| h.id != remote_id);
        settings::save(&s).map_err(err_to_string)?;
        if let Ok(mut kh) = known_hosts::KnownHosts::open() {
            let _ = kh.forget(&remote_id);
        }
        if let Ok(base) = cache_root() {
            let dir = base.join(&remote_id);
            let _ = std::fs::remove_dir_all(dir);
        }
        Ok(())
    })();
    warn_on_err("delete_remote", res)
}

#[tauri::command]
pub fn list_remote_caches(remote_id: String) -> Result<Vec<RemoteCacheInfo>, String> {
    debug!("cmd list_remote_caches id={}", remote_id);
    warn_on_err(
        "list_remote_caches",
        list_caches_for_host(&remote_id).map_err(|e| e.to_string()),
    )
}

#[tauri::command]
pub async fn remote_probe(remote_id: String) -> Result<Vec<RemoteProviderInfo>, String> {
    info!("cmd remote_probe id={}", remote_id);
    let s = settings::load().map_err(err_to_string)?;
    let host = s
        .remotes
        .iter()
        .find(|h| h.id == remote_id)
        .cloned()
        .ok_or_else(|| format!("unknown remote: {}", remote_id))?;
    let providers = providers::all();
    warn_on_err(
        "remote_probe",
        probe_remote(&host, &providers).await.map_err(|e| e.to_string()),
    )
}

#[tauri::command]
pub async fn remote_open(
    app: AppHandle,
    tasks: State<'_, RemoteTasks>,
    remote_id: String,
    provider_id: String,
    task_id: String,
) -> Result<RemoteOpenResult, String> {
    info!(
        "cmd remote_open remote={} provider={} task={}",
        remote_id, provider_id, task_id
    );
    let s = settings::load().map_err(err_to_string)?;
    let host = s
        .remotes
        .iter()
        .find(|h| h.id == remote_id)
        .cloned()
        .ok_or_else(|| format!("unknown remote: {}", remote_id))?;
    let provider = providers::find(&provider_id)
        .ok_or_else(|| format!("unknown provider: {}", provider_id))?;

    // Register the cancel flag so `remote_cancel(task_id)` can find it.
    let cancelled = Arc::new(AtomicBool::new(false));
    tasks
        .0
        .lock()
        .unwrap()
        .insert(task_id.clone(), cancelled.clone());

    let task_id_for_cb = task_id.clone();
    let app_for_cb = app.clone();
    let mut ctx = SyncContext {
        on_progress: Box::new(move |p| {
            let _ = app_for_cb.emit(
                "remote-progress",
                ProgressEvent {
                    task_id: &task_id_for_cb,
                    progress: p,
                },
            );
        }),
        cancelled: cancelled.clone(),
    };

    let res = open_for_provider(&host, provider.as_ref(), &mut ctx).await;
    tasks.0.lock().unwrap().remove(&task_id);
    let res = res.map_err(|e| e.to_string());
    if let Ok(ref r) = res {
        info!(
            "remote_open ok: pulled {} files / {} bytes in {} ms (local_root={})",
            r.sync_stats.files_pulled,
            r.sync_stats.bytes_pulled,
            r.sync_stats.elapsed_ms,
            r.local_root,
        );
    }
    warn_on_err("remote_open", res)
}

/// Flip the cancel flag for an in-flight `remote_open`. Idempotent — unknown
/// task ids return Ok so the UI can fire-and-forget on close.
#[tauri::command]
pub fn remote_cancel(tasks: State<'_, RemoteTasks>, task_id: String) -> Result<(), String> {
    info!("cmd remote_cancel task={}", task_id);
    if let Some(flag) = tasks.0.lock().unwrap().get(&task_id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Check whether a command (by name) is available on PATH.
#[tauri::command]
pub fn check_command_exists(cmd: String) -> bool {
    #[cfg(target_os = "windows")]
    let check = std::process::Command::new("where")
        .arg(&cmd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    #[cfg(not(target_os = "windows"))]
    let check = std::process::Command::new("which")
        .arg(&cmd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    check.map(|s| s.success()).unwrap_or(false)
}

/// Export all sessions from a provider root to a target directory.
/// Returns the canonical paths of all written files.
#[tauri::command]
pub fn export_all_sessions(
    provider_id: String,
    root: String,
    target_dir: String,
) -> Result<Vec<String>, String> {
    info!(
        "cmd export_all_sessions provider={} root={} target_dir={}",
        provider_id, root, target_dir
    );
    let res: Result<Vec<String>, String> = (|| {
        let provider = providers::find(&provider_id)
            .ok_or_else(|| format!("unknown provider: {}", provider_id))?;
        let root_path = PathBuf::from(&root);
        let sessions = provider.list_sessions(&root_path).map_err(err_to_string)?;

        let dir = PathBuf::from(&target_dir);
        std::fs::create_dir_all(&dir).map_err(err_to_string)?;

        let mut paths = Vec::new();
        for s in &sessions {
            let detail = provider.load_session(&PathBuf::from(&s.source_path)).map_err(err_to_string)?;
            let json = serde_json::to_string_pretty(&detail).map_err(err_to_string)?;
            let file_name = format!("{}.json", s.session_id);
            let dest = dir.join(&file_name);
            std::fs::write(&dest, json).map_err(err_to_string)?;
            let canonical = std::fs::canonicalize(&dest).unwrap_or(dest).to_string_lossy().into_owned();
            paths.push(canonical);
        }
        info!("export_all_sessions wrote {} files", paths.len());
        Ok(paths)
    })();
    warn_on_err("export_all_sessions", res)
}

/// Create work_dir, write prompt.txt, then launch the agent in a new terminal window.
/// A background thread waits for the process to exit and removes work_dir.
#[tauri::command]
pub fn launch_agent(
    cmd_template: String,
    work_dir: String,
    prompt_content: String,
) -> Result<(), String> {
    info!(
        "cmd launch_agent template={:?} work_dir={} prompt_bytes={}",
        cmd_template,
        work_dir,
        prompt_content.len()
    );
    let work_path = PathBuf::from(&work_dir);
    std::fs::create_dir_all(&work_path).map_err(err_to_string)?;
    std::fs::write(work_path.join("prompt.txt"), &prompt_content).map_err(err_to_string)?;

    let prompt_file = work_path.join("prompt.txt");
    let prompt_file_str = prompt_file.to_string_lossy().into_owned();
    let expanded = cmd_template
        .replace("{prompt_file}", &prompt_file_str)
        .replace("{work_dir}", &work_dir);

    // Naive whitespace split — sufficient for preset templates which have no quoted spaces.
    let mut parts = expanded.split_whitespace();
    let exe = parts.next().ok_or("empty cmd_template")?;
    let mut args: Vec<String> = parts.map(str::to_string).collect();

    // Pass @prompt.txt as the prompt argument — claude reads the file content automatically.
    // This avoids all newline/quoting issues with multi-line prompts.
    if !cmd_template.contains("{prompt_file}") {
        args.push("@prompt.txt".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut child = {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x00000010;
        // Must go through cmd.exe because the agent may be a .bat/.cmd file.
        // Pass the agent command + args as separate argv entries to avoid shell quoting.
        // cmd /k <exe> <arg1> <arg2> ... works when each token is a separate element.
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/k").arg(exe);
        for a in &args { cmd.arg(a); }
        cmd.current_dir(&work_path)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(err_to_string)?
    };

    #[cfg(not(target_os = "windows"))]
    let mut child = {
        let terminals: &[(&str, &[&str])] = &[
            ("x-terminal-emulator", &["-e"]),
            ("gnome-terminal", &["--"]),
            ("xterm", &["-e"]),
        ];
        let mut spawned = None;
        for (term, targs) in terminals {
            let mut cmd = std::process::Command::new(term);
            for a in *targs { cmd.arg(a); }
            cmd.arg(exe).args(&args).current_dir(&work_path);
            if let Ok(c) = cmd.spawn() { spawned = Some(c); break; }
        }
        spawned.ok_or_else(|| "no terminal emulator found".to_string())?
    };

    let work_dir_owned = work_dir.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&work_dir_owned);
    });

    Ok(())
}

/// Export a session as pretty-printed JSON to a user-chosen directory.
/// Returns the canonical absolute path of the written file.
#[tauri::command]
pub fn export_session(
    provider_id: String,
    source_path: String,
    target_dir: String,
    file_name: String,
) -> Result<String, String> {
    info!(
        "cmd export_session provider={} target_dir={} file_name={}",
        provider_id, target_dir, file_name
    );
    let res: Result<String, String> = (|| {
        // Defense-in-depth: reject file_name containing path separators.
        if file_name.contains('/') || file_name.contains('\\') || file_name.is_empty() {
            return Err("invalid file name".into());
        }

        let provider = providers::find(&provider_id)
            .ok_or_else(|| format!("unknown provider: {}", provider_id))?;
        let detail = provider
            .load_session(&PathBuf::from(&source_path))
            .map_err(err_to_string)?;

        let json = serde_json::to_string_pretty(&detail).map_err(err_to_string)?;

        let dir = PathBuf::from(&target_dir);
        std::fs::create_dir_all(&dir).map_err(err_to_string)?;

        let dest = dir.join(&file_name);
        std::fs::write(&dest, json).map_err(err_to_string)?;

        // Return canonical absolute path for status display.
        let canonical = std::fs::canonicalize(&dest)
            .unwrap_or(dest)
            .to_string_lossy()
            .into_owned();
        Ok(canonical)
    })();
    warn_on_err("export_session", res)
}
