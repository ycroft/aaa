// TypeScript mirror of the Rust model in `src-tauri/src/model.rs`.

export interface AppInfo {
  name: string;
  version: string;
  author: string;
  description: string;
  release_notes: string;
}

export interface ProviderInfo {
  id: string;
  display_name: string;
  default_root: string | null;
  root_exists: boolean;
  is_implemented: boolean;
}

export interface SessionSummary {
  provider_id: string;
  session_id: string;
  title: string | null;
  cwd: string | null;
  git_branch: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  peak_context_tokens: number;
  source_path: string;
}

export type NodeKind =
  | "user"
  | "assistant"
  | "system"
  | "tool_result"
  | "sidechain"
  | "meta";

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; tool_use_id: string; name: string; input: string }
  | { kind: "tool_result"; tool_use_id: string; content: string; is_error: boolean }
  | { kind: "image"; media_type: string; bytes: number }
  | { kind: "attachment"; path: string; mime: string | null }
  | { kind: "note"; text: string };

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  service_tier: string | null;
  /** Provider-best-effort generation duration. See `core/src/model.rs`. */
  generation_duration_ms?: number | null;
}

export interface SessionNode {
  id: string;
  parent_id: string | null;
  kind: NodeKind;
  timestamp: string | null;
  model: string | null;
  parts: MessagePart[];
  usage: TokenUsage | null;
  cumulative_context_tokens: number | null;
  raw_size_bytes: number;
}

export type SubAgentKind = "normal" | "aside_question" | "compact";

export interface SubAgentSession {
  agent_id: string;
  agent_type: string;
  /** What kind of sub-agent record this is — drives stats roll-up and UI labelling. */
  kind: SubAgentKind;
  /** 1-based ordinal among same-type subagents in this parent session. */
  type_ordinal: number;
  description: string | null;
  /** parent session's `tool_use_id` for the `Agent` call that spawned this. */
  parent_tool_use_id: string | null;
  summary: SessionSummary;
  nodes: SessionNode[];
}

export interface SessionDetail {
  summary: SessionSummary;
  nodes: SessionNode[];
  /** Empty for providers without a sub-agent concept (e.g. opencode). */
  subagents: SubAgentSession[];
  /** Whole-session TPS aggregate. `null` when no qualifying turn was found. */
  tps_session?: TpsMetrics | null;
  /** Per-agent TPS, keyed by `agent_id` ("<main>" for the parent). */
  tps_per_agent?: Record<string, AgentTps>;
}

/** Mirror of `aaa_core::model::TpsMetrics`. `null` mean / median when there
 *  were no qualifying turns; `excluded_count` reflects assistant turns that
 *  *did* have duration data but failed the qualification thresholds. */
export interface TpsMetrics {
  tps_mean: number | null;
  tps_median: number | null;
  sample_count: number;
  total_output_tokens: number;
  total_generation_ms: number;
  excluded_count: number;
}

/** One point on the per-agent TPS curve. `interpolated` flags points where
 *  the underlying turn didn't qualify and we forward-filled from the prior
 *  valid TPS — used by the chart to draw those segments in a muted style. */
export interface TpsSeriesPoint {
  node_id: string;
  tps: number;
  interpolated: boolean;
}

export interface AgentTps {
  metrics: TpsMetrics;
  series: TpsSeriesPoint[];
}

/** Sentinel `agent_id` under which the parent agent's TPS lives in
 *  `SessionDetail.tps_per_agent`. Mirrors `aaa_core::tps::MAIN_AGENT_KEY`. */
export const MAIN_AGENT_KEY = "<main>";

/// One row of the skill-usage report (mirrors `aaa_core::stats::SkillUsage`).
///
/// Phase-1 detection only fires for `claude-code` sessions, where each skill
/// invocation is a structured `tool_use { name: "Skill" }`. For other
/// backends this comes back empty until the heuristic phase-2 detector lands
/// — see `core/src/stats.rs` for the plan.
export interface SkillUsage {
  skill_id: string;
  count: number;
  error_count: number;
  first_at: string | null;
  last_at: string | null;
}

export type AiMode = "none" | "agent" | "api";
export type TemplateScope = "single" | "all";

export interface AgentConfig {
  id: string;
  name: string;
  cmd_template: string;
  is_preset: boolean;
}

export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  scope: TemplateScope;
}

export interface AiSettings {
  mode: AiMode;
  selected_agent: string | null;
  agents: AgentConfig[];
  prompt_templates: PromptTemplate[];
}

export interface AppSettings {
  provider_roots: Record<string, string>;
  remotes: RemoteHostInfo[];
  ai: AiSettings;
  ui: {
    theme: string;
    preview_chars: number;
    auto_expand_threshold_tokens: number;
    /** "auto" follows navigator.language; "zh" / "en" are explicit overrides. */
    language: string;
  };
  hub: HubSettings;
}

export interface HubSettings {
  base_url: string;
  device_id: string;
}

// ---------------- Hub / feedback / update types ----------------

export type HubStatus = "Connected" | "Disconnected";

export type FeedbackCategory = "bug" | "feature" | "question" | "other";
export type FeedbackSeverity = "blocker" | "major" | "minor" | "trivial";

export interface FeedbackAttachmentInput {
  filename: string;
  mime: string;
  bytes_b64: string;
}

export interface FeedbackInput {
  category: FeedbackCategory;
  severity?: FeedbackSeverity;
  title: string;
  description: string;
  contact_email?: string;
  include_version: boolean;
  include_os: boolean;
  include_log_excerpt: boolean;
  include_device_id: boolean;
  attachments: FeedbackAttachmentInput[];
}

export interface LocalTicket {
  id: string;
  claim_token: string;
  title: string;
  category: string;
  created_at: number;
}

export interface LocalTickets {
  items: LocalTicket[];
}

export interface RemoteTicketView {
  status: string;
  admin_note?: string;
  updated_at: number;
}

export interface RemoteHostInfo {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  auth_kind: "password" | "private_key";
  provider_root_overrides: Record<string, string>;
  last_synced_at: string | null;
  host_key_known: boolean;
}

export type RemoteAuthInput =
  | { kind: "password"; password: string }
  | { kind: "private_key"; path: string; passphrase: string | null };

export interface RemoteHostInput {
  id: string | null;
  label: string;
  host: string;
  port: number;
  user: string;
  auth: RemoteAuthInput | null;
  provider_root_overrides: Record<string, string>;
}

export interface RemoteProviderInfo {
  provider_id: string;
  remote_root: string | null;
  exists: boolean;
}

export interface RemoteCacheInfo {
  provider_id: string;
  local_root: string;
  last_modified: string | null;
  size_bytes: number;
}

export interface SyncStats {
  files_pulled: number;
  files_skipped: number;
  files_deleted_locally: number;
  bytes_pulled: number;
  elapsed_ms: number;
}

export interface RemoteOpenResult {
  local_root: string;
  sync_stats: SyncStats;
}

export type SyncPhase =
  | "connecting"
  | "probing"
  | "listing"
  | "downloading"
  | "cleaning"
  | "done"
  | "up_to_date"
  | "probing_remote"
  | "incremental_query"
  | "incremental_apply";

export interface SyncProgress {
  phase: SyncPhase;
  current_file: string | null;
  files_done: number;
  files_total: number;
  bytes_done: number;
  bytes_total: number;
}

/// Event payload emitted from the Tauri side as `remote-progress`.
export interface RemoteProgressEvent {
  task_id: string;
  progress: SyncProgress;
}

// ---- UI-only filter model (not mirrored on the Rust side). ----

export type TimeRangePreset = "all" | "24h" | "1w" | "1m" | "custom";

export interface SessionFilter {
  search: string;
  cwd: string | null;          // null = any cwd
  timePreset: TimeRangePreset;
  customStart: string | null;  // YYYY-MM-DD, only used when timePreset === "custom"
  customEnd: string | null;    // YYYY-MM-DD, inclusive end-of-day
}

export const EMPTY_FILTER: SessionFilter = {
  search: "",
  cwd: null,
  timePreset: "all",
  customStart: null,
  customEnd: null,
};

// ---
// Wire schema source of truth lives in `wire/src/feedback.rs` and
// `wire/src/health.rs`. The TS types above are projections suitable for
// React state — they intentionally drop `schema_version` and other
// transport-only fields. If a new field is added on the wire that the
// UI must surface, mirror it here by hand.
