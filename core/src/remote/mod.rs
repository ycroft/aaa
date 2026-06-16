//! Remote session log support: SSH connect, SFTP incremental sync, TOFU host-key.

use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

pub mod incremental;
pub mod known_hosts;
pub mod mirror;
pub mod probe;
pub mod ssh;

/// Wrapper for password / passphrase. `Debug` is redacted to avoid log leaks.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(pub String);

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0.is_empty() {
            f.write_str("Secret(empty)")
        } else {
            f.write_str("Secret(***)")
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RemoteAuth {
    Password { password: Secret },
    PrivateKey { path: String, passphrase: Option<Secret> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteHost {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: RemoteAuth,
    #[serde(default)]
    pub provider_root_overrides: HashMap<String, String>,
}

/// Sanitised view sent to the frontend — contains no password / passphrase.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteHostInfo {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_kind: String,
    pub provider_root_overrides: HashMap<String, String>,
    pub last_synced_at: Option<String>,
    pub host_key_known: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteProviderInfo {
    pub provider_id: String,
    pub remote_root: Option<String>,
    pub exists: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncStats {
    pub files_pulled: u32,
    pub files_skipped: u32,
    pub files_deleted_locally: u32,
    pub bytes_pulled: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteOpenResult {
    pub local_root: String,
    pub sync_stats: SyncStats,
}

/// Errors propagate to the frontend as strings with the variant prefix:
/// `HOST_KEY_MISMATCH:` / `AUTH_FAILED:` / etc.
#[derive(Debug, thiserror::Error)]
pub enum RemoteError {
    #[error("CONNECT_FAILED:{0}")]
    Connect(String),
    #[error("AUTH_FAILED:{0}")]
    Auth(String),
    #[error("HOST_KEY_MISMATCH:{old}:{new}")]
    HostKeyMismatch { old: String, new: String },
    #[error("PROBE_NOT_FOUND:{0}")]
    ProbeNotFound(String),
    #[error("SFTP:{0}")]
    Sftp(String),
    #[error("IO:{0}")]
    Io(String),
    #[error("INVALID_PATH:{0}")]
    InvalidPath(String),
    #[error("CONFIG:{0}")]
    Config(String),
    #[error("EXEC:code={code}:{stderr}")]
    Exec { code: i32, stderr: String },
    #[error("CANCELLED")]
    Cancelled,
}

impl From<std::io::Error> for RemoteError {
    fn from(e: std::io::Error) -> Self {
        RemoteError::Io(e.to_string())
    }
}

/// File metadata, shared across remote and local sides.
#[derive(Debug, Clone)]
pub struct FileMeta {
    pub size: u64,
    pub mtime: i64,
    pub is_dir: bool,
}

#[derive(Debug, Clone)]
pub struct DirEntry {
    pub name: String,
    pub meta: FileMeta,
}

/// Coarse-grained phases reported to the UI during a remote open.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncPhase {
    Connecting,
    Probing,
    Listing,
    Downloading,
    Cleaning,
    Done,
    /// All whitelisted files match local (size, mtime); skip everything.
    UpToDate,
    /// Running `command -v sqlite3` on the remote to decide L1 vs L3.
    ProbingRemote,
    /// Streaming SQL query results from the remote sqlite3 process.
    IncrementalQuery,
    /// Applying queried rows into the local cache db inside a transaction.
    IncrementalApply,
}

/// Snapshot the UI uses to render a progress bar / step indicator.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProgress {
    pub phase: SyncPhase,
    pub current_file: Option<String>,
    pub files_done: u32,
    pub files_total: u32,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

impl SyncProgress {
    pub fn new(phase: SyncPhase) -> Self {
        Self {
            phase,
            current_file: None,
            files_done: 0,
            files_total: 0,
            bytes_done: 0,
            bytes_total: 0,
        }
    }
}

/// Plumbed through `open_for_provider` / `sync_dir` so the caller (Tauri host)
/// can stream events to the frontend and abort mid-flight.
pub struct SyncContext {
    pub on_progress: Box<dyn FnMut(&SyncProgress) + Send>,
    pub cancelled: Arc<AtomicBool>,
}

impl SyncContext {
    pub fn check_cancel(&self) -> Result<(), RemoteError> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err(RemoteError::Cancelled)
        } else {
            Ok(())
        }
    }

    pub fn report(&mut self, p: &SyncProgress) {
        (self.on_progress)(p);
    }

    /// No-op context — for tests and callers that don't care about progress.
    pub fn noop() -> Self {
        Self {
            on_progress: Box::new(|_| {}),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// Abstract remote filesystem capability. `mirror` and `probe` depend on this trait
/// so unit tests can plug in an in-memory implementation without an SSH server.
#[async_trait::async_trait]
pub trait RemoteFs: Send {
    async fn home_dir(&mut self) -> Result<String, RemoteError>;
    async fn metadata(&mut self, path: &str) -> Result<FileMeta, RemoteError>;
    async fn read_dir(&mut self, path: &str) -> Result<Vec<DirEntry>, RemoteError>;
    async fn download(&mut self, remote: &str, local: &std::path::Path) -> Result<u64, RemoteError>;

    /// Run a command on the remote with the given argv (no shell parsing of argv
    /// elements — they are quoted for `sh -c` then passed as a single command
    /// string to the SSH exec channel), feed `stdin`, and return stdout capped
    /// at `max_stdout`. Exceeding the cap or non-zero exit returns
    /// `RemoteError::Exec`. stderr is logged at WARN and not returned.
    ///
    /// Default implementation reports unsupported so existing in-memory
    /// `RemoteFs` test mocks don't have to spell it out when their tests don't
    /// exercise the exec path.
    async fn exec(
        &mut self,
        _argv: &[&str],
        _stdin: &[u8],
        _max_stdout: u64,
    ) -> Result<Vec<u8>, RemoteError> {
        Err(RemoteError::Exec {
            code: -127,
            stderr: "exec not supported by this RemoteFs impl".into(),
        })
    }
}

pub fn cache_root() -> Result<PathBuf, RemoteError> {
    let base = dirs::cache_dir().ok_or_else(|| RemoteError::Config("no cache dir".into()))?;
    Ok(base.join("aaa").join("remotes"))
}

pub fn cache_dir_for(host_id: &str, provider_id: &str) -> Result<PathBuf, RemoteError> {
    Ok(cache_root()?.join(host_id).join(provider_id))
}

/// One existing local cache for a `(remote, provider)` pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteCacheInfo {
    pub provider_id: String,
    pub local_root: String,
    pub last_modified: Option<String>,
    pub size_bytes: u64,
}

/// List the previously-synced caches for `host_id` — one entry per provider
/// with at least one cached file. Used by the UI to offer "open offline" so
/// the user doesn't have to re-sync every time.
pub fn list_caches_for_host(host_id: &str) -> Result<Vec<RemoteCacheInfo>, RemoteError> {
    let host_dir = cache_root()?.join(host_id);
    if !host_dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&host_dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let provider_id = match path.file_name().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let (size, mtime) = dir_size_and_mtime(&path);
        if size == 0 {
            // Empty cache directory — treat as absent so the UI doesn't show
            // a button that opens nothing.
            continue;
        }
        out.push(RemoteCacheInfo {
            provider_id,
            local_root: path.to_string_lossy().into_owned(),
            last_modified: mtime,
            size_bytes: size,
        });
    }
    Ok(out)
}

/// Sum file sizes under `dir` and find the newest mtime as ISO-8601.
/// Symlinks are followed by `walkdir` default; we use file metadata so
/// directories don't double-count.
fn dir_size_and_mtime(dir: &std::path::Path) -> (u64, Option<String>) {
    use chrono::{DateTime, Utc};
    let mut total: u64 = 0;
    let mut newest: Option<std::time::SystemTime> = None;
    for entry in walkdir::WalkDir::new(dir).into_iter().flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_file() {
            total = total.saturating_add(meta.len());
            if let Ok(m) = meta.modified() {
                newest = Some(match newest {
                    Some(prev) if prev > m => prev,
                    _ => m,
                });
            }
        }
    }
    let iso = newest.and_then(|t| {
        let dt: DateTime<Utc> = t.into();
        Some(dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    });
    (total, iso)
}

/// Top-level: connect, probe a single provider, sync its directory to local cache.
pub async fn open_for_provider(
    remote: &RemoteHost,
    provider: &dyn crate::providers::SessionProvider,
    ctx: &mut SyncContext,
) -> Result<RemoteOpenResult, RemoteError> {
    use crate::providers::RemoteSyncStrategy;

    ctx.report(&SyncProgress::new(SyncPhase::Connecting));
    ctx.check_cancel()?;

    let mut kh = known_hosts::KnownHosts::open()?;
    let mut sess = ssh::RemoteSession::connect(remote, &mut kh).await?;

    ctx.check_cancel()?;
    ctx.report(&SyncProgress::new(SyncPhase::Probing));

    let home = sess.home_dir().await?;
    let provider_id = provider.id().to_string();

    let remote_root = match remote.provider_root_overrides.get(&provider_id) {
        Some(p) => Some(p.clone()),
        None => {
            let mut found = None;
            for cand in provider.remote_root_candidates() {
                ctx.check_cancel()?;
                let path = cand.replace("{home}", &home);
                if sess.metadata(&path).await.is_ok() {
                    found = Some(path);
                    break;
                }
            }
            found
        }
    };
    let remote_root = remote_root.ok_or_else(|| RemoteError::ProbeNotFound(provider_id.clone()))?;

    let local_root = cache_dir_for(&remote.id, &provider_id)?;
    std::fs::create_dir_all(&local_root)?;

    // ----- L0: mtime short-circuit (whitelist providers only) -----
    if let Some(files) = provider.remote_sync_files() {
        log::info!(
            "L0 check: provider={} remote_root={} local_root={:?} whitelist={:?}",
            provider_id,
            remote_root,
            local_root,
            files
        );
        if all_files_match(&mut sess, &remote_root, &local_root, &files).await {
            log::info!(
                "L0 short-circuit: all whitelisted files match local for {}@{}",
                provider_id,
                remote.id
            );
            ctx.report(&SyncProgress::new(SyncPhase::UpToDate));
            return Ok(RemoteOpenResult {
                local_root: local_root.to_string_lossy().into_owned(),
                sync_stats: SyncStats::default(),
            });
        }
        log::info!(
            "L0 mismatch for {}@{}: at least one whitelisted file differs (size/mtime); \
             proceeding to L1/L2",
            provider_id,
            remote.id
        );
    } else {
        log::info!(
            "L0 skipped: provider={} has no remote_sync_files whitelist (whole-tree sync provider)",
            provider_id
        );
    }

    // ----- L1/L2: provider-specific incremental strategy -----
    //
    // opencode and its forks (e.g. ngagent) share the same three-table SQLite
    // schema, so we run the same incremental routine against each db that has
    // a local cache copy. Per-db fallback: any db that fails L2 (schema drift,
    // sqlite3 version too old, exec timeout, …) gets byte-synced individually
    // via sync_files, while the others keep their KB-level incremental.
    let strategy = provider.remote_sync_strategy();
    log::info!(
        "sync strategy for provider={}: {:?}",
        provider_id,
        strategy
    );
    if matches!(strategy, RemoteSyncStrategy::OpencodeIncremental) {
        ctx.check_cancel()?;
        ctx.report(&SyncProgress::new(SyncPhase::ProbingRemote));
        let probe_ok = incremental::probe_sqlite3(&mut sess).await;
        log::info!(
            "L1 probe_sqlite3 for {}@{} => {}",
            provider_id,
            remote.id,
            if probe_ok { "available" } else { "UNAVAILABLE (will fall back to L3 full SFTP)" }
        );
        if probe_ok {
            // Every (db_relpath, sidecar_files) bundle the strategy knows about.
            // sidecars are the WAL/SHM that tag along with each db; they don't
            // get incremental treatment but they DO need byte-sync so the cache
            // matches what opencode itself would see on a clean restart.
            const DB_BUNDLES: &[(&str, &[&str])] = &[
                ("opencode.db", &["opencode.db-wal", "opencode.db-shm"]),
                ("db/ngagent.db", &["db/ngagent.db-wal", "db/ngagent.db-shm"]),
            ];

            let mut total = SyncStats::default();
            let mut any_l2_succeeded = false;
            let mut byte_sync_files: Vec<&str> = Vec::new();

            for (db_rel, sidecars) in DB_BUNDLES {
                // Skip dbs whose remote path doesn't exist — neither cache miss
                // nor a real "new" remote, just absent on this host.
                let remote_db_path = format!("{}/{}", remote_root.trim_end_matches('/'), db_rel);
                if sess.metadata(&remote_db_path).await.is_err() {
                    log::info!(
                        "L2 db={}: remote path {} absent on this host, skipping",
                        db_rel,
                        remote_db_path
                    );
                    continue;
                }

                // First sync ever: cache empty → must byte-sync this db (and
                // sidecars) to bootstrap before incremental can run.
                let cache_db_path = local_root.join(db_rel);
                if !cache_db_path.exists() {
                    log::info!(
                        "L2 db={}: cache {:?} missing → bootstrap byte-sync (db + sidecars)",
                        db_rel,
                        cache_db_path
                    );
                    byte_sync_files.push(db_rel);
                    byte_sync_files.extend(sidecars.iter().copied());
                    continue;
                }

                log::info!(
                    "L2 db={}: cache {:?} present → attempting SQL incremental",
                    db_rel,
                    cache_db_path
                );
                match incremental::sync_opencode_incremental(
                    &mut sess,
                    &remote_root,
                    &local_root,
                    db_rel,
                    ctx,
                )
                .await
                {
                    Ok(s) => {
                        any_l2_succeeded = true;
                        total.bytes_pulled = total.bytes_pulled.saturating_add(s.bytes_pulled);
                        log::info!(
                            "L2 db={}: SQL incremental ok ({} bytes pulled); sidecars queued for byte-sync",
                            db_rel,
                            s.bytes_pulled
                        );
                        // Sidecars still need byte-sync (their mtime drives L0
                        // and ensures cache parity with the remote).
                        byte_sync_files.extend(sidecars.iter().copied());
                    }
                    Err(e) => {
                        log::warn!(
                            "L2 failed for {}, falling back to byte-sync for that db: {}",
                            db_rel,
                            e
                        );
                        byte_sync_files.push(db_rel);
                        byte_sync_files.extend(sidecars.iter().copied());
                    }
                }
            }

            if !byte_sync_files.is_empty() {
                log::info!(
                    "byte-sync stage for {}@{}: files={:?}",
                    provider_id,
                    remote.id,
                    byte_sync_files
                );
                match mirror::sync_files(
                    &mut sess,
                    &remote_root,
                    &local_root,
                    &byte_sync_files,
                    ctx,
                )
                .await
                {
                    Ok(extra) => {
                        total.files_pulled = total.files_pulled.saturating_add(extra.files_pulled);
                        total.files_skipped =
                            total.files_skipped.saturating_add(extra.files_skipped);
                        total.files_deleted_locally = total
                            .files_deleted_locally
                            .saturating_add(extra.files_deleted_locally);
                        total.bytes_pulled = total.bytes_pulled.saturating_add(extra.bytes_pulled);
                    }
                    Err(e) => {
                        // If even the byte-level fallback for the remaining
                        // files fails, propagate so the caller surfaces it —
                        // this isn't a "no sqlite3" scenario, it's an SFTP
                        // failure and there's nothing further to fall back to.
                        if !any_l2_succeeded {
                            return Err(e);
                        }
                        log::warn!(
                            "L2 succeeded for at least one db but byte-sync of remaining files failed: {}",
                            e
                        );
                    }
                }
            }

            if any_l2_succeeded || !byte_sync_files.is_empty() {
                log::info!(
                    "L1/L2 finished for {}@{}: any_l2_succeeded={} byte_sync_files_pulled={} bytes_total={}",
                    provider_id,
                    remote.id,
                    any_l2_succeeded,
                    total.files_pulled,
                    total.bytes_pulled
                );
                ctx.report(&SyncProgress {
                    phase: SyncPhase::Done,
                    current_file: None,
                    files_done: total.files_pulled,
                    files_total: total.files_pulled,
                    bytes_done: total.bytes_pulled,
                    bytes_total: total.bytes_pulled,
                });
                return Ok(RemoteOpenResult {
                    local_root: local_root.to_string_lossy().into_owned(),
                    sync_stats: total,
                });
            }
            // Else: no candidate db existed remotely → fall through to L3 to
            // keep the original "missing root" / "empty whitelist" behaviour.
            log::info!(
                "L1/L2 yielded nothing for {}@{} (no candidate dbs existed remotely); \
                 falling through to L3 full SFTP",
                provider_id,
                remote.id
            );
        } else {
            log::info!(
                "L3 entry for {}@{}: remote sqlite3 unavailable, using full SFTP",
                provider_id,
                remote.id
            );
        }
    } else {
        log::info!(
            "L3 entry for {}@{}: provider strategy is Default, using full SFTP",
            provider_id,
            remote.id
        );
    }

    // ----- L3: existing full SFTP path -----
    log::info!(
        "L3 sync starting for {}@{}",
        provider_id,
        remote.id
    );
    let stats = match provider.remote_sync_files() {
        Some(files) => mirror::sync_files(&mut sess, &remote_root, &local_root, &files, ctx).await?,
        None => mirror::sync_dir(&mut sess, &remote_root, &local_root, ctx).await?,
    };

    ctx.report(&SyncProgress {
        phase: SyncPhase::Done,
        current_file: None,
        files_done: stats.files_pulled,
        files_total: stats.files_pulled,
        bytes_done: stats.bytes_pulled,
        bytes_total: stats.bytes_pulled,
    });

    Ok(RemoteOpenResult {
        local_root: local_root.to_string_lossy().into_owned(),
        sync_stats: stats,
    })
}

/// Check (size, mtime) on every whitelisted file. Returns true only when all
/// remote-existing files match local; missing-on-both is also fine. Any IO
/// hiccup or one-sided presence yields false so we fall through to the next
/// layer.
async fn all_files_match(
    fs: &mut dyn RemoteFs,
    remote_root: &str,
    local_root: &std::path::Path,
    files: &[&str],
) -> bool {
    for rel in files {
        let remote_full = format!("{}/{}", remote_root.trim_end_matches('/'), rel);
        let local_path = local_root.join(rel);
        let remote_meta = fs.metadata(&remote_full).await.ok();
        let local_meta = std::fs::metadata(&local_path).ok();
        match (remote_meta, local_meta) {
            (Some(r), Some(l)) if !r.is_dir && l.is_file() => {
                let lmtime = l
                    .modified()
                    .ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                if l.len() != r.size || lmtime != r.mtime {
                    log::info!(
                        "L0 mismatch reason: file {} differs (remote size={} mtime={}, local size={} mtime={})",
                        rel,
                        r.size,
                        r.mtime,
                        l.len(),
                        lmtime
                    );
                    return false;
                }
            }
            (None, None) => continue, // both absent — fine
            (rm, lm) => {
                log::info!(
                    "L0 mismatch reason: file {} one-sided presence (remote_present={} local_present={})",
                    rel,
                    rm.is_some(),
                    lm.is_some()
                );
                return false;
            }
        }
    }
    true
}

/// Top-level: connect and probe all known providers; do not sync.
pub async fn probe_remote(
    remote: &RemoteHost,
    providers: &[Box<dyn crate::providers::SessionProvider>],
) -> Result<Vec<RemoteProviderInfo>, RemoteError> {
    let mut kh = known_hosts::KnownHosts::open()?;
    let mut sess = ssh::RemoteSession::connect(remote, &mut kh).await?;
    let home = sess.home_dir().await?;
    probe::find_roots(&mut sess, &home, remote, providers).await
}
