//! Logger initialisation for AAA.
//!
//! Single entry-point [`init`] wires up `log` macros (`info!`, `warn!`, `error!`,
//! `debug!`, `trace!`) to a rolling file under the platform data dir:
//!
//! - Linux/macOS: `~/.local/share/aaa/logs/aaa.log` (or `$XDG_DATA_HOME/aaa/logs/`)
//! - Windows: `%LOCALAPPDATA%\aaa\logs\aaa.log`
//!
//! Rotation: each file rolls at 5 MiB, the most recent 10 segments are kept;
//! older segments are deleted. Disk footprint stays under ~50 MiB.
//!
//! Log level can be overridden at runtime via the `AAA_LOG` env var, e.g.
//! `AAA_LOG=debug` or `AAA_LOG=aaa_core::remote=trace,info`. Default is `info`.
//!
//! `init` is idempotent — the second call returns Ok without re-installing the
//! global logger. This lets tests or repeated host startups call it freely.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{anyhow, Result};
use flexi_logger::{
    Cleanup, Criterion, FileSpec, LogSpecification, Logger, Naming, WriteMode,
};

const LOG_DIR_NAME: &str = "aaa";
const LOG_SUBDIR: &str = "logs";
const LOG_FILE_BASE: &str = "aaa";
const ROTATE_BYTES: u64 = 5 * 1024 * 1024;
const KEEP_LOG_FILES: usize = 10;
const ENV_VAR: &str = "AAA_LOG";

static INITIALISED: AtomicBool = AtomicBool::new(false);

/// Platform-specific log directory. `None` if the OS exposes no data dir
/// (effectively never on the desktop platforms we support).
pub fn log_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(LOG_DIR_NAME).join(LOG_SUBDIR))
}

/// Initialise the global logger. Safe to call more than once — subsequent
/// calls are silently ignored.
///
/// Returns the resolved log directory so the caller can echo it on startup.
pub fn init() -> Result<PathBuf> {
    if INITIALISED.swap(true, Ordering::SeqCst) {
        // Already initialised; just report where logs live.
        return log_dir().ok_or_else(|| anyhow!("no data_local_dir for log path"));
    }

    let dir = log_dir().ok_or_else(|| anyhow!("no data_local_dir for log path"))?;
    std::fs::create_dir_all(&dir)?;

    let spec = LogSpecification::env_or_parse("info")
        .map_err(|e| anyhow!("invalid AAA_LOG spec: {}", e))?;

    Logger::with(spec)
        .log_to_file(
            FileSpec::default()
                .directory(&dir)
                .basename(LOG_FILE_BASE)
                .suppress_timestamp(),
        )
        .append()
        .write_mode(WriteMode::BufferAndFlush)
        .rotate(
            Criterion::Size(ROTATE_BYTES),
            Naming::Numbers,
            Cleanup::KeepLogFiles(KEEP_LOG_FILES),
        )
        .format_for_files(flexi_logger::detailed_format)
        .start()
        .map_err(|e| anyhow!("logger init failed: {}", e))?;

    Ok(dir)
}

/// Override of [`init`] that also mirrors output to stderr. Useful for `cargo run`
/// during development; prefer [`init`] for shipped builds.
pub fn init_with_stderr() -> Result<PathBuf> {
    if INITIALISED.swap(true, Ordering::SeqCst) {
        return log_dir().ok_or_else(|| anyhow!("no data_local_dir for log path"));
    }

    let dir = log_dir().ok_or_else(|| anyhow!("no data_local_dir for log path"))?;
    std::fs::create_dir_all(&dir)?;

    let spec = LogSpecification::env_or_parse("info")
        .map_err(|e| anyhow!("invalid AAA_LOG spec: {}", e))?;

    Logger::with(spec)
        .log_to_file(
            FileSpec::default()
                .directory(&dir)
                .basename(LOG_FILE_BASE)
                .suppress_timestamp(),
        )
        .duplicate_to_stderr(flexi_logger::Duplicate::Info)
        .append()
        .write_mode(WriteMode::BufferAndFlush)
        .rotate(
            Criterion::Size(ROTATE_BYTES),
            Naming::Numbers,
            Cleanup::KeepLogFiles(KEEP_LOG_FILES),
        )
        .format_for_files(flexi_logger::detailed_format)
        .format_for_stderr(flexi_logger::detailed_format)
        .start()
        .map_err(|e| anyhow!("logger init failed: {}", e))?;

    Ok(dir)
}

/// Name of the env var the user can set to control verbosity, exposed for
/// docs / settings UI.
pub const fn env_var_name() -> &'static str {
    ENV_VAR
}
