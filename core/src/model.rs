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
    /// Skill ids detected on this session (any source — assistant tool_use or
    /// user-text fingerprint match). Sorted, deduped. Populated during the
    /// summary scan; empty/absent on older payloads.
    #[serde(default)]
    pub used_skills: Vec<String>,
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
        ///
        /// Always pure JSON — never includes the tool's stdout/result.
        /// Providers that fold result text into the call (opencode) MUST put
        /// it on `output` instead so downstream parsers (skill detection,
        /// rich-tool detection, search) can `JSON.parse` this directly.
        input: String,
        /// Tool's stdout/result text, when the provider folds the call+result
        /// pair into a single record (opencode). `None` when the provider
        /// emits a separate `ToolResult` part (claude-code).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
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
    /// How long the model spent generating this turn, in milliseconds.
    ///
    /// Provider-specific semantics — both are biased *low* (TPS will read low
    /// vs the model's true streaming rate), but biased the same way so within
    /// a session the relative numbers are comparable:
    ///   - claude-code: `last_block_ts − previous_event_ts`. Includes TTFT,
    ///     network round-trip, and any API-side queue.
    ///   - opencode: `time.completed − time.created`. Includes any tool
    ///     execution that happened inside the same assistant message.
    ///
    /// `None` when the provider couldn't pin down a duration — e.g. the very
    /// first assistant turn in a claude-code session has nothing before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_duration_ms: Option<u64>,
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
    /// Whole-session TPS aggregate (parent + Normal subagents).
    /// `None` when no qualifying assistant turn was found.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tps_session: Option<TpsMetrics>,
    /// Per-agent TPS, keyed by `agent_id` (`"<main>"` for the parent agent).
    /// Includes both metrics and the forward-filled series the UI plots.
    /// Always present (possibly empty).
    #[serde(default)]
    pub tps_per_agent: std::collections::HashMap<String, AgentTps>,
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

/// Aggregate tokens-per-second metrics over a set of assistant turns.
///
/// `tps_mean` is the **arithmetic mean of per-turn TPS values**, not
/// `total_output / total_duration`. The latter is a weighted mean and gets
/// dominated by one super-long turn; the former gives every qualifying turn
/// equal weight, which is what the UI label "average TPS" should mean.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TpsMetrics {
    pub tps_mean: Option<f64>,
    pub tps_median: Option<f64>,
    pub sample_count: u32,
    pub total_output_tokens: u64,
    pub total_generation_ms: u64,
    /// Assistant nodes that *had* `usage` + `generation_duration_ms` but were
    /// rejected by the qualification thresholds (too few tokens or too short
    /// a duration). The UI uses this for an "X / X+Y" sample-size hint.
    pub excluded_count: u32,
}

/// One point on the per-agent TPS curve.
///
/// `tps` is non-zero for every point — when a node fails qualification we
/// forward-fill the previous valid value and set `interpolated = true` so
/// the UI can render that segment in a muted style. The forward-fill avoids
/// the line dropping to zero between qualifying turns.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TpsSeriesPoint {
    pub node_id: String,
    pub tps: f64,
    pub interpolated: bool,
}

/// One agent's TPS rollup — the metrics and the forward-filled curve series.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTps {
    pub metrics: TpsMetrics,
    pub series: Vec<TpsSeriesPoint>,
}
