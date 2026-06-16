use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use once_cell::sync::Lazy;
use rand::Rng;

use super::schema::JudgmentMeta;

/// Generate a run_id: `<provider>-<sess_short>-<ts>-<rand4>`.
/// `sess_short` is first 8 alphanumeric chars of `session_id`.
///
/// `rand4` is a 4-char base32 suffix derived from a process-global atomic
/// counter XOR-mixed with a per-process random seed. This guarantees no
/// collisions for the first ~1M calls within a single process while still
/// producing distinct values across processes.
pub fn generate_run_id(provider_id: &str, session_id: &str) -> String {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    static SEED: Lazy<u32> = Lazy::new(|| rand::thread_rng().gen());

    let sess_short: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    let ts = Utc::now().format("%Y%m%d%H%M%S");
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mixed = counter.wrapping_add(*SEED);
    let rand4: String = (0..4)
        .map(|i| {
            let n = ((mixed >> (i * 5)) & 0x1f) as u8;
            if n < 10 {
                (b'0' + n) as char
            } else {
                (b'a' + (n - 10)) as char
            }
        })
        .collect();
    format!("{provider_id}-{sess_short}-{ts}-{rand4}")
}

/// run_id may contain only `[A-Za-z0-9_-]+`, no `..`, no separators.
pub fn validate_run_id(run_id: &str) -> Result<()> {
    if run_id.is_empty() {
        return Err(anyhow!("run_id is empty"));
    }
    if !run_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(anyhow!("run_id contains illegal characters: {run_id}"));
    }
    Ok(())
}

/// Resolve the root directory for all judgment workdirs.
/// Default: `<app_data_dir>/judgments`. Tests inject via `JUDGER_ROOT_OVERRIDE`.
pub fn judgments_root(app_data_dir: &Path) -> PathBuf {
    if let Ok(override_path) = std::env::var("JUDGER_ROOT_OVERRIDE") {
        return PathBuf::from(override_path);
    }
    app_data_dir.join("judgments")
}

pub fn workdir_path(root: &Path, run_id: &str) -> PathBuf {
    root.join(run_id)
}

/// Create the workdir + `export/` subdir. Returns the workdir path.
pub fn create_workdir(root: &Path, run_id: &str) -> Result<PathBuf> {
    validate_run_id(run_id)?;
    let dir = workdir_path(root, run_id);
    fs::create_dir_all(dir.join("export"))
        .with_context(|| format!("failed to create workdir at {}", dir.display()))?;
    Ok(dir)
}

pub fn write_meta(workdir: &Path, meta: &JudgmentMeta) -> Result<()> {
    let path = workdir.join("meta.json");
    let buf = serde_json::to_vec_pretty(meta)?;
    fs::write(&path, buf).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

pub fn read_meta(workdir: &Path) -> Result<JudgmentMeta> {
    let path = workdir.join("meta.json");
    let raw = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let meta: JudgmentMeta = serde_json::from_slice(&raw)?;
    Ok(meta)
}

pub fn write_system_prompt(workdir: &Path, prompt_md: &str) -> Result<()> {
    fs::write(workdir.join("system-prompt.md"), prompt_md)?;
    Ok(())
}

pub fn write_prompt_txt(workdir: &Path, content: &str) -> Result<()> {
    fs::write(workdir.join("prompt.txt"), content)?;
    Ok(())
}

/// List all run_ids present under root, ordered by `meta.json` mtime descending.
pub fn list_run_ids(root: &Path) -> Result<Vec<String>> {
    if !root.exists() {
        fs::create_dir_all(root)?;
        return Ok(Vec::new());
    }
    let mut entries: Vec<(String, std::time::SystemTime)> = Vec::new();
    for ent in fs::read_dir(root)? {
        let ent = ent?;
        if !ent.file_type()?.is_dir() {
            continue;
        }
        let name = match ent.file_name().into_string() {
            Ok(s) => s,
            Err(_) => continue,
        };
        if validate_run_id(&name).is_err() {
            continue;
        }
        let meta_path = ent.path().join("meta.json");
        let mtime = fs::metadata(&meta_path)
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        entries.push((name, mtime));
    }
    entries.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(entries.into_iter().map(|(n, _)| n).collect())
}

pub fn delete_workdir(root: &Path, run_id: &str) -> Result<()> {
    validate_run_id(run_id)?;
    let dir = workdir_path(root, run_id);
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .with_context(|| format!("failed to remove {}", dir.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn run_id_has_required_segments() {
        let id = generate_run_id("claude-code", "9f3a7c2b-1234-5678-9abc-def012345678");
        // claude-code-9f3a7c2b-YYYYMMDDhhmmss-XXXX
        let parts: Vec<&str> = id.split('-').collect();
        assert!(parts.len() >= 4, "got {id}");
        assert_eq!(parts[0], "claude");  // provider id is split
        // session prefix should be 8 chars from session id
        assert!(id.contains("9f3a7c2b"), "missing session prefix: {id}");
    }

    #[test]
    fn run_ids_are_unique_under_concurrent_calls() {
        use std::collections::HashSet;
        let ids: HashSet<_> = (0..1000)
            .map(|_| generate_run_id("p", "session-aaaaaaaa-bbbb"))
            .collect();
        assert_eq!(ids.len(), 1000, "collisions detected");
    }

    #[test]
    fn validate_run_id_rejects_traversal() {
        assert!(validate_run_id("../etc").is_err());
        assert!(validate_run_id("/abs").is_err());
        assert!(validate_run_id("with space").is_err());
        assert!(validate_run_id("").is_err());
        assert!(validate_run_id("ok-id_123").is_ok());
    }

    #[test]
    fn create_workdir_makes_export_subdir() {
        let tmp = tempdir().unwrap();
        let dir = create_workdir(tmp.path(), "p-abc-20260101000000-aaaa").unwrap();
        assert!(dir.join("export").is_dir());
    }

    #[test]
    fn create_workdir_rejects_bad_run_id() {
        let tmp = tempdir().unwrap();
        assert!(create_workdir(tmp.path(), "../bad").is_err());
    }

    #[test]
    fn list_run_ids_orders_by_mtime_desc() {
        let tmp = tempdir().unwrap();
        let a = create_workdir(tmp.path(), "p-aaa-20260101000000-aaaa").unwrap();
        std::fs::write(a.join("meta.json"), "{}").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let b = create_workdir(tmp.path(), "p-bbb-20260101000001-bbbb").unwrap();
        std::fs::write(b.join("meta.json"), "{}").unwrap();
        let ids = list_run_ids(tmp.path()).unwrap();
        assert_eq!(ids[0], "p-bbb-20260101000001-bbbb");
        assert_eq!(ids[1], "p-aaa-20260101000000-aaaa");
    }

    #[test]
    fn delete_workdir_is_idempotent() {
        let tmp = tempdir().unwrap();
        let _ = create_workdir(tmp.path(), "p-x-20260101000000-aaaa").unwrap();
        delete_workdir(tmp.path(), "p-x-20260101000000-aaaa").unwrap();
        delete_workdir(tmp.path(), "p-x-20260101000000-aaaa").unwrap(); // second call, ok
    }
}
