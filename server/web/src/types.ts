// Mirror of core/src/model.rs — keep in sync with src/types.ts in the desktop client.

export interface WebUser { user_id: string; display_name: string; is_admin: boolean; }
export interface WebSessionMeta {
  id: string; imported_at: number; provider_id: string; session_id: string;
  import_source: string; summary: SessionSummary;
}
export interface ReleaseItem { version: string; msi_url: string; nsis_url: string; }
export interface FeedbackItem {
  id: string; status: string; category: string; severity?: string;
  title: string; description: string; contact_email?: string;
  app_version: string; os_info: string; device_id: string;
  admin_note?: string; created_at: number; updated_at: number;
}

// --- Session data model (matches desktop src/types.ts exactly) ---

export interface SessionSummary {
  provider_id: string; session_id: string; title: string | null;
  cwd: string | null; git_branch: string | null;
  started_at: string | null; ended_at: string | null;
  message_count: number; total_input_tokens: number; total_output_tokens: number;
  peak_context_tokens: number; source_path: string; used_skills?: string[];
}

export type NodeKind = "user" | "assistant" | "system" | "tool_result" | "sidechain" | "meta";

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; tool_use_id: string; name: string; input: string; output?: string | null }
  | { kind: "tool_result"; tool_use_id: string; content: string; is_error: boolean }
  | { kind: "image"; media_type: string; bytes: number }
  | { kind: "attachment"; path: string; mime: string | null }
  | { kind: "note"; text: string };

export interface TokenUsage {
  input_tokens: number; output_tokens: number;
  cache_creation_input_tokens: number; cache_read_input_tokens: number;
  service_tier: string | null; generation_duration_ms?: number | null;
}

export interface SessionNode {
  id: string; parent_id: string | null; kind: NodeKind;
  timestamp: string | null; model: string | null;
  parts: MessagePart[]; usage: TokenUsage | null;
  cumulative_context_tokens: number | null; raw_size_bytes: number;
}

export type SubAgentKind = "normal" | "aside_question" | "compact";

export interface SubAgentSession {
  agent_id: string; agent_type: string; kind: SubAgentKind;
  type_ordinal: number; description: string | null;
  parent_tool_use_id: string | null; summary: SessionSummary; nodes: SessionNode[];
}

export interface SessionDetail {
  summary: SessionSummary; nodes: SessionNode[];
  subagents: SubAgentSession[];
  tps_session?: TpsMetrics | null;
  tps_per_agent?: Record<string, AgentTps>;
}

export interface TpsMetrics {
  tps_mean: number | null; tps_median: number | null;
  sample_count: number; total_output_tokens: number;
  total_generation_ms: number; excluded_count: number;
}

export interface TpsSeriesPoint { node_id: string; tps: number; interpolated: boolean; }
export interface AgentTps { metrics: TpsMetrics; series: TpsSeriesPoint[]; }

export const MAIN_AGENT_KEY = "<main>";

export type SkillSource = "user" | "assistant";
export interface SkillUsage {
  skill_id: string; skill_name?: string | null; source?: SkillSource;
  count: number; error_count: number;
  first_at: string | null; last_at: string | null; node_ids?: string[];
}
