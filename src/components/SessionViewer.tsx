import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  MessagePart,
  NodeKind,
  SessionDetail,
  SessionNode,
  SessionSummary,
  SkillUsage,
  SubAgentSession,
  TokenUsage,
} from "../types";
import {
  compactPreview,
  formatDuration,
  formatLocalTime,
  formatPercent,
  formatTokens,
  shortPath,
} from "../format";
import { lookupContextWindow } from "../model-context";
import { api } from "../api";

// Effective context window for a turn = new input + cache reads + cache writes.
// Using `input_tokens` alone misreads as "context shrinking" whenever prompt
// caching shifts work between the cached prefix and the live tail.
function effectiveContextTokens(u: TokenUsage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
}

// Heuristic: a "user interruption" is a user node that immediately follows an
// assistant node (or a tool_result that follows an assistant turn) — i.e. the
// user jumps in to redirect or correct. The very first user turn doesn't count.
// We also skip user nodes whose only `parts` are tool_result echoes, because
// those are tool-driven turns rather than human input.
function isHumanUserTurn(node: SessionNode): boolean {
  if (node.kind !== "user") return false;
  // Pure tool_result-echo user turns aren't human input.
  const hasHumanPart = node.parts.some((p) =>
    p.kind === "text" || p.kind === "thinking" || p.kind === "image" ||
    p.kind === "attachment" || p.kind === "note"
  );
  return hasHumanPart;
}

interface AgentStats {
  messageCount: number;
  durationMs: number | null;
  aiWorkMs: number;
  interruptions: number;
  toolCallTotal: number;
  toolCallByName: Array<[string, number]>;
  filesRead: number;
  linesRead: number;
  filesWritten: number;
  linesWritten: number;
}

// Tool inputs are JSON-pretty-printed by both claude_code and opencode providers.
// opencode additionally folds the tool's stdout/result into the same string with
// a "--- output ---" separator (see core/src/providers/opencode.rs::combine_tool).
const OUTPUT_SEP = "\n\n--- output ---\n";

function parseToolInput(input: string): { args: any | null; output: string | null } {
  const sep = input.indexOf(OUTPUT_SEP);
  const head = sep >= 0 ? input.slice(0, sep) : input;
  const tail = sep >= 0 ? input.slice(sep + OUTPUT_SEP.length) : null;
  let args: any = null;
  try { args = JSON.parse(head); } catch { /* ignore */ }
  return { args, output: tail };
}

// Pick the first string field that exists. Lets us tolerate the snake_case
// (claude_code) vs camelCase (opencode) divergence without scattering checks.
function pickStr(obj: any, ...keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
  }
  return null;
}

// claude_code's Read tool returns `cat -n` style output ("    1\tline\n    2\t…").
// Each numbered line maps to exactly one source line, so counting those prefixes
// is the closest we can get to "lines actually read". When the prefix isn't
// present (other providers / non-Read results), fall back to counting non-empty
// newline-separated lines.
function countReadResultLines(content: string): number {
  if (!content) return 0;
  const numbered = content.match(/^\s*\d+\t/gm);
  if (numbered && numbered.length > 0) return numbered.length;
  return content.split("\n").filter((l) => l.length > 0).length;
}

function countTextLines(text: string | null | undefined): number {
  if (!text) return 0;
  // Trailing newline shouldn't add a phantom blank line.
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}

// Compute per-agent stats from a (summary, nodes) pair. Used both for the
// parent session and for each subagent session, and aggregated below for the
// session-wide totals.
function computeAgentStats(
  summary: SessionSummary,
  nodes: SessionNode[],
): AgentStats {
  // Total wall-clock duration of this agent run.
  let durationMs: number | null = null;
  if (summary.started_at && summary.ended_at) {
    const a = Date.parse(summary.started_at);
    const b = Date.parse(summary.ended_at);
    if (!Number.isNaN(a) && !Number.isNaN(b) && b >= a) durationMs = b - a;
  }

  // Message count = user + assistant nodes. We recount instead of using
  // summary.message_count so the number stays consistent if upstream ever
  // adjusts its counting rule.
  let messageCount = 0;
  for (const n of nodes) {
    if (n.kind === "user" || n.kind === "assistant") messageCount += 1;
  }

  // AI work time: sum of (assistant.ts - prev_event.ts) for each assistant node
  // where the previous event has a timestamp. This captures the time the model
  // was thinking/streaming, and excludes long human idle gaps and tool runtime.
  let aiWorkMs = 0;
  let prevTs: number | null = null;
  for (const n of nodes) {
    const ts = n.timestamp ? Date.parse(n.timestamp) : NaN;
    if (Number.isNaN(ts)) continue;
    if (n.kind === "assistant" && prevTs != null) {
      const gap = ts - prevTs;
      // Cap each gap at 5 minutes to avoid counting overnight idle time as "AI work".
      if (gap > 0) aiWorkMs += Math.min(gap, 5 * 60 * 1000);
    }
    prevTs = ts;
  }

  // User interruptions: human user turns that follow an assistant/tool_result
  // turn. The opening user message doesn't count.
  let interruptions = 0;
  let sawAssistant = false;
  for (const n of nodes) {
    if (n.kind === "assistant" || n.kind === "tool_result") {
      sawAssistant = true;
      continue;
    }
    if (sawAssistant && isHumanUserTurn(n)) {
      interruptions += 1;
      sawAssistant = false; // count one interruption per assistant burst
    }
  }

  // Tool calls — count tool_use parts across all nodes, grouped by tool name.
  // While we're walking, also tally file-IO metrics:
  //   - filesRead / linesRead from Read tool calls and their tool_result.
  //   - filesWritten / linesWritten from Write / Edit / MultiEdit.
  // Files are deduped by path so the count means "distinct files touched".
  const byName = new Map<string, number>();
  let toolCallTotal = 0;
  const readCallIds = new Map<string, string>(); // tool_use_id -> file_path (for pairing with tool_result)
  const filesReadSet = new Set<string>();
  const filesWrittenSet = new Set<string>();
  let linesRead = 0;
  let linesWritten = 0;

  for (const n of nodes) {
    for (const p of n.parts) {
      if (p.kind === "tool_use") {
        toolCallTotal += 1;
        byName.set(p.name, (byName.get(p.name) ?? 0) + 1);

        // claude_code uses snake_case (file_path, old_string, new_string,
        // replace_all, edits) while opencode uses camelCase (filePath,
        // oldString, newString, replaceAll). Tool *names* also differ in case
        // (Read vs read), so we normalize via toLowerCase().
        const lname = p.name.toLowerCase();
        const { args, output } = parseToolInput(p.input);
        const path = pickStr(args, "file_path", "filePath", "path");

        if (lname === "read") {
          if (path) filesReadSet.add(path);
          // Pair claude_code's later tool_result back to this Read by id.
          readCallIds.set(p.tool_use_id, path ?? `__call_${p.tool_use_id}`);
          // opencode merges Read output into the ToolUse string itself
          // (see core/src/providers/opencode.rs::combine_tool); count here.
          if (output != null) linesRead += countReadResultLines(output);
        } else if (lname === "write") {
          if (path) filesWrittenSet.add(path);
          const content = pickStr(args, "content") ?? "";
          linesWritten += countTextLines(content);
        } else if (lname === "edit") {
          if (path) filesWrittenSet.add(path);
          const newStr = pickStr(args, "new_string", "newString") ?? "";
          // replace_all multiplies the diff size by the number of matches in
          // the file, but we don't have the file here. Treat replace_all as a
          // single occurrence — undercounts but never overcounts.
          linesWritten += countTextLines(newStr);
        } else if (lname === "multiedit") {
          // claude_code-only — opencode doesn't model this tool.
          if (path) filesWrittenSet.add(path);
          const edits = Array.isArray(args?.edits) ? args!.edits : [];
          for (const e of edits) {
            const ns = pickStr(e, "new_string", "newString") ?? "";
            linesWritten += countTextLines(ns);
          }
        }
      } else if (p.kind === "tool_result") {
        // claude_code emits ToolResult as a separate part. opencode folds it
        // into the ToolUse above, so this branch is claude_code-only.
        if (readCallIds.has(p.tool_use_id) && !p.is_error) {
          linesRead += countReadResultLines(p.content);
        }
      }
    }
  }
  const toolCallByName = [...byName.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );

  return {
    messageCount,
    durationMs,
    aiWorkMs,
    interruptions,
    toolCallTotal,
    toolCallByName,
    filesRead: filesReadSet.size,
    linesRead,
    filesWritten: filesWrittenSet.size,
    linesWritten,
  };
}

// Session-wide aggregate: parent + Normal subagents only.
//
// AsideQuestion subagents are sidechain copies of the parent conversation —
// rolling them up would double-count parent messages. We surface their count
// separately so the UI can hint that they exist.
//
// Token totals are accumulated from the components themselves (parent's own
// summary plus each Normal subagent's summary) — provider summaries are
// per-file, so without explicit accumulation a session with N subagents would
// under-report tokens.
interface SessionTotals {
  messageCount: number;
  toolCallTotal: number;
  toolCallByName: Array<[string, number]>;
  filesRead: number;
  linesRead: number;
  filesWritten: number;
  linesWritten: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  durationMs: number | null;
  aiWorkMs: number;
  /// Real (Task-spawned) sub-agents.
  subagentCount: number;
  /// `/aside` mirrors — separate from the agent count because they aren't
  /// independent work, just a different view of the parent conversation.
  asideQuestionCount: number;
}

function computeSessionTotals(detail: SessionDetail): SessionTotals {
  const parentStats = computeAgentStats(detail.summary, detail.nodes);
  const byName = new Map<string, number>(parentStats.toolCallByName);

  let messageCount = parentStats.messageCount;
  let toolCallTotal = parentStats.toolCallTotal;
  let filesRead = parentStats.filesRead;
  let linesRead = parentStats.linesRead;
  let filesWritten = parentStats.filesWritten;
  let linesWritten = parentStats.linesWritten;
  let totalInputTokens = detail.summary.total_input_tokens;
  let totalOutputTokens = detail.summary.total_output_tokens;
  let aiWorkMs = parentStats.aiWorkMs;

  let subagentCount = 0;
  let asideQuestionCount = 0;

  for (const sa of detail.subagents) {
    if (sa.kind === "aside_question") {
      asideQuestionCount += 1;
      continue; // mirror of parent — already counted above
    }
    if (sa.kind === "compact") continue; // shouldn't reach here (provider drops these)

    subagentCount += 1;
    const s = computeAgentStats(sa.summary, sa.nodes);
    messageCount += s.messageCount;
    toolCallTotal += s.toolCallTotal;
    filesRead += s.filesRead;
    linesRead += s.linesRead;
    filesWritten += s.filesWritten;
    linesWritten += s.linesWritten;
    totalInputTokens += sa.summary.total_input_tokens;
    totalOutputTokens += sa.summary.total_output_tokens;
    aiWorkMs += s.aiWorkMs;
    for (const [name, cnt] of s.toolCallByName) {
      byName.set(name, (byName.get(name) ?? 0) + cnt);
    }
  }
  const toolCallByName = [...byName.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );

  // Session duration spans parent + subagent timestamps (Normal only).
  let earliest = detail.summary.started_at ? Date.parse(detail.summary.started_at) : NaN;
  let latest = detail.summary.ended_at ? Date.parse(detail.summary.ended_at) : NaN;
  for (const sa of detail.subagents) {
    if (sa.kind !== "normal") continue;
    if (sa.summary.started_at) {
      const t = Date.parse(sa.summary.started_at);
      if (!Number.isNaN(t) && (Number.isNaN(earliest) || t < earliest)) earliest = t;
    }
    if (sa.summary.ended_at) {
      const t = Date.parse(sa.summary.ended_at);
      if (!Number.isNaN(t) && (Number.isNaN(latest) || t > latest)) latest = t;
    }
  }
  const durationMs = !Number.isNaN(earliest) && !Number.isNaN(latest) && latest >= earliest
    ? latest - earliest
    : null;

  return {
    messageCount,
    toolCallTotal,
    toolCallByName,
    filesRead,
    linesRead,
    filesWritten,
    linesWritten,
    totalInputTokens,
    totalOutputTokens,
    durationMs,
    aiWorkMs,
    subagentCount,
    asideQuestionCount,
  };
}

const CTX_HOT_PCT = 0.25;
const CTX_HOT_ABS = 5_000;

type CtxBand = "cool" | "mid" | "warn" | "peak";

function bandFor(ratio: number): CtxBand {
  if (ratio >= 0.80) return "peak";
  if (ratio >= 0.60) return "warn";
  if (ratio >= 0.40) return "mid";
  return "cool";
}

interface NodeViz {
  ctx: number | null;
  delta: number;
  limit: number;
  ratio: number;
  band: CtxBand;
  isHot: boolean;
  isPeak: boolean;
  toolNames: string[];                  // unique, in first-seen order
  toolCounts: Record<string, number>;
  /** Subagent label (e.g. "Explore@1") if this node spawned one. */
  subagentLabel: string | null;
  /** Subagent agent_id if known — lets the chip jump straight in. */
  subagentId: string | null;
}

function buildNodeViz(
  nodes: SessionNode[],
  peakSession: number,
  subagentByToolUseId: Map<string, SubAgentSession>,
): { byId: Map<string, NodeViz>; toolUniverse: Array<{ name: string; count: number }> } {
  const byId = new Map<string, NodeViz>();
  const universeCounts = new Map<string, number>();

  let prevCtx = 0;
  let highest = 0;

  for (const n of nodes) {
    const ctx = n.usage ? effectiveContextTokens(n.usage) : null;
    const limit = lookupContextWindow(n.model) ?? peakSession;
    const ratio = ctx != null && limit > 0 ? Math.min(1, ctx / limit) : 0;
    const band = bandFor(ratio);
    const delta = ctx != null && prevCtx > 0 ? ctx - prevCtx : 0;
    const isHot =
      ctx != null && prevCtx > 0 && (ctx - prevCtx) > Math.max(CTX_HOT_ABS, prevCtx * CTX_HOT_PCT);
    const isPeak = ctx != null && ctx > highest;

    // Per-node tools + subagent attachment.
    const seen = new Map<string, number>();
    let subagentLabel: string | null = null;
    let subagentId: string | null = null;
    for (const p of n.parts) {
      if (p.kind === "tool_use") {
        seen.set(p.name, (seen.get(p.name) ?? 0) + 1);
        const sa = subagentByToolUseId.get(p.tool_use_id);
        if (sa && !subagentLabel) {
          subagentLabel = `${sa.agent_type}@${sa.type_ordinal}`;
          subagentId = sa.agent_id;
        }
      }
    }
    const toolNames = [...seen.keys()];
    const toolCounts: Record<string, number> = {};
    for (const [k, v] of seen) {
      toolCounts[k] = v;
      universeCounts.set(k, (universeCounts.get(k) ?? 0) + v);
    }

    byId.set(n.id, {
      ctx,
      delta,
      limit,
      ratio,
      band,
      isHot,
      isPeak,
      toolNames,
      toolCounts,
      subagentLabel,
      subagentId,
    });

    if (ctx != null && ctx > highest) highest = ctx;
    if (ctx != null && ctx > 0) prevCtx = ctx;
  }

  const toolUniverse = [...universeCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return { byId, toolUniverse };
}

interface Props {
  session: SessionDetail | null;
  loading: boolean;
  error: string | null;
  expandAll: boolean;
  previewChars: number;
  onCounts: (info: ViewerCounts) => void;
}

export interface ViewerCounts {
  totalNodes: number;
  expandedNodes: number;
  peakCtx: number;
}

const KIND_LABEL: Record<NodeKind, string> = {
  user: "USER",
  assistant: "ASSIST",
  system: "SYSTEM",
  tool_result: "RESULT",
  sidechain: "SIDECHAIN",
  meta: "META",
};

function previewOf(node: SessionNode, max: number): string {
  for (const p of node.parts) {
    switch (p.kind) {
      case "text":
      case "thinking":
      case "note":
        if (p.text) return compactPreview(p.text, max);
        break;
      case "tool_use":
        return `→ ${p.name}(${compactPreview(p.input, Math.max(40, max - 20))})`;
      case "tool_result":
        return `← ${compactPreview(p.content, max)}`;
      case "image":
        return `[image ${p.media_type}]`;
      case "attachment":
        return `[attach ${shortPath(p.path, 40)}]`;
    }
  }
  return "(empty)";
}

export function SessionViewer({
  session,
  loading,
  error,
  expandAll,
  previewChars,
  onCounts,
}: Props) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [toolFilter, setToolFilter] = useState<Set<string>>(new Set());
  const [currentUserIdx, setCurrentUserIdx] = useState(-1);
  // null = parent agent active. Otherwise the agent_id of a subagent.
  // TODO(nested-subagents): if subagents ever nest, this becomes a stack.
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  // Where to scroll back to on parent when the user came from a subagent button.
  const [pendingParentScrollTo, setPendingParentScrollTo] = useState<string | null>(null);
  // In-session message search: triggered explicitly via the button / Enter,
  // never on each keystroke (some sessions have thousands of nodes). On a
  // miss the input flashes red until the user edits the term.
  const [messageSearch, setMessageSearch] = useState("");
  const [searchMissed, setSearchMissed] = useState(false);
  const lastSearchHitRef = useRef<{ term: string; nodeId: string } | null>(null);
  const messageSearchInputRef = useRef<HTMLInputElement | null>(null);

  // Skill usage rows fetched from the backend per session.
  // Phase-1: claude-code only — opencode comes back empty (see core/src/stats.rs
  // for the phase-2 heuristic plan that would surface opencode skills too).
  const [skillUsage, setSkillUsage] = useState<SkillUsage[]>([]);

  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Reset per-session state when the source session changes (different file).
  const lastSessionId = useRef<string | null>(null);
  useEffect(() => {
    if (session && session.summary.session_id !== lastSessionId.current) {
      setOverrides({});
      setToolFilter(new Set());
      setCurrentUserIdx(-1);
      setActiveAgentId(null);
      setPendingParentScrollTo(null);
      setMessageSearch("");
      setSearchMissed(false);
      lastSearchHitRef.current = null;
      lastSessionId.current = session.summary.session_id;
    }
  }, [session]);

  // Fetch skill usage when the session changes. Errors are non-fatal — we
  // just hide the metric. Cancellation flag avoids a stale response from a
  // prior session overwriting the current one.
  useEffect(() => {
    if (!session) {
      setSkillUsage([]);
      return;
    }
    const { provider_id, source_path } = session.summary;
    let cancelled = false;
    api
      .sessionSkillUsage(provider_id, source_path)
      .then((rows) => {
        if (!cancelled) setSkillUsage(rows);
      })
      .catch(() => {
        if (!cancelled) setSkillUsage([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const subagents = session?.subagents ?? [];

  // Map the parent's `Agent` tool_use_id → subagent, used both to render the
  // "→ Explore@1" chip on the spawning node and to power agent navigation.
  const subagentByToolUseId = useMemo(() => {
    const m = new Map<string, SubAgentSession>();
    for (const sa of subagents) {
      if (sa.parent_tool_use_id) m.set(sa.parent_tool_use_id, sa);
    }
    return m;
  }, [subagents]);

  // The currently-displayed agent (parent or one of the subagents).
  const activeAgent = useMemo<{
    label: string;
    summary: SessionSummary;
    nodes: SessionNode[];
    subagent: SubAgentSession | null;
  } | null>(() => {
    if (!session) return null;
    if (activeAgentId) {
      const sa = subagents.find((s) => s.agent_id === activeAgentId);
      if (sa) {
        return {
          label: `${sa.agent_type}@${sa.type_ordinal}`,
          summary: sa.summary,
          nodes: sa.nodes,
          subagent: sa,
        };
      }
    }
    return {
      label: "主 Agent",
      summary: session.summary,
      nodes: session.nodes,
      subagent: null,
    };
  }, [session, activeAgentId, subagents]);

  // Reset filters and overrides when switching agents (their node ids are
  // disjoint, so old overrides would never match anyway, but clearing makes
  // the UX feel fresh).
  useEffect(() => {
    setOverrides({});
    setToolFilter(new Set());
    setCurrentUserIdx(-1);
    setMessageSearch("");
    setSearchMissed(false);
    lastSearchHitRef.current = null;
  }, [activeAgentId]);

  const { vizById, toolUniverse } = useMemo(() => {
    if (!activeAgent) {
      return {
        vizById: new Map<string, NodeViz>(),
        toolUniverse: [] as Array<{ name: string; count: number }>,
      };
    }
    const peak = activeAgent.summary.peak_context_tokens || 0;
    // Subagent chip annotation only applies on the parent timeline.
    const map = activeAgent.subagent ? new Map<string, SubAgentSession>() : subagentByToolUseId;
    const { byId, toolUniverse } = buildNodeViz(activeAgent.nodes, peak, map);
    return { vizById: byId, toolUniverse };
  }, [activeAgent, subagentByToolUseId]);

  const peakCtx = activeAgent?.summary.peak_context_tokens ?? 0;

  const counts = useMemo<ViewerCounts>(() => {
    if (!activeAgent) return { totalNodes: 0, expandedNodes: 0, peakCtx: 0 };
    const expandedNodes = activeAgent.nodes.reduce(
      (acc, n) => acc + (overrides[n.id] ?? expandAll ? 1 : 0),
      0,
    );
    return {
      totalNodes: activeAgent.nodes.length,
      expandedNodes,
      peakCtx,
    };
  }, [activeAgent, overrides, expandAll, peakCtx]);

  const agentStats = useMemo<AgentStats | null>(
    () =>
      activeAgent
        ? computeAgentStats(activeAgent.summary, activeAgent.nodes)
        : null,
    [activeAgent],
  );

  const sessionTotals = useMemo<SessionTotals | null>(
    () => (session ? computeSessionTotals(session) : null),
    [session],
  );

  const visibleNodes = useMemo(() => {
    if (!activeAgent) return [] as SessionNode[];
    if (toolFilter.size === 0) return activeAgent.nodes;
    return activeAgent.nodes.filter((n) => {
      const viz = vizById.get(n.id);
      if (!viz) return false;
      for (const t of viz.toolNames) {
        if (toolFilter.has(t)) return true;
      }
      return false;
    });
  }, [activeAgent, vizById, toolFilter]);

  // Indices of visible nodes that count as "human user" turns. Used by the
  // header's USER navigation buttons to jump between human inputs.
  const userIndices = useMemo(() => {
    const out: number[] = [];
    visibleNodes.forEach((n, i) => {
      if (isHumanUserTurn(n)) out.push(i);
    });
    return out;
  }, [visibleNodes]);

  const jumpToUser = (dir: -1 | 1) => {
    if (userIndices.length === 0 || !bodyRef.current) return;
    const body = bodyRef.current;
    const bodyTop = body.getBoundingClientRect().top;
    // Find which user node is currently at/above the top of the viewport.
    let cur = currentUserIdx;
    if (cur < 0) {
      // Derive from scroll position on first use.
      for (let i = userIndices.length - 1; i >= 0; i--) {
        const node = visibleNodes[userIndices[i]];
        const el = body.querySelector<HTMLElement>(`#node-${CSS.escape(node.id)}`);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= bodyTop + 12) { cur = i; break; }
      }
    }
    const targetIdx = dir < 0
      ? Math.max(0, cur <= 0 ? 0 : cur - 1)
      : Math.min(userIndices.length - 1, cur < 0 ? 0 : cur + 1);
    const target = visibleNodes[userIndices[targetIdx]];
    const el = body.querySelector<HTMLElement>(`#node-${CSS.escape(target.id)}`);
    if (el) {
      const elTop = el.getBoundingClientRect().top;
      body.scrollBy({ top: elTop - bodyTop - 8, behavior: "smooth" });
      setCurrentUserIdx(targetIdx);
    }
  };

  // ---- In-session message search ----
  // Concat every text-bearing part on a node so the user can match on tool
  // arguments / paths / chat text alike.
  const nodeHaystack = (node: SessionNode): string => {
    const buf: string[] = [];
    for (const p of node.parts) {
      switch (p.kind) {
        case "text":
        case "thinking":
        case "note":
          if (p.text) buf.push(p.text);
          break;
        case "tool_use":
          buf.push(p.name);
          buf.push(p.input);
          break;
        case "tool_result":
          buf.push(p.content);
          break;
        case "attachment":
          buf.push(p.path);
          if (p.mime) buf.push(p.mime);
          break;
        case "image":
          buf.push(p.media_type);
          break;
      }
    }
    return buf.join("\n");
  };

  // Run the search on demand (button click / Enter). Cycles through hits when
  // the same term is searched repeatedly: each call advances past the last hit.
  const runMessageSearch = () => {
    const term = messageSearch.trim();
    if (!term || visibleNodes.length === 0 || !bodyRef.current) return;
    const needle = term.toLowerCase();
    const last = lastSearchHitRef.current;
    let startIdx = 0;
    if (last && last.term === needle) {
      const lastPos = visibleNodes.findIndex((n) => n.id === last.nodeId);
      if (lastPos >= 0) startIdx = lastPos + 1;
    }
    const total = visibleNodes.length;
    let foundIdx = -1;
    for (let i = 0; i < total; i++) {
      const idx = (startIdx + i) % total;
      const n = visibleNodes[idx];
      if (nodeHaystack(n).toLowerCase().includes(needle)) {
        foundIdx = idx;
        break;
      }
    }
    if (foundIdx < 0) {
      setSearchMissed(true);
      lastSearchHitRef.current = null;
      return;
    }
    setSearchMissed(false);
    const target = visibleNodes[foundIdx];
    lastSearchHitRef.current = { term: needle, nodeId: target.id };
    // Force-expand the matched node so the hit is actually visible.
    setOverrides((o) => ({ ...o, [target.id]: true }));
    requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (!body) return;
      const el = body.querySelector<HTMLElement>(`#node-${CSS.escape(target.id)}`);
      if (!el) return;
      const bodyTop = body.getBoundingClientRect().top;
      const elTop = el.getBoundingClientRect().top;
      body.scrollBy({ top: elTop - bodyTop - 8, behavior: "smooth" });
    });
  };

  // Switch into a sub-agent (called from a node chip or the dropdown).
  // `fromNodeId` is the parent timeline node we're leaving from; we remember
  // it so the "back to parent" banner can scroll the parent timeline back.
  const enterSubagent = (agentId: string, fromNodeId?: string) => {
    setActiveAgentId(agentId);
    if (fromNodeId) setPendingParentScrollTo(fromNodeId);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };

  // Switch back to the parent. If we came from a node chip, scroll back.
  const exitSubagent = () => {
    setActiveAgentId(null);
  };

  // After exiting a subagent, scroll the parent timeline to the originating node.
  useEffect(() => {
    if (activeAgentId !== null) return;
    if (!pendingParentScrollTo || !bodyRef.current) return;
    const body = bodyRef.current;
    // Wait one frame so the parent timeline DOM is mounted.
    requestAnimationFrame(() => {
      const el = body.querySelector<HTMLElement>(`#node-${CSS.escape(pendingParentScrollTo)}`);
      if (el) {
        const bodyTop = body.getBoundingClientRect().top;
        const elTop = el.getBoundingClientRect().top;
        body.scrollBy({ top: elTop - bodyTop - 8, behavior: "smooth" });
      }
      setPendingParentScrollTo(null);
    });
  }, [activeAgentId, pendingParentScrollTo]);

  useEffect(() => onCounts(counts), [counts, onCounts]);

  if (loading) {
    return (
      <div className="empty">
        <div className="big">Loading session…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="empty">
        <div className="big" style={{ color: "var(--error)" }}>Couldn't load session</div>
        <div className="hint selectable">{error}</div>
      </div>
    );
  }
  if (!session || !activeAgent || !sessionTotals || !agentStats) {
    return (
      <div className="empty">
        <div className="big">No session selected</div>
        <div className="hint">
          Pick one from the list on the left. Use{" "}
          <span className="kbd">Ctrl+Alt+F</span> to filter sessions, or{" "}
          <span className="kbd">Ctrl+E</span> to expand all nodes after opening.
        </div>
      </div>
    );
  }

  const sSummary = session.summary;
  const aSummary = activeAgent.summary;
  const inSubagent = activeAgent.subagent != null;

  const sessionAiPctStr = sessionTotals.durationMs != null
    ? formatPercent(sessionTotals.aiWorkMs, sessionTotals.durationMs)
    : "—";

  return (
    <div className="main">
      <div className="session-head">
        <div className="title selectable">{sSummary.title || sSummary.session_id}</div>
        <div className="meta-row">
          <span className="meta-item"><span className="k">会话 ID</span><span className="v mono">{sSummary.session_id}</span></span>
          {sSummary.cwd && <span className="meta-item"><span className="k">工作目录</span><span className="v mono">{sSummary.cwd}</span></span>}
          {sSummary.git_branch && <span className="meta-item"><span className="k">分支</span><span className="v mono">{sSummary.git_branch}</span></span>}
          <span className="meta-item"><span className="k">开始时间</span><span className="v mono">{formatLocalTime(sSummary.started_at)}</span></span>
        </div>

        {/* ---- Session-wide totals (parent + all Normal subagents) ---- */}
        <div className="metric-section">
          <div className="metric-section-label">
            会话总览
            {(sessionTotals.subagentCount > 0 || sessionTotals.asideQuestionCount > 0) && (
              <span className="metric-section-hint">
                {sessionTotals.subagentCount > 0 && <>含 {sessionTotals.subagentCount} 个子代理</>}
                {sessionTotals.subagentCount > 0 && sessionTotals.asideQuestionCount > 0 && <> · </>}
                {sessionTotals.asideQuestionCount > 0 && (
                  <>
                    {sessionTotals.asideQuestionCount} 次 /aside
                    <span className="aside-hint" title="对话使用了 /aside 命令开启旁路话题，与父会话内容重叠，未计入总览数字。">
                      ⓘ
                    </span>
                  </>
                )}
              </span>
            )}
          </div>
          <div className="metric-grid">
            <Metric label="消息数" value={String(sessionTotals.messageCount)} />
            <Metric
              label="工具调用次数"
              value={String(sessionTotals.toolCallTotal)}
              tooltip={renderToolBreakdownTooltip(sessionTotals.toolCallByName)}
            />
            {skillUsage.length > 0 && (
              <Metric
                label="Skill 调用次数"
                value={String(skillUsage.reduce((s, r) => s + r.count, 0))}
                tooltip={renderSkillBreakdownTooltip(skillUsage)}
              />
            )}
            <Metric label="读取文件数" value={String(sessionTotals.filesRead)} />
            <Metric label="读取行数" value={String(sessionTotals.linesRead)} />
            <Metric label="写入文件数" value={String(sessionTotals.filesWritten)} />
            <Metric label="写入行数" value={String(sessionTotals.linesWritten)} />
            <Metric
              label="累计 token (入/出)"
              value={`${formatTokens(sessionTotals.totalInputTokens)} / ${formatTokens(sessionTotals.totalOutputTokens)}`}
            />
            <Metric label="会话持续时间" value={formatDuration(sessionTotals.durationMs)} />
            <Metric label="AI 工作时间" value={formatDuration(sessionTotals.aiWorkMs)} />
            <Metric label="AI 工作时间占比" value={sessionAiPctStr} />
            <Metric label="启动子代理数" value={String(sessionTotals.subagentCount)} />
          </div>
        </div>

        {/* ---- Agent-level stats (current selection only) ---- */}
        <div className={`metric-section agent-section${inSubagent ? " is-subagent" : ""}`}>
          <div className="metric-section-label">
            <span className="agent-section-title">
              {inSubagent ? "🐣 当前子代理" : "当前 Agent"}
            </span>
            {subagents.length > 0 ? (
              <AgentSwitcher
                subagents={subagents}
                activeAgentId={activeAgentId}
                onPick={(agentId) => {
                  if (agentId === null) exitSubagent();
                  else enterSubagent(agentId);
                }}
              />
            ) : (
              <span className="metric-section-hint mono">{activeAgent.label}</span>
            )}
            {inSubagent && activeAgent.subagent?.description && (
              <span className="agent-section-desc" title={activeAgent.subagent.description}>
                {activeAgent.subagent.description}
              </span>
            )}
            {inSubagent && (
              <button
                type="button"
                className="agent-back-btn"
                onClick={exitSubagent}
                title="返回父会话的启动节点"
              >← 返回父会话</button>
            )}
          </div>
          <div className="metric-grid">
            <Metric label="消息数" value={String(agentStats.messageCount)} />
            <Metric label="用户介入次数" value={String(agentStats.interruptions)} />
            <Metric
              label="工具调用次数"
              value={String(agentStats.toolCallTotal)}
              tooltip={renderToolBreakdownTooltip(agentStats.toolCallByName)}
            />
            <Metric label="读取文件数" value={String(agentStats.filesRead)} />
            <Metric label="读取行数" value={String(agentStats.linesRead)} />
            <Metric label="写入文件数" value={String(agentStats.filesWritten)} />
            <Metric label="写入行数" value={String(agentStats.linesWritten)} />
            <Metric label="上下文峰值" value={formatTokens(aSummary.peak_context_tokens)} />
            <Metric label="Agent 持续时间" value={formatDuration(agentStats.durationMs)} />
          </div>
        </div>
      </div>

      <div className="timeline-table">
        <div className="timeline-header">
          <div className="th-left">
            <span className="th-title">消息</span>
            <span className="th-meta">
              {visibleNodes.length} / {activeAgent.nodes.length} 条
            </span>
            <span className="th-user-nav" title="跳转到上一条 / 下一条 USER 消息">
              <button
                type="button"
                className="th-nav-btn"
                onClick={() => jumpToUser(-1)}
                disabled={userIndices.length === 0}
                title="上一条 USER"
                aria-label="上一条 USER"
              >↑ USER</button>
              <button
                type="button"
                className="th-nav-btn"
                onClick={() => jumpToUser(1)}
                disabled={userIndices.length === 0}
                title="下一条 USER"
                aria-label="下一条 USER"
              >USER ↓</button>
              <span className="th-meta">{currentUserIdx >= 0 ? `${currentUserIdx + 1}/` : ""}{userIndices.length}</span>
            </span>
            <span className="th-msg-search">
              <input
                ref={messageSearchInputRef}
                className={`th-search-input${searchMissed ? " missed" : ""}`}
                placeholder="搜索消息… (Ctrl+F)"
                value={messageSearch}
                onChange={(e) => {
                  setMessageSearch(e.target.value);
                  if (searchMissed) setSearchMissed(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    runMessageSearch();
                  }
                }}
                aria-label="在当前会话中搜索消息"
              />
              <button
                type="button"
                className="th-nav-btn"
                onClick={runMessageSearch}
                disabled={messageSearch.trim().length === 0}
                title="在当前会话中搜索（点击或 Enter）"
                aria-label="搜索消息"
              >🔍</button>
            </span>
          </div>
          <div className="th-right">
            <span className="th-title">上下文 · 工具</span>
            <ToolFilterDropdown
              universe={toolUniverse}
              selected={toolFilter}
              onChange={setToolFilter}
            />
          </div>
        </div>
        <div className="timeline-body" ref={bodyRef}>
        {visibleNodes.map((n) => {
          const expanded = overrides[n.id] ?? expandAll;
          const viz = vizById.get(n.id);
          const isPeak = !!viz?.isPeak;
          const isHot = !!viz?.isHot;
          const hasSubagent = !!viz?.subagentLabel;
          const outStr = n.usage?.output_tokens != null
            ? formatTokens(n.usage.output_tokens)
            : "—";
          return (
            <div
              key={n.id}
              id={`node-${n.id}`}
              className={`node${isHot ? " hot" : ""}${isPeak ? " peak" : ""}${hasSubagent ? " has-subagent" : ""}`}
              data-hint={`Node ${n.id} · ${n.kind}`}
            >
              <div className="node-main">
                <div
                  className="node-head"
                  onClick={() =>
                    setOverrides((o) => ({ ...o, [n.id]: !(o[n.id] ?? expandAll) }))
                  }
                >
                  <div className="chev">{expanded ? "▾" : "▸"}</div>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", overflow: "hidden" }}>
                    <span className={`badge ${n.kind}`}>{KIND_LABEL[n.kind]}</span>
                    {!expanded && (
                      <span className="preview">{previewOf(n, previewChars)}</span>
                    )}
                    {expanded && n.model && (
                      <span className="tag">{n.model}</span>
                    )}
                  </div>
                  <div className="stats">
                    {n.usage && (
                      <>
                        <span title="Output tokens this turn">out {outStr}</span>
                        {(n.usage.cache_read_input_tokens > 0 || n.usage.cache_creation_input_tokens > 0) && (
                          <span title="cache_read / cache_create tokens">
                            ⇣ {formatTokens(n.usage.cache_read_input_tokens)}
                            {" "}+ {formatTokens(n.usage.cache_creation_input_tokens)}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  <div className="ts">
                    {n.timestamp ? formatLocalTime(n.timestamp).slice(11) : ""}
                  </div>
                </div>
                {expanded && (
                  <div className="node-body selectable">
                    {n.parts.map((p, i) => (
                      <PartView key={i} part={p} kind={n.kind} />
                    ))}
                  </div>
                )}
              </div>
              <div className="node-side">
                <CtxBar viz={viz} />
                <ToolChips
                  viz={viz}
                  onPick={(name) => setToolFilter(new Set([name]))}
                  onEnterSubagent={(agentId) => enterSubagent(agentId, n.id)}
                />
              </div>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}

function CtxBar({ viz }: { viz: NodeViz | undefined }) {
  if (!viz || viz.ctx == null) return null;
  const pct = Math.round(viz.ratio * 100);
  const limitTitle = `100% = ${formatTokens(viz.limit)}${
    viz.limit === 0 ? "" : ""
  }`;
  return (
    <div className="node-ctx" title={limitTitle}>
      <div className="ctx-bar">
        <div
          className={`ctx-fill ${viz.band}`}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
      <div className="ctx-meta">
        <span className="num">{formatTokens(viz.ctx)}</span>
        {viz.delta !== 0 && (
          <span className={`delta${viz.isHot ? " warn" : ""}`}>
            ({viz.delta > 0 ? "+" : "−"}{formatTokens(Math.abs(viz.delta))}
            {" "}{viz.delta > 0 ? "↑" : "↓"})
          </span>
        )}
        <span className="pct">{pct}%</span>
      </div>
    </div>
  );
}

const TOOL_CHIPS_VISIBLE = 4;

function ToolChips({
  viz,
  onPick,
  onEnterSubagent,
}: {
  viz: NodeViz | undefined;
  onPick: (name: string) => void;
  onEnterSubagent: (agentId: string) => void;
}) {
  if (!viz || (viz.toolNames.length === 0 && !viz.subagentLabel)) return null;
  const names = viz.toolNames;
  const visible = names.slice(0, TOOL_CHIPS_VISIBLE);
  const hidden = names.slice(TOOL_CHIPS_VISIBLE);
  return (
    <div className="node-tools">
      {/* Subagent chip — rendered first so it's the most prominent affordance.
          Stays on the same row as tool chips to keep node-side at 2 rows. */}
      {viz.subagentLabel && viz.subagentId && (
        <span
          className="tool-chip subagent"
          title={`进入子代理 ${viz.subagentLabel}`}
          onClick={(e) => {
            e.stopPropagation();
            onEnterSubagent(viz.subagentId!);
          }}
        >
          <span>🐣 {viz.subagentLabel}</span>
        </span>
      )}
      {visible.map((name) => {
        const count = viz.toolCounts[name] ?? 1;
        return (
          <span
            key={name}
            className="tool-chip"
            title={`仅看含 ${name} 的行`}
            onClick={(e) => {
              e.stopPropagation();
              onPick(name);
            }}
          >
            <span>{name}</span>
            {count > 1 && <span className="count">×{count}</span>}
          </span>
        );
      })}
      {hidden.length > 0 && (
        <span
          className="tool-chip more"
          title={hidden.join(", ")}
        >+{hidden.length}</span>
      )}
    </div>
  );
}

function AgentSwitcher({
  subagents,
  activeAgentId,
  onPick,
}: {
  subagents: SubAgentSession[];
  activeAgentId: string | null;
  onPick: (agentId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const triggerLabel = activeAgentId
    ? (() => {
        const sa = subagents.find((s) => s.agent_id === activeAgentId);
        return sa ? `🐣 ${sa.agent_type}@${sa.type_ordinal}` : "🐣 子代理";
      })()
    : "主 Agent";

  const pick = (next: string | null) => {
    onPick(next);
    setOpen(false);
  };

  return (
    <div className="agent-switcher" ref={rootRef}>
      <button
        type="button"
        className={`agent-switcher-trigger${activeAgentId ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="切换查看的 Agent"
      >
        Agent · <span className="cur">{triggerLabel}</span> ▾
      </button>
      {open && (
        <div className="agent-switcher-menu" role="menu">
          <div
            className={`agent-switcher-item${activeAgentId === null ? " selected" : ""}`}
            role="menuitemradio"
            aria-checked={activeAgentId === null}
            onClick={() => pick(null)}
          >
            <span className="dot">{activeAgentId === null ? "●" : "○"}</span>
            <span className="name">主 Agent</span>
          </div>
          {subagents.map((sa) => {
            const sel = activeAgentId === sa.agent_id;
            const aside = sa.kind === "aside_question";
            return (
              <div
                key={sa.agent_id}
                className={`agent-switcher-item${sel ? " selected" : ""}${aside ? " aside" : ""}`}
                role="menuitemradio"
                aria-checked={sel}
                onClick={() => pick(sa.agent_id)}
                title={
                  aside
                    ? "由 /aside 命令开启的旁路对话 — 内容与父会话重叠，仅供查看"
                    : sa.description ?? ""
                }
              >
                <span className="dot">{sel ? "●" : "○"}</span>
                <span className="name mono">{sa.agent_type}@{sa.type_ordinal}</span>
                {aside && <span className="kind-tag">aside</span>}
                {sa.description && (
                  <span className="desc">{truncate(sa.description, 36)}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function ToolFilterDropdown({
  universe,
  selected,
  onChange,
}: {
  universe: Array<{ name: string; count: number }>;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange(next);
  };

  const label = selected.size === 0
    ? "🔧 工具 ▾"
    : `🔧 ${selected.size} 项 ▾`;

  return (
    <div className="tool-filter" ref={rootRef}>
      <button
        type="button"
        className={`tool-filter-trigger${selected.size > 0 ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="按工具名过滤"
      >
        {label}
      </button>
      {open && (
        <div className="tool-filter-menu" role="menu">
          {universe.length === 0 && (
            <div className="tool-filter-item" style={{ opacity: 0.6 }}>
              <span className="name">本会话无工具调用</span>
            </div>
          )}
          {universe.map(({ name, count }) => {
            const checked = selected.has(name);
            return (
              <div
                key={name}
                className="tool-filter-item"
                onClick={() => toggle(name)}
                role="menuitemcheckbox"
                aria-checked={checked}
              >
                <span>{checked ? "☑" : "☐"}</span>
                <span className="name">{name}</span>
                <span className="count">{count}</span>
              </div>
            );
          })}
          {universe.length > 0 && (
            <div className="tool-filter-actions">
              <button onClick={() => onChange(new Set(universe.map((u) => u.name)))}>全选</button>
              <button onClick={() => onChange(new Set())}>清空</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: string;
  tooltip?: ReactNode;
}) {
  return (
    <div className={`metric${tooltip ? " has-tooltip" : ""}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {tooltip && <div className="metric-tooltip">{tooltip}</div>}
    </div>
  );
}

// Renders a tool-breakdown table inside a Metric tooltip (used by both the
// session-totals "工具调用次数" and the agent-level one).
function renderToolBreakdownTooltip(
  byName: Array<[string, number]>,
): ReactNode {
  if (byName.length === 0) return <span className="metric-tooltip-empty">无工具调用</span>;
  return (
    <table className="metric-tooltip-table">
      <tbody>
        {byName.map(([name, count]) => (
          <tr key={name}>
            <td className="name">{name}</td>
            <td className="count">{count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Per-skill breakdown for the "Skill 调用次数" tooltip. Rows are already sorted
// by count desc on the Rust side (see core/src/stats.rs::skill_usage). When a
// skill had any error, append "·err N" to its count cell so it stands out.
function renderSkillBreakdownTooltip(rows: SkillUsage[]): ReactNode {
  if (rows.length === 0) return <span className="metric-tooltip-empty">无 Skill 调用</span>;
  return (
    <table className="metric-tooltip-table">
      <tbody>
        {rows.map((r) => (
          <tr key={r.skill_id}>
            <td className="name">{r.skill_id}</td>
            <td className="count">
              {r.count}
              {r.error_count > 0 ? ` · err ${r.error_count}` : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PartView({ part, kind }: { part: MessagePart; kind: NodeKind }) {
  switch (part.kind) {
    case "text": {
      const cls = kind === "assistant" ? "part assistant-text" : "part text";
      return (
        <div className={cls}>
          <div className="label">{kind === "assistant" ? "Assistant" : "Text"}</div>
          <div className="text-body">{part.text}</div>
        </div>
      );
    }
    case "thinking":
      return (
        <div className="part thinking">
          <div className="label">Thinking</div>
          <div className="text-body">{part.text}</div>
        </div>
      );
    case "tool_use":
      return (
        <div className="part tool_use">
          <div className="label">
            Tool call <span className="name">{part.name}</span>
            <span className="tag" style={{ marginLeft: 8 }}>{part.tool_use_id.slice(0, 12)}</span>
          </div>
          <pre className="body">{part.input}</pre>
        </div>
      );
    case "tool_result":
      return (
        <div className={`part tool_result${part.is_error ? " error" : ""}`}>
          <div className="label">
            Tool result {part.is_error && <span style={{ color: "var(--error)" }}>· error</span>}
            <span className="tag" style={{ marginLeft: 8 }}>{part.tool_use_id.slice(0, 12)}</span>
          </div>
          <pre className="body">{part.content}</pre>
        </div>
      );
    case "image":
      return (
        <div className="part note">
          <div className="label">Image</div>
          <div className="text-body">{part.media_type} ({part.bytes}B)</div>
        </div>
      );
    case "attachment":
      return (
        <div className="part note">
          <div className="label">Attachment</div>
          <div className="text-body">{part.path}{part.mime ? ` · ${part.mime}` : ""}</div>
        </div>
      );
    case "note":
      return (
        <div className="part note">
          <div className="label">System</div>
          <div className="text-body">{part.text}</div>
        </div>
      );
  }
}
