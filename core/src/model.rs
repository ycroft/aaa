//! Unified data model shared between providers.
//!
//! Each provider (Claude Code, opencode, …) translates its native log
//! format into the types here. The frontend only sees these.

use serde::{Deserialize, Serialize};

/// A high-level session descriptor — what the session list shows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub provider_id: String,
    pub session_id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub message_count: u32,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    /// Best-known size of the latest context window for this session
    /// (largest input_tokens + cache_* observed across assistant turns).
    pub peak_context_tokens: u64,
    pub source_path: String,
}

/// One node in a session timeline.
///
/// A node represents a logically distinct event:
/// a user prompt, an assistant turn, a tool call, a tool result,
/// a system note, etc. Multiple `MessagePart`s can sit inside one node
/// (e.g. an assistant turn that contains both `thinking` and `tool_use`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: NodeKind,
    pub timestamp: Option<String>,
    pub model: Option<String>,
    pub parts: Vec<MessagePart>,
    pub usage: Option<TokenUsage>,
    /// Cumulative input-token total (running maximum) up to and including this node.
    pub cumulative_context_tokens: Option<u64>,
    pub raw_size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    User,
    Assistant,
    System,
    ToolResult,
    Sidechain,
    Meta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MessagePart {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolUse {
        tool_use_id: String,
        name: String,
        /// Input parameters as pretty-printed JSON for display.
        input: String,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
    Image {
        media_type: String,
        bytes: u64,
    },
    Attachment {
        path: String,
        mime: Option<String>,
    },
    Note {
        text: String,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub service_tier: Option<String>,
}

impl TokenUsage {
    /// "Effective context size" — input plus all cache buckets.
    /// This is what counts against the model's context window for a turn.
    pub fn context_window(&self) -> u64 {
        self.input_tokens + self.cache_creation_input_tokens + self.cache_read_input_tokens
    }
}

/// A complete session: summary + ordered timeline + sub-agent sessions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionDetail {
    pub summary: SessionSummary,
    pub nodes: Vec<SessionNode>,
    /// Sub-agent sessions launched from this session.
    /// Empty for providers that don't have a sub-agent concept (e.g. opencode).
    #[serde(default)]
    pub subagents: Vec<SubAgentSession>,
}

/// A sub-agent session — its own context window, own timeline, anchored to the
/// parent's `Agent` tool_use that spawned it.
///
/// Currently only Claude Code emits these (one file per call under
/// `<sessionId>/subagents/agent-<id>.jsonl`). Nested sub-agents are rare and
/// not modelled yet — see TODO in `claude_code` provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubAgentSession {
    /// Stable id (matches the on-disk `agent-<id>.jsonl` filename without prefix).
    pub agent_id: String,
    /// Agent type label, e.g. "Explore", "general-purpose". From meta.json.
    pub agent_type: String,
    /// What kind of sub-agent file this is. Drives whether stats get rolled
    /// up into the session totals and how the UI labels it.
    #[serde(default)]
    pub kind: SubAgentKind,
    /// 1-based ordinal among sub-agents of the same type within this parent
    /// session. Used in UI labels like "Explore@2".
    pub type_ordinal: u32,
    /// Human-friendly description recorded by the harness when the call was made.
    pub description: Option<String>,
    /// `tool_use_id` of the parent `Agent` tool call that spawned this agent.
    /// Lets the UI attach a "open this sub-agent" button on the right node and
    /// jump back from the sub-agent banner.
    pub parent_tool_use_id: Option<String>,
    /// Self-contained summary (token totals, peak ctx, duration) computed from
    /// this sub-agent's nodes alone.
    pub summary: SessionSummary,
    pub nodes: Vec<SessionNode>,
}

/// The flavour of sub-agent record we found on disk.
///
/// Claude Code writes three kinds of files under `<sessionId>/subagents/`:
///   - `agent-<hex>.jsonl` — a real sub-agent invocation (Task tool).
///   - `agent-aside_question-<hex>.jsonl` — `/aside` command. The user is
///     having a side conversation in the same chat; the sub-jsonl is a
///     sidechain-flagged copy of the *parent* conversation, not new work.
///   - `agent-acompact-<hex>.jsonl` — auto-compact pre-snapshot. Not a real
///     agent; contains the conversation right before context-compaction.
///
/// The UI uses this discriminator to:
///   - Roll up only `Normal` sub-agents into session-wide totals (otherwise
///     `AsideQuestion` records would double-count the parent's own messages).
///   - Tag the row in the agent switcher so the user knows what they're looking at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubAgentKind {
    /// Real sub-agent spawned via the parent's `Agent` tool call.
    Normal,
    /// `/aside` command — the sub-jsonl is a sidechain mirror of the parent.
    AsideQuestion,
    /// Auto-compact snapshot, not a real agent.
    Compact,
}

impl Default for SubAgentKind {
    fn default() -> Self {
        SubAgentKind::Normal
    }
}

/// A backend that can enumerate and load sessions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    pub display_name: String,
    pub default_root: Option<String>,
    pub root_exists: bool,
    pub is_implemented: bool,
}
