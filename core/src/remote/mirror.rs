//! Incremental directory sync: pull a remote directory into local cache,
//! delete locally any files no longer present remotely.
//!
//! Compare granularity = (size, mtime). Download to `<file>.partial` then
//! atomic rename. Path validation rejects `..` and ensures the final path
//! stays inside `local_root`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use log::{debug, info};

use super::{FileMeta, RemoteError, RemoteFs, SyncContext, SyncPhase, SyncProgress, SyncStats};

pub async fn sync_dir(
    fs: &mut dyn RemoteFs,
    remote_root: &str,
    local_root: &Path,
    ctx: &mut SyncContext,
) -> Result<SyncStats, RemoteError> {
    let started = Instant::now();
    debug!("sync_dir start remote={} local={:?}", remote_root, local_root);
    std::fs::create_dir_all(local_root)?;
    cleanup_partials(local_root)?;

    ctx.check_cancel()?;
    ctx.report(&SyncProgress::new(SyncPhase::Listing));

    let mut remote = HashMap::new();
    walk_remote(fs, remote_root, &mut remote, ctx).await?;

    let mut local = HashMap::new();
    walk_local(local_root, Path::new(""), &mut local)?;

    // Compute totals (files only) so the UI can render a real bar.
    let mut files_total: u32 = 0;
    let mut bytes_total: u64 = 0;
    let mut to_pull: Vec<(String, FileMeta)> = Vec::new();
    for (rel, rmeta) in &remote {
        if rmeta.is_dir {
            std::fs::create_dir_all(local_root.join(rel))?;
            continue;
        }
        let need = match local.get(rel) {
            Some(lmeta) if !lmeta.is_dir
                && lmeta.size == rmeta.size
                && lmeta.mtime == rmeta.mtime => false,
            _ => true,
        };
        if need {
            files_total = files_total.saturating_add(1);
            bytes_total = bytes_total.saturating_add(rmeta.size);
            to_pull.push((rel.clone(), rmeta.clone()));
        }
    }

    let mut stats = SyncStats::default();
    let mut progress = SyncProgress {
        phase: SyncPhase::Downloading,
        current_file: None,
        files_done: 0,
        files_total,
        bytes_done: 0,
        bytes_total,
    };
    ctx.report(&progress);

    // Skip count = remote_files - to_pull (everything already in local).
    let remote_files = remote.values().filter(|m| !m.is_dir).count() as u32;
    stats.files_skipped = remote_files.saturating_sub(files_total);

    for (rel, rmeta) in &to_pull {
        ctx.check_cancel()?;
        let dest = safe_join(local_root, rel)?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let partial = dest.with_extension("partial");
        let remote_full = join_remote(remote_root, rel);

        progress.current_file = Some(rel.clone());
        ctx.report(&progress);

        let bytes = fs.download(&remote_full, &partial).await?;
        std::fs::rename(&partial, &dest)?;
        stats.files_pulled += 1;
        stats.bytes_pulled += bytes;

        progress.files_done = stats.files_pulled;
        progress.bytes_done = stats.bytes_pulled;
        // Some servers report size=0 for unknown; keep totals at least as large as done.
        if progress.bytes_total < progress.bytes_done {
            progress.bytes_total = progress.bytes_done;
        }
        ctx.report(&progress);
        let _ = rmeta; // size already accounted in totals
    }

    // Local files no longer remote: delete.
    ctx.check_cancel()?;
    ctx.report(&SyncProgress::new(SyncPhase::Cleaning));
    let remote_keys: HashSet<&String> = remote.keys().collect();
    for (rel, lmeta) in &local {
        if remote_keys.contains(rel) {
            continue;
        }
        let path = safe_join(local_root, rel)?;
        if lmeta.is_dir {
            // Sub-files handled separately; v1 leaves empty dirs alone.
            continue;
        }
        if path.exists() {
            std::fs::remove_file(&path)?;
            stats.files_deleted_locally += 1;
        }
    }

    stats.elapsed_ms = started.elapsed().as_millis() as u64;
    info!(
        "sync_dir done: pulled={} skipped={} deleted={} bytes={} elapsed={}ms",
        stats.files_pulled,
        stats.files_skipped,
        stats.files_deleted_locally,
        stats.bytes_pulled,
        stats.elapsed_ms,
    );
    Ok(stats)
}

/// Mirror a curated list of files (relative paths) instead of walking the
/// whole tree. Used by providers like opencode where the data dir is huge
/// but only a handful of files are interesting (SQLite db + WAL/SHM).
///
/// Compare granularity is the same as `sync_dir` (size + mtime). Missing
/// remote names are silently skipped (e.g. `-wal` only exists during a
/// write); local files matching a relative path that's missing remotely
/// are deleted, mirroring `sync_dir`'s behaviour.
pub async fn sync_files(
    fs: &mut dyn RemoteFs,
    remote_root: &str,
    local_root: &Path,
    files: &[&str],
    ctx: &mut SyncContext,
) -> Result<SyncStats, RemoteError> {
    let started = Instant::now();
    debug!(
        "sync_files start remote={} local={:?} curated={}",
        remote_root,
        local_root,
        files.len()
    );
    std::fs::create_dir_all(local_root)?;
    cleanup_partials(local_root)?;

    ctx.check_cancel()?;
    ctx.report(&SyncProgress::new(SyncPhase::Listing));

    // Stat each requested file remotely. Missing = treat as absent (not an error).
    let mut remote: HashMap<String, FileMeta> = HashMap::new();
    for rel in files {
        ctx.check_cancel()?;
        let full = join_remote(remote_root, rel);
        if let Ok(meta) = fs.metadata(&full).await {
            if !meta.is_dir {
                remote.insert((*rel).to_string(), meta);
            }
        }
    }

    // Compare against local copies.
    let mut to_pull: Vec<(String, FileMeta)> = Vec::new();
    let mut bytes_total: u64 = 0;
    for (rel, rmeta) in &remote {
        let dest = safe_join(local_root, rel)?;
        let need = match std::fs::metadata(&dest) {
            Ok(lmeta) if !lmeta.is_dir() => {
                let lsize = lmeta.len();
                let lmtime = lmeta
                    .modified()
                    .ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                lsize != rmeta.size || lmtime != rmeta.mtime
            }
            _ => true,
        };
        if need {
            bytes_total = bytes_total.saturating_add(rmeta.size);
            to_pull.push((rel.clone(), rmeta.clone()));
        }
    }

    let mut stats = SyncStats::default();
    stats.files_skipped = (remote.len() as u32).saturating_sub(to_pull.len() as u32);

    let mut progress = SyncProgress {
        phase: SyncPhase::Downloading,
        current_file: None,
        files_done: 0,
        files_total: to_pull.len() as u32,
        bytes_done: 0,
        bytes_total,
    };
    ctx.report(&progress);

    for (rel, _rmeta) in &to_pull {
        ctx.check_cancel()?;
        let dest = safe_join(local_root, rel)?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let partial = dest.with_extension("partial");
        let remote_full = join_remote(remote_root, rel);

        progress.current_file = Some(rel.clone());
        ctx.report(&progress);

        let bytes = fs.download(&remote_full, &partial).await?;
        std::fs::rename(&partial, &dest)?;
        stats.files_pulled += 1;
        stats.bytes_pulled += bytes;

        progress.files_done = stats.files_pulled;
        progress.bytes_done = stats.bytes_pulled;
        if progress.bytes_total < progress.bytes_done {
            progress.bytes_total = progress.bytes_done;
        }
        ctx.report(&progress);
    }

    // Delete local copies of curated files that are missing remotely.
    ctx.check_cancel()?;
    ctx.report(&SyncProgress::new(SyncPhase::Cleaning));
    for rel in files {
        if remote.contains_key(*rel) {
            continue;
        }
        let path = safe_join(local_root, rel)?;
        if path.exists() && path.is_file() {
            std::fs::remove_file(&path)?;
            stats.files_deleted_locally += 1;
        }
    }

    stats.elapsed_ms = started.elapsed().as_millis() as u64;
    info!(
        "sync_files done: pulled={} skipped={} deleted={} bytes={} elapsed={}ms",
        stats.files_pulled,
        stats.files_skipped,
        stats.files_deleted_locally,
        stats.bytes_pulled,
        stats.elapsed_ms,
    );
    Ok(stats)
}

fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, RemoteError> {
    if rel.split('/').any(|c| c == ".." || (c.is_empty() && !rel.is_empty())) {
        return Err(RemoteError::InvalidPath(rel.into()));
    }
    let joined = root.join(rel);
    if !joined.starts_with(root) {
        return Err(RemoteError::InvalidPath(rel.into()));
    }
    Ok(joined)
}

fn join_remote(root: &str, rel: &str) -> String {
    if rel.is_empty() {
        root.to_string()
    } else {
        format!("{}/{}", root.trim_end_matches('/'), rel)
    }
}

fn cleanup_partials(local_root: &Path) -> Result<(), RemoteError> {
    if !local_root.exists() {
        return Ok(());
    }
    for entry in walkdir::WalkDir::new(local_root).into_iter().flatten() {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) == Some("partial") {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(())
}

async fn walk_remote(
    fs: &mut dyn RemoteFs,
    root: &str,
    out: &mut HashMap<String, FileMeta>,
    ctx: &mut SyncContext,
) -> Result<(), RemoteError> {
    let mut stack: Vec<String> = vec![String::new()];
    while let Some(rel) = stack.pop() {
        ctx.check_cancel()?;
        let full = join_remote(root, &rel);
        let entries = fs.read_dir(&full).await?;
        for e in entries {
            let child_rel = if rel.is_empty() {
                e.name.clone()
            } else {
                format!("{}/{}", rel, e.name)
            };
            out.insert(child_rel.clone(), e.meta.clone());
            if e.meta.is_dir {
                stack.push(child_rel);
            }
        }
    }
    Ok(())
}

fn walk_local(
    root: &Path,
    rel: &Path,
    out: &mut HashMap<String, FileMeta>,
) -> Result<(), RemoteError> {
    let abs = root.join(rel);
    if !abs.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&abs)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".partial") || name == ".aaa-sync.json" {
            continue;
        }
        let child_rel = rel.join(&*name);
        let child_rel_str = child_rel.to_string_lossy().replace('\\', "/");
        let meta = entry.metadata()?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let is_dir = meta.is_dir();
        out.insert(
            child_rel_str.clone(),
            FileMeta {
                size: if is_dir { 0 } else { meta.len() },
                mtime,
                is_dir,
            },
        );
        if is_dir {
            walk_local(root, &child_rel, out)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::DirEntry;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use tempfile::TempDir;

    struct FakeFs {
        files: HashMap<String, (Vec<u8>, i64)>,
        dirs: HashSet<String>,
        downloads: Mutex<u32>,
    }

    impl FakeFs {
        fn new() -> Self {
            let mut dirs = HashSet::new();
            dirs.insert("/r".into());
            Self {
                files: HashMap::new(),
                dirs,
                downloads: Mutex::new(0),
            }
        }
        fn put_file(&mut self, path: &str, data: &[u8], mtime: i64) {
            self.files.insert(path.into(), (data.to_vec(), mtime));
            let mut parent = std::path::Path::new(path).parent();
            while let Some(p) = parent {
                let s = p.to_string_lossy().to_string();
                if s.is_empty() {
                    break;
                }
                self.dirs.insert(s);
                parent = p.parent();
            }
        }
    }

    #[async_trait]
    impl RemoteFs for FakeFs {
        async fn home_dir(&mut self) -> Result<String, RemoteError> {
            Ok("/home/u".into())
        }
        async fn metadata(&mut self, path: &str) -> Result<FileMeta, RemoteError> {
            if self.dirs.contains(path) {
                return Ok(FileMeta { size: 0, mtime: 0, is_dir: true });
            }
            if let Some((d, m)) = self.files.get(path) {
                return Ok(FileMeta { size: d.len() as u64, mtime: *m, is_dir: false });
            }
            Err(RemoteError::Sftp(format!("not found: {path}")))
        }
        async fn read_dir(&mut self, path: &str) -> Result<Vec<DirEntry>, RemoteError> {
            let mut out = Vec::new();
            let prefix = format!("{}/", path.trim_end_matches('/'));
            let mut seen = HashSet::new();
            for (k, (d, m)) in &self.files {
                if let Some(rest) = k.strip_prefix(&prefix) {
                    let first = rest.split('/').next().unwrap();
                    if !seen.insert(first.to_string()) {
                        continue;
                    }
                    let child_full = format!("{}{}", prefix, first);
                    let is_dir = self.dirs.contains(&child_full);
                    let meta = if is_dir {
                        FileMeta { size: 0, mtime: 0, is_dir: true }
                    } else {
                        FileMeta { size: d.len() as u64, mtime: *m, is_dir: false }
                    };
                    out.push(DirEntry { name: first.to_string(), meta });
                }
            }
            Ok(out)
        }
        async fn download(&mut self, remote: &str, local: &Path) -> Result<u64, RemoteError> {
            *self.downloads.lock().unwrap() += 1;
            let (data, _) = self
                .files
                .get(remote)
                .ok_or_else(|| RemoteError::Sftp(format!("not found: {remote}")))?;
            std::fs::write(local, data)?;
            let mtime = self.files[remote].1;
            let ts = std::time::UNIX_EPOCH + std::time::Duration::from_secs(mtime as u64);
            let f = std::fs::File::open(local)?;
            f.set_modified(ts).ok();
            Ok(data.len() as u64)
        }
    }

    #[tokio::test]
    async fn first_sync_pulls_everything() {
        let tmp = TempDir::new().unwrap();
        let mut fs = FakeFs::new();
        fs.put_file("/r/a.jsonl", b"hello", 1000);
        fs.put_file("/r/sub/b.jsonl", b"world", 2000);
        let stats = sync_dir(&mut fs, "/r", tmp.path(), &mut SyncContext::noop()).await.unwrap();
        assert_eq!(stats.files_pulled, 2);
        assert_eq!(stats.files_skipped, 0);
        assert_eq!(stats.files_deleted_locally, 0);
        assert!(tmp.path().join("a.jsonl").exists());
        assert!(tmp.path().join("sub/b.jsonl").exists());
    }

    #[tokio::test]
    async fn second_sync_skips_unchanged() {
        let tmp = TempDir::new().unwrap();
        let mut fs = FakeFs::new();
        fs.put_file("/r/a.jsonl", b"hello", 1000);
        sync_dir(&mut fs, "/r", tmp.path(), &mut SyncContext::noop()).await.unwrap();
        let stats = sync_dir(&mut fs, "/r", tmp.path(), &mut SyncContext::noop()).await.unwrap();
        assert_eq!(stats.files_pulled, 0);
        assert_eq!(stats.files_skipped, 1);
    }

    #[tokio::test]
    async fn deletes_local_files_missing_remote() {
        let tmp = TempDir::new().unwrap();
        let mut fs = FakeFs::new();
        fs.put_file("/r/a.jsonl", b"hello", 1000);
        sync_dir(&mut fs, "/r", tmp.path(), &mut SyncContext::noop()).await.unwrap();
        let mut fs2 = FakeFs::new();
        fs2.put_file("/r/b.jsonl", b"new", 1500);
        let stats = sync_dir(&mut fs2, "/r", tmp.path(), &mut SyncContext::noop()).await.unwrap();
        assert_eq!(stats.files_pulled, 1);
        assert_eq!(stats.files_deleted_locally, 1);
        assert!(!tmp.path().join("a.jsonl").exists());
        assert!(tmp.path().join("b.jsonl").exists());
    }

    #[tokio::test]
    async fn cancel_aborts_mid_sync() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let tmp = TempDir::new().unwrap();
        let mut fs = FakeFs::new();
        fs.put_file("/r/a.jsonl", b"hello", 1000);
        let flag = std::sync::Arc::new(AtomicBool::new(true));
        let mut ctx = SyncContext {
            on_progress: Box::new(|_| {}),
            cancelled: flag.clone(),
        };
        let err = sync_dir(&mut fs, "/r", tmp.path(), &mut ctx).await.unwrap_err();
        flag.store(false, Ordering::SeqCst);
        assert!(matches!(err, RemoteError::Cancelled));
    }

    #[test]
    fn safe_join_rejects_dotdot() {
        let root = Path::new("/tmp/cache");
        assert!(safe_join(root, "../etc/passwd").is_err());
        assert!(safe_join(root, "ok/file").is_ok());
    }

    #[tokio::test]
    async fn sync_files_only_pulls_listed() {
        let tmp = TempDir::new().unwrap();
        let mut fs = FakeFs::new();
        fs.put_file("/r/opencode.db", b"db-bytes", 1000);
        fs.put_file("/r/opencode.db-wal", b"wal-bytes", 1100);
        // Big unrelated file inside the same dir — must not be pulled.
        fs.put_file("/r/cache/blob.bin", &vec![0u8; 1024], 1200);
        let files = vec!["opencode.db", "opencode.db-wal", "opencode.db-shm"];
        let stats = sync_files(&mut fs, "/r", tmp.path(), &files, &mut SyncContext::noop())
            .await
            .unwrap();
        assert_eq!(stats.files_pulled, 2); // shm absent, blob.bin not requested
        assert!(tmp.path().join("opencode.db").exists());
        assert!(tmp.path().join("opencode.db-wal").exists());
        assert!(!tmp.path().join("opencode.db-shm").exists());
        assert!(!tmp.path().join("cache/blob.bin").exists());
    }

    #[tokio::test]
    async fn sync_files_second_run_skips() {
        let tmp = TempDir::new().unwrap();
        let mut fs = FakeFs::new();
        fs.put_file("/r/opencode.db", b"db", 1000);
        let files = vec!["opencode.db"];
        sync_files(&mut fs, "/r", tmp.path(), &files, &mut SyncContext::noop())
            .await
            .unwrap();
        let stats = sync_files(&mut fs, "/r", tmp.path(), &files, &mut SyncContext::noop())
            .await
            .unwrap();
        assert_eq!(stats.files_pulled, 0);
        assert_eq!(stats.files_skipped, 1);
    }

    #[tokio::test]
    async fn sync_files_deletes_local_when_missing_remote() {
        let tmp = TempDir::new().unwrap();
        let mut fs = FakeFs::new();
        fs.put_file("/r/opencode.db", b"db", 1000);
        fs.put_file("/r/opencode.db-wal", b"wal", 1100);
        let files = vec!["opencode.db", "opencode.db-wal"];
        sync_files(&mut fs, "/r", tmp.path(), &files, &mut SyncContext::noop())
            .await
            .unwrap();
        // Second run: clean shutdown — wal is gone.
        let mut fs2 = FakeFs::new();
        fs2.put_file("/r/opencode.db", b"db", 1000);
        let stats = sync_files(&mut fs2, "/r", tmp.path(), &files, &mut SyncContext::noop())
            .await
            .unwrap();
        assert_eq!(stats.files_deleted_locally, 1);
        assert!(!tmp.path().join("opencode.db-wal").exists());
        assert!(tmp.path().join("opencode.db").exists());
    }
}
