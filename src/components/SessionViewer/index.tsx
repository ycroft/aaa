import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  NodeKind,
  SessionDetail,
  SessionNode,
  SubAgentSession,
} from "../../types";
import { MAIN_AGENT_KEY } from "../../types";
import {
  compactPreview,
  formatDuration,
  formatLocalTime,
  formatPercent,
  formatTokens,
  formatTps,
  shortPath,
} from "../../format";
import { useT } from "../../i18n";

import { computeAgentStats, computeSessionTotals, isHumanUserTurn } from "./stats";
import { buildNodeViz, type NodeViz } from "./viz";
import { useMessageSearch } from "./hooks/useMessageSearch";
import { useSkillUsage } from "./hooks/useSkillUsage";

import { AgentSwitcher } from "./parts/AgentSwitcher";
import { CtxBar } from "./parts/CtxBar";
import { Metric } from "./parts/Metric";
import { PartView } from "./parts/PartView";
import { ToolChips } from "./parts/ToolChips";
import { ToolFilterDropdown } from "./parts/ToolFilterDropdown";
import {
  ToolBreakdownTooltip,
  SkillBreakdownTooltip,
  FileListTooltip,
  CtxCurveTooltip,
  TpsCurveTooltip,
} from "./parts/Tooltips";
import { SearchHighlightProvider } from "./parts/Highlight";

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

const KIND_LABEL_KEYS: Record<NodeKind, "user" | "assistant" | "system" | "tool_result" | "sidechain" | "meta"> = {
  user: "user",
  assistant: "assistant",
  system: "system",
  tool_result: "tool_result",
  sidechain: "sidechain",
  meta: "meta",
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

// Compact descriptor for the TPS chip's hover. Shows sample size, median,
// and the totals so the user can sanity-check what the average is built on
// — and renders the empty hint when no turn qualified.
function TpsTooltip({
  metrics,
}: {
  metrics: import("../../types").TpsMetrics | null | undefined;
}) {
  const t = useT();
  if (!metrics || metrics.sample_count === 0) {
    return (
      <span className="metric-tooltip-empty">
        {t("viewer.timeline.tps_tooltip_empty")}
      </span>
    );
  }
  const total = metrics.sample_count + metrics.excluded_count;
  return (
    <div className="metric-tooltip-tps-summary">
      <div>{t("viewer.timeline.tps_tooltip_caption")}</div>
      <div>
        {t("viewer.timeline.tps_tooltip_samples", {
          count: metrics.sample_count,
          total,
        })}
      </div>
      {metrics.tps_median != null && (
        <div>
          {t("viewer.timeline.tps_tooltip_median", {
            value: formatTps(metrics.tps_median),
          })}
        </div>
      )}
      <div>
        {t("viewer.timeline.tps_tooltip_total", {
          tokens: formatTokens(metrics.total_output_tokens),
          duration: formatDuration(metrics.total_generation_ms),
        })}
      </div>
      <div className="metric-tooltip-tps-caveat">
        {t("viewer.timeline.tps_tooltip_caveat")}
      </div>
    </div>
  );
}

export function SessionViewer({
  session,
  loading,
  error,
  expandAll,
  previewChars,
  onCounts,
}: Props) {
  const t = useT();
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [toolFilter, setToolFilter] = useState<Set<string>>(new Set());
  const [currentUserIdx, setCurrentUserIdx] = useState(-1);
  // null = parent agent active. Otherwise the agent_id of a subagent.
  // TODO(nested-subagents): if subagents ever nest, this becomes a stack.
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  // Where to scroll back to on parent when the user came from a subagent button.
  const [pendingParentScrollTo, setPendingParentScrollTo] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement | null>(null);

  const skillUsage = useSkillUsage(session?.summary ?? null);

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
  const activeAgent = useMemo(() => {
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
      label: t("viewer.agent.main_label"),
      summary: session.summary,
      nodes: session.nodes,
      subagent: null as SubAgentSession | null,
    };
  }, [session, activeAgentId, subagents, t]);

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

  const agentStats = useMemo(
    () =>
      activeAgent
        ? computeAgentStats(activeAgent.summary, activeAgent.nodes)
        : null,
    [activeAgent],
  );

  const sessionTotals = useMemo(
    () => (session ? computeSessionTotals(session) : null),
    [session],
  );

  const visibleNodes = useMemo(() => {
    if (!activeAgent) return [] as SessionNode[];
    if (toolFilter.size === 0) return activeAgent.nodes;
    return activeAgent.nodes.filter((n) => {
      const viz = vizById.get(n.id);
      if (!viz) return false;
      for (const tn of viz.toolNames) {
        if (toolFilter.has(tn)) return true;
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

  const forceExpand = useCallback((nodeId: string) => {
    setOverrides((o) => ({ ...o, [nodeId]: true }));
  }, []);

  const search = useMessageSearch(visibleNodes, bodyRef, forceExpand);
  const searchReset = search.reset;

  // Reset per-session state when the source session changes (different file).
  const lastSessionId = useRef<string | null>(null);
  useEffect(() => {
    if (session && session.summary.session_id !== lastSessionId.current) {
      setOverrides({});
      setToolFilter(new Set());
      setCurrentUserIdx(-1);
      setActiveAgentId(null);
      setPendingParentScrollTo(null);
      searchReset();
      lastSessionId.current = session.summary.session_id;
    }
  }, [session, searchReset]);

  // Reset filters and overrides when switching agents (their node ids are
  // disjoint, so old overrides would never match anyway, but clearing makes
  // the UX feel fresh).
  useEffect(() => {
    setOverrides({});
    setToolFilter(new Set());
    setCurrentUserIdx(-1);
    searchReset();
  }, [activeAgentId, searchReset]);

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
        <div className="big">{t("viewer.loading")}</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="empty">
        <div className="big" style={{ color: "var(--error)" }}>{t("viewer.load_failed")}</div>
        <div className="hint selectable">{error}</div>
      </div>
    );
  }
  if (!session || !activeAgent || !sessionTotals || !agentStats) {
    return (
      <div className="empty">
        <div className="big">{t("viewer.no_selected")}</div>
        <div className="hint">
          {t("viewer.no_selected_hint_prefix")}
          <span className="kbd">Ctrl+Alt+F</span>
          {t("viewer.no_selected_hint_mid")}
          <span className="kbd">Ctrl+E</span>
          {t("viewer.no_selected_hint_suffix")}
        </div>
      </div>
    );
  }

  const sSummary = session.summary;
  const aSummary = activeAgent.summary;
  const inSubagent = activeAgent.subagent != null;

  // TPS lookups — both fields ship with optional defaults from the Rust side
  // (older cached SessionDetails won't have them), so guard with `??`.
  const sessionTps = session.tps_session ?? null;
  const tpsByAgent = session.tps_per_agent ?? {};
  const activeAgentTps = activeAgent.subagent
    ? tpsByAgent[activeAgent.subagent.agent_id]
    : tpsByAgent[MAIN_AGENT_KEY];

  const sessionAiPctStr = sessionTotals.durationMs != null
    ? formatPercent(sessionTotals.aiWorkMs, sessionTotals.durationMs)
    : "—";

  return (
    <div className="main">
      <div className="session-head">
        <div className="title selectable">{sSummary.title || sSummary.session_id}</div>
        <div className="meta-row">
          <span className="meta-item"><span className="k">{t("viewer.meta.session_id")}</span><span className="v mono">{sSummary.session_id}</span></span>
          {sSummary.cwd && <span className="meta-item"><span className="k">{t("viewer.meta.cwd")}</span><span className="v mono">{sSummary.cwd}</span></span>}
          {sSummary.git_branch && <span className="meta-item"><span className="k">{t("viewer.meta.branch")}</span><span className="v mono">{sSummary.git_branch}</span></span>}
          <span className="meta-item"><span className="k">{t("viewer.meta.started_at")}</span><span className="v mono">{formatLocalTime(sSummary.started_at)}</span></span>
        </div>

        {/* ---- Session-wide totals (parent + all Normal subagents) ---- */}
        <div className="metric-section">
          <div className="metric-section-label">
            {t("viewer.overview.heading")}
            {(sessionTotals.subagentCount > 0 || sessionTotals.asideQuestionCount > 0) && (
              <span className="metric-section-hint">
                {sessionTotals.subagentCount > 0 && <>{t("viewer.overview.with_subagents", { count: sessionTotals.subagentCount })}</>}
                {sessionTotals.subagentCount > 0 && sessionTotals.asideQuestionCount > 0 && <> · </>}
                {sessionTotals.asideQuestionCount > 0 && (
                  <>
                    {t("viewer.overview.aside_count", { count: sessionTotals.asideQuestionCount })}
                    <span className="aside-hint" title={t("viewer.overview.aside_tip")}>
                      ⓘ
                    </span>
                  </>
                )}
              </span>
            )}
          </div>
          <div className="metric-grid">
            <Metric label={t("viewer.metric.message_count")} value={String(sessionTotals.messageCount)} />
            <Metric
              label={t("viewer.metric.tool_call_count")}
              value={String(sessionTotals.toolCallTotal)}
              tooltip={<ToolBreakdownTooltip byName={sessionTotals.toolCallByName} />}
            />
            {skillUsage.length > 0 && (
              <Metric
                label={t("viewer.metric.skill_call_count")}
                value={String(skillUsage.reduce((s, r) => s + r.count, 0))}
                tooltip={<SkillBreakdownTooltip rows={skillUsage} />}
              />
            )}
            <Metric label={t("viewer.metric.files_read")} value={String(sessionTotals.filesRead)} />
            <Metric label={t("viewer.metric.lines_read")} value={String(sessionTotals.linesRead)} />
            <Metric label={t("viewer.metric.files_written")} value={String(sessionTotals.filesWritten)} />
            <Metric label={t("viewer.metric.lines_written")} value={String(sessionTotals.linesWritten)} />
            <Metric
              label={t("viewer.metric.cumulative_tokens")}
              value={`${formatTokens(sessionTotals.totalInputTokens)} / ${formatTokens(sessionTotals.totalOutputTokens)}`}
            />
            <Metric label={t("viewer.metric.session_duration")} value={formatDuration(sessionTotals.durationMs)} />
            <Metric label={t("viewer.metric.ai_work_time")} value={formatDuration(sessionTotals.aiWorkMs)} />
            <Metric label={t("viewer.metric.ai_work_pct")} value={sessionAiPctStr} />
            <Metric label={t("viewer.metric.subagent_count")} value={String(sessionTotals.subagentCount)} />
            <Metric
              label={t("viewer.metric.tps")}
              value={formatTps(sessionTps?.tps_mean ?? null)}
              tooltip={<TpsTooltip metrics={sessionTps} />}
            />
          </div>
        </div>

        {/* ---- Agent-level stats (current selection only) ---- */}
        <div className={`metric-section agent-section${inSubagent ? " is-subagent" : ""}`}>
          <div className="metric-section-label">
            <span className="agent-section-title">
              {inSubagent ? t("viewer.agent.heading_sub") : t("viewer.agent.heading_main")}
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
                title={t("viewer.agent.back_hint")}
              >{t("viewer.agent.back")}</button>
            )}
          </div>
          <div className="metric-grid">
            <Metric label={t("viewer.metric.message_count")} value={String(agentStats.messageCount)} />
            <Metric label={t("viewer.metric.interruptions")} value={String(agentStats.interruptions)} />
            <Metric
              label={t("viewer.metric.tool_call_count")}
              value={String(agentStats.toolCallTotal)}
              tooltip={<ToolBreakdownTooltip byName={agentStats.toolCallByName} />}
            />
            <Metric
              label={t("viewer.metric.files_read")}
              value={String(agentStats.filesRead)}
              tooltipMaxWidth={560}
              tooltip={
                <FileListTooltip
                  paths={agentStats.filesReadList}
                  emptyText={t("viewer.timeline.tooltip_no_files_read")}
                />
              }
            />
            <Metric label={t("viewer.metric.lines_read")} value={String(agentStats.linesRead)} />
            <Metric
              label={t("viewer.metric.files_written")}
              value={String(agentStats.filesWritten)}
              tooltipMaxWidth={560}
              tooltip={
                <FileListTooltip
                  paths={agentStats.filesWrittenList}
                  emptyText={t("viewer.timeline.tooltip_no_files_written")}
                />
              }
            />
            <Metric label={t("viewer.metric.lines_written")} value={String(agentStats.linesWritten)} />
            <Metric
              label={t("viewer.metric.peak_ctx")}
              value={formatTokens(aSummary.peak_context_tokens)}
              tooltipMinWidth={500}
              tooltipMaxWidth={520}
              tooltip={
                <CtxCurveTooltip
                  nodes={activeAgent.nodes}
                  vizById={vizById}
                  emptyText={t("viewer.timeline.ctx_curve_empty")}
                />
              }
            />
            <Metric label={t("viewer.metric.agent_duration")} value={formatDuration(agentStats.durationMs)} />
            <Metric
              label={t("viewer.metric.tps")}
              value={formatTps(activeAgentTps?.metrics.tps_mean ?? null)}
              tooltipMinWidth={500}
              tooltipMaxWidth={520}
              tooltip={
                <div className="metric-tooltip-tps">
                  <TpsTooltip metrics={activeAgentTps?.metrics ?? null} />
                  <TpsCurveTooltip
                    series={activeAgentTps?.series ?? []}
                    emptyText={t("viewer.timeline.tps_curve_empty")}
                  />
                </div>
              }
            />
          </div>
        </div>
      </div>

      <div className="timeline-table">
        <div className="timeline-header">
          <div className="th-left">
            <span className="th-title">{t("viewer.timeline.messages")}</span>
            <span className="th-meta">
              {t("viewer.timeline.visible_count", { visible: visibleNodes.length, total: activeAgent.nodes.length })}
            </span>
            <span className="th-user-nav" title={t("viewer.timeline.user_nav_hint")}>
              <button
                type="button"
                className="th-nav-btn"
                onClick={() => jumpToUser(-1)}
                disabled={userIndices.length === 0}
                title={t("viewer.timeline.prev_user_hint")}
                aria-label={t("viewer.timeline.prev_user_hint")}
              >{t("viewer.timeline.prev_user")}</button>
              <button
                type="button"
                className="th-nav-btn"
                onClick={() => jumpToUser(1)}
                disabled={userIndices.length === 0}
                title={t("viewer.timeline.next_user_hint")}
                aria-label={t("viewer.timeline.next_user_hint")}
              >{t("viewer.timeline.next_user")}</button>
              <span className="th-meta">{currentUserIdx >= 0 ? `${currentUserIdx + 1}/` : ""}{userIndices.length}</span>
            </span>
            <span className="th-msg-search">
              <input
                ref={search.inputRef}
                className={`th-search-input${search.searchMissed ? " missed" : ""}`}
                placeholder={t("viewer.timeline.search_placeholder")}
                value={search.messageSearch}
                onChange={(e) => search.onChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    search.run();
                  }
                }}
                aria-label={t("viewer.timeline.search_aria")}
              />
              <button
                type="button"
                className="th-nav-btn"
                onClick={search.run}
                disabled={search.messageSearch.trim().length === 0}
                title={t("viewer.timeline.search_button_hint")}
                aria-label={t("viewer.timeline.search_button_aria")}
              >🔍</button>
              {search.hitCount > 0 && (
                <span className="th-search-cursor">
                  <button
                    type="button"
                    className="th-nav-btn"
                    onClick={() =>
                      search.goTo(
                        (Math.max(0, search.currentOrdinal) - 1 + search.hitCount) % search.hitCount,
                      )
                    }
                    disabled={search.hitCount <= 1}
                    title={t("viewer.timeline.search_prev_hint")}
                    aria-label={t("viewer.timeline.search_prev_hint")}
                  >‹</button>
                  <span className="th-search-counter">
                    {Math.max(0, search.currentOrdinal) + 1}/{search.hitCount}
                  </span>
                  <button
                    type="button"
                    className="th-nav-btn"
                    onClick={() =>
                      search.goTo((Math.max(0, search.currentOrdinal) + 1) % search.hitCount)
                    }
                    disabled={search.hitCount <= 1}
                    title={t("viewer.timeline.search_next_hint")}
                    aria-label={t("viewer.timeline.search_next_hint")}
                  >›</button>
                </span>
              )}
            </span>
          </div>
          <div className="th-right">
            <span className="th-title">{t("viewer.timeline.right_title")}</span>
            <ToolFilterDropdown
              universe={toolUniverse}
              selected={toolFilter}
              onChange={setToolFilter}
            />
          </div>
        </div>
        <div className="timeline-body" ref={bodyRef}>
        <SearchHighlightProvider needle={search.activeHighlight}>
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
                    <span className={`badge ${n.kind}`}>{t(`viewer.kind.${KIND_LABEL_KEYS[n.kind]}` as const)}</span>
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
                        <span title={t("viewer.timeline.out_tokens_hint")}>out {outStr}</span>
                        {(n.usage.cache_read_input_tokens > 0 || n.usage.cache_creation_input_tokens > 0) && (
                          <span title={t("viewer.timeline.cache_tokens_hint")}>
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
        </SearchHighlightProvider>
        </div>
      </div>
    </div>
  );
}
