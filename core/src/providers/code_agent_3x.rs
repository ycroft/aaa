//! Code Agent 3.x provider — reads `~/.cac/projects/<encoded-cwd>/<sessionId>.jsonl`.
//!
//! On-disk format is identical to Claude Code (it's a Claude-Code-compatible
//! client), so all parsing delegates to [`super::anthropic_jsonl`].

use std::path::PathBuf;

use anyhow::Result;

use crate::model::{SessionDetail, SessionSummary};
use crate::providers::{anthropic_jsonl, SessionProvider};
use crate::stats::SkillUsage;

pub struct CodeAgent3xProvider;

const ID: &str = "code-agent-3x";

impl SessionProvider for CodeAgent3xProvider {
    fn id(&self) -> &str {
        ID
    }
    fn display_name(&self) -> &str {
        "Code Agent 3.x"
    }
    fn default_root(&self) -> Option<PathBuf> {
        dirs::home_dir().map(|h| h.join(".cac").join("projects"))
    }
    fn remote_root_candidates(&self) -> Vec<&'static str> {
        vec!["{home}/.cac/projects"]
    }
    fn list_sessions(&self, root: &PathBuf) -> Result<Vec<SessionSummary>> {
        anthropic_jsonl::list_sessions(root, ID)
    }
    fn load_session(&self, source_path: &PathBuf) -> Result<SessionDetail> {
        anthropic_jsonl::load_session(source_path, ID)
    }
    fn skill_usage(&self, detail: &SessionDetail) -> Vec<SkillUsage> {
        anthropic_jsonl::collect_skill_usage(detail)
    }
}
