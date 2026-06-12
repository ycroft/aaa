import type {
  SessionDetail,
  SessionNode,
  SessionSummary,
  TokenUsage,
} from "../../types";

// Effective context window for a turn = new input + cache reads + cache writes.
// Using `input_tokens` alone misreads as "context shrinking" whenever prompt
// caching shifts work between the cached prefix and the live tail.
export function effectiveContextTokens(u: TokenUsage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
}

// Heuristic: a "user interruption" is a user node that immediately follows an
// assistant node (or a tool_result that follows an assistant turn) — i.e. the
// user jumps in to redirect or correct. The very first user turn doesn't count.
// We also skip user nodes whose only `parts` are tool_result echoes, because
// those are tool-driven turns rather than human input.
export function isHumanUserTurn(node: SessionNode): boolean {
  if (node.kind !== "user") return false;
  // Pure tool_result-echo user turns aren't human input.
  const hasHumanPart = node.parts.some((p) =>
    p.kind === "text" || p.kind === "thinking" || p.kind === "image" ||
    p.kind === "attachment" || p.kind === "note"
  );
  return hasHumanPart;
}

// Tool inputs are JSON-pretty-printed by both claude_code and opencode providers.
// opencode additionally folds the tool's stdout/result into the same string with
// a "--- output ---" separator (see core/src/providers/opencode.rs::combine_tool).
const OUTPUT_SEP = "\n\n--- output ---\n";

export function parseToolInput(input: string): { args: any | null; output: string | null } {
  const sep = input.indexOf(OUTPUT_SEP);
  const head = sep >= 0 ? input.slice(0, sep) : input;
  const tail = sep >= 0 ? input.slice(sep + OUTPUT_SEP.length) : null;
  let args: any = null;
  try { args = JSON.parse(head); } catch { /* ignore */ }
  return { args, output: tail };
}

// Pick the first string field that exists. Lets us tolerate the snake_case
// (claude_code) vs camelCase (opencode) divergence without scattering checks.
export function pickStr(obj: any, ...keys: string[]): string | null {
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
export function countReadResultLines(content: string): number {
  if (!content) return 0;
  const numbered = content.match(/^\s*\d+\t/gm);
  if (numbered && numbered.length > 0) return numbered.length;
  return content.split("\n").filter((l) => l.length > 0).length;
}

export function countTextLines(text: string | null | undefined): number {
  if (!text) return 0;
  // Trailing newline shouldn't add a phantom blank line.
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}

export interface AgentStats {
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

// Compute per-agent stats from a (summary, nodes) pair. Used both for the
// parent session and for each subagent session, and aggregated below for the
// session-wide totals.
export function computeAgentStats(
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
export interface SessionTotals {
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

export function computeSessionTotals(detail: SessionDetail): SessionTotals {
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
