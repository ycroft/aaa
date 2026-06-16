//! Claude Code provider — reads `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
//!
//! The actual parser lives in [`super::anthropic_jsonl`] and is shared with
//! Code Agent 3.x (and any future Anthropic-protocol client). This file is
//! just the provider-identity shell.

use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::model::{SessionDetail, SessionSummary};
use crate::providers::{anthropic_jsonl, SessionProvider};
use crate::stats::SkillUsage;

pub struct ClaudeCodeProvider;

const ID: &str = "claude-code";

impl SessionProvider for ClaudeCodeProvider {
    fn id(&self) -> &str {
        ID
    }
    fn display_name(&self) -> &str {
        "Claude Code"
    }
    fn default_root(&self) -> Option<PathBuf> {
        dirs::home_dir().map(|h| h.join(".claude").join("projects"))
    }
    fn remote_root_candidates(&self) -> Vec<&'static str> {
        vec!["{home}/.claude/projects"]
    }
    fn list_sessions(&self, root: &PathBuf) -> Result<Vec<SessionSummary>> {
        anthropic_jsonl::list_sessions(root, ID)
    }
    fn load_session(&self, source_path: &PathBuf) -> Result<SessionDetail> {
        anthropic_jsonl::load_session(source_path, ID, &|cwd| self.skill_roots(cwd))
    }
    fn skill_usage(&self, detail: &SessionDetail) -> Vec<SkillUsage> {
        let cwd = detail.summary.cwd.as_deref().map(Path::new);
        let reg = crate::skills::SkillRegistry::build(&self.skill_roots(cwd));
        anthropic_jsonl::collect_skill_usage(detail, &reg)
    }
    fn scan_session_skills(&self, source_path: &Path) -> Result<Vec<String>> {
        anthropic_jsonl::extract_used_skills(source_path, &|cwd| self.skill_roots(cwd))
    }
    fn skill_roots(&self, cwd: Option<&Path>) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Some(home) = dirs::home_dir() {
            out.push(home.join(".claude").join("skills"));
        }
        if let Some(cwd) = cwd {
            out.push(cwd.join(".claude").join("skills"));
        }
        out.retain(|p| p.exists());
        out
    }
}
