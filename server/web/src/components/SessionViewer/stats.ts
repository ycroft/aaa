import type {
  MessagePart,
  SessionDetail,
  SessionNode,
  SessionSummary,
  TokenUsage,
} from "../../types";

export function effectiveContextTokens(u: TokenUsage): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
}

export function isHumanUserTurn(node: SessionNode): boolean {
  if (node.kind !== "user") return false;
  const hasHumanPart = node.parts.some((p) =>
    p.kind === "text" || p.kind === "thinking" || p.kind === "image" ||
    p.kind === "attachment" || p.kind === "note"
  );
  return hasHumanPart;
}

export function parseToolInput(
  part: Extract<MessagePart, { kind: "tool_use" }>,
): { args: any | null; output: string | null } {
  let args: any = null;
  try { args = JSON.parse(part.input); } catch { /* ignore */ }
  return { args, output: part.output ?? null };
}

export function pickStr(obj: any, ...keys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
  }
  return null;
}

export function countReadResultLines(content: string): number {
  if (!content) return 0;
  const numbered = content.match(/^\s*\d+\t/gm);
  if (numbered && numbered.length > 0) return numbered.length;
  return content.split("\n").filter((l) => l.length > 0).length;
}

export function countTextLines(text: string | null | undefined): number {
  if (!text) return 0;
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
  filesReadList: string[];
  linesRead: number;
  filesWritten: number;
  filesWrittenList: string[];
  linesWritten: number;
}

export function computeAgentStats(
  summary: SessionSummary,
  nodes: SessionNode[],
): AgentStats {
  let durationMs: number | null = null;
  if (summary.started_at && summary.ended_at) {
    const a = Date.parse(summary.started_at);
    const b = Date.parse(summary.ended_at);
    if (!Number.isNaN(a) && !Number.isNaN(b) && b >= a) durationMs = b - a;
  }

  let messageCount = 0;
  for (const n of nodes) {
    if (n.kind === "user" || n.kind === "assistant") messageCount += 1;
  }

  let aiWorkMs = 0;
  let prevTs: number | null = null;
  for (const n of nodes) {
    const ts = n.timestamp ? Date.parse(n.timestamp) : NaN;
    if (Number.isNaN(ts)) continue;
    if (n.kind === "assistant" && prevTs != null) {
      const gap = ts - prevTs;
      if (gap > 0) aiWorkMs += Math.min(gap, 5 * 60 * 1000);
    }
    prevTs = ts;
  }

  let interruptions = 0;
  let sawAssistant = false;
  for (const n of nodes) {
    if (n.kind === "assistant" || n.kind === "tool_result") {
      sawAssistant = true;
      continue;
    }
    if (sawAssistant && isHumanUserTurn(n)) {
      interruptions += 1;
      sawAssistant = false;
    }
  }

  const byName = new Map<string, number>();
  let toolCallTotal = 0;
  const readCallIds = new Map<string, string>();
  const filesReadSet = new Set<string>();
  const filesWrittenSet = new Set<string>();
  let linesRead = 0;
  let linesWritten = 0;

  for (const n of nodes) {
    for (const p of n.parts) {
      if (p.kind === "tool_use") {
        toolCallTotal += 1;
        byName.set(p.name, (byName.get(p.name) ?? 0) + 1);
        const lname = p.name.toLowerCase();
        const { args, output } = parseToolInput(p);
        const path = pickStr(args, "file_path", "filePath", "path");
        if (lname === "read") {
          if (path) filesReadSet.add(path);
          readCallIds.set(p.tool_use_id, path ?? `__call_${p.tool_use_id}`);
          if (output != null) linesRead += countReadResultLines(output);
        } else if (lname === "write") {
          if (path) filesWrittenSet.add(path);
          const content = pickStr(args, "content") ?? "";
          linesWritten += countTextLines(content);
        } else if (lname === "edit") {
          if (path) filesWrittenSet.add(path);
          const newStr = pickStr(args, "new_string", "newString") ?? "";
          linesWritten += countTextLines(newStr);
        } else if (lname === "multiedit") {
          if (path) filesWrittenSet.add(path);
          const edits = Array.isArray(args?.edits) ? args!.edits : [];
          for (const e of edits) {
            const ns = pickStr(e, "new_string", "newString") ?? "";
            linesWritten += countTextLines(ns);
          }
        }
      } else if (p.kind === "tool_result") {
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
    filesReadList: [...filesReadSet],
    linesRead,
    filesWritten: filesWrittenSet.size,
    filesWrittenList: [...filesWrittenSet],
    linesWritten,
  };
}

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
  subagentCount: number;
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
      continue;
    }
    if (sa.kind === "compact") continue;

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
