import type { SessionNode, SkillSource, SkillUsage, SubAgentSession } from "../../types";
import { lookupContextWindow } from "../../model-context";
import { effectiveContextTokens } from "./stats";

const CTX_HOT_PCT = 0.25;
const CTX_HOT_ABS = 5_000;

export type CtxBand = "cool" | "mid" | "warn" | "peak";

export function bandFor(ratio: number): CtxBand {
  if (ratio >= 0.80) return "peak";
  if (ratio >= 0.60) return "warn";
  if (ratio >= 0.40) return "mid";
  return "cool";
}

export interface NodeSkillRef {
  id: string;
  name?: string;
  source: SkillSource;
}

export interface NodeViz {
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
  /** Skills attached to this node — populated from the SkillUsage rows
   *  whose `node_ids` reference this node. Empty when none. */
  skills: NodeSkillRef[];
}

export function buildNodeViz(
  nodes: SessionNode[],
  peakSession: number,
  subagentByToolUseId: Map<string, SubAgentSession>,
  skillsByNodeId: Map<string, NodeSkillRef[]>,
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
      skills: skillsByNodeId.get(n.id) ?? [],
    });

    if (ctx != null && ctx > highest) highest = ctx;
    if (ctx != null && ctx > 0) prevCtx = ctx;
  }

  const toolUniverse = [...universeCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return { byId, toolUniverse };
}

/// Group SkillUsage rows by node_id for fast lookup during NodeViz build.
/// A skill row that lacks `node_ids` (e.g. an Assistant-source row from a
/// pre-1.7 backend) is skipped — there's nothing to attach it to.
export function buildSkillsByNodeId(rows: SkillUsage[]): Map<string, NodeSkillRef[]> {
  const out = new Map<string, NodeSkillRef[]>();
  for (const r of rows) {
    const ids = r.node_ids ?? [];
    if (ids.length === 0) continue;
    const ref: NodeSkillRef = {
      id: r.skill_id,
      name: r.skill_name ?? undefined,
      source: r.source ?? "assistant",
    };
    for (const nid of ids) {
      const arr = out.get(nid);
      if (arr) arr.push(ref);
      else out.set(nid, [ref]);
    }
  }
  return out;
}
