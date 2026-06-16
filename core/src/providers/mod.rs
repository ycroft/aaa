//! Provider trait + registry.
//!
//! Each backend (Claude Code, opencode, …) implements [`SessionProvider`].
//! New providers can be added without touching the frontend or commands.

use std::path::{Path, PathBuf};

use crate::model::{ProviderInfo, SessionDetail, SessionSummary};
use crate::stats::SkillUsage;

/// How `open_for_provider` should sync this provider's data from a remote host.
/// Lets providers opt into custom sync paths without the dispatcher having to
/// `match provider_id` strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteSyncStrategy {
    /// Use the existing whitelist-or-mirror sync (`mirror::sync_files` /
    /// `mirror::sync_dir`).
    Default,
    /// opencode-specific row-level incremental sync (with full-SFTP fallback).
    OpencodeIncremental,
}

pub trait SessionProvider: Send + Sync {
    fn id(&self) -> &str;
    fn display_name(&self) -> &str;

    /// Default location of this provider's logs on the current platform.
    /// `None` means the user must configure one.
    fn default_root(&self) -> Option<PathBuf>;

    /// Whether sessions can actually be loaded by this provider on this build.
    /// A stub provider can return `false` so the UI shows it greyed out.
    fn is_implemented(&self) -> bool {
        true
    }

    /// Remote default root candidates; `{home}` is replaced with the remote `$HOME`.
    fn remote_root_candidates(&self) -> Vec<&'static str> {
        Vec::new()
    }

    /// Files (relative to the remote root) the provider actually needs synced.
    /// `None` (default) = mirror the whole tree. `Some(list)` = only stat/pull
    /// these names; missing entries are silently skipped (e.g. SQLite -wal/-shm
    /// only exist while the DB is being written).
    fn remote_sync_files(&self) -> Option<Vec<&'static str>> {
        None
    }

    /// Skill-usage extraction. Default returns empty — providers that emit
    /// structured `name == "Skill"` tool_use records override this to do
    /// the real collection (typically delegating to a shared helper).
    fn skill_usage(&self, _detail: &SessionDetail) -> Vec<SkillUsage> {
        Vec::new()
    }

    /// Roots to scan for `<root>/<id>/SKILL.md` fingerprints. Default empty
    /// (no fingerprint detection). `cwd` is the session's working directory
    /// when known — providers use it to look up project-level skills (e.g.
    /// `<cwd>/.opencode/skills`).
    ///
    /// Implementations should filter out non-existent paths so callers don't
    /// have to. Order matters when there are duplicates: the registry keeps
    /// the first occurrence wins, so put the most authoritative root first.
    fn skill_roots(&self, _cwd: Option<&Path>) -> Vec<PathBuf> {
        Vec::new()
    }

    /// Sync strategy applied by `remote::open_for_provider`. Default = whatever
    /// the existing `mirror::sync_files`/`sync_dir` flow would do.
    fn remote_sync_strategy(&self) -> RemoteSyncStrategy {
        RemoteSyncStrategy::Default
    }

    fn list_sessions(&self, root: &PathBuf) -> anyhow::Result<Vec<SessionSummary>>;

    fn load_session(&self, source_path: &PathBuf) -> anyhow::Result<SessionDetail>;
}

pub fn info_of(p: &dyn SessionProvider, override_root: Option<&PathBuf>) -> ProviderInfo {
    let root = override_root.cloned().or_else(|| p.default_root());
    let root_exists = root.as_ref().map(|p| p.exists()).unwrap_or(false);
    ProviderInfo {
        id: p.id().to_string(),
        display_name: p.display_name().to_string(),
        default_root: root.map(|p| p.to_string_lossy().to_string()),
        root_exists,
        is_implemented: p.is_implemented(),
    }
}

pub mod anthropic_jsonl;
pub mod claude_code;
pub mod code_agent_3x;
pub mod opencode;

pub fn all() -> Vec<Box<dyn SessionProvider>> {
    vec![
        Box::new(claude_code::ClaudeCodeProvider),
        Box::new(code_agent_3x::CodeAgent3xProvider),
        Box::new(opencode::OpencodeProvider),
    ]
}

pub fn find(id: &str) -> Option<Box<dyn SessionProvider>> {
    all().into_iter().find(|p| p.id() == id)
}
