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

import { computeAgentStats, computeSessionTotals, isHumanUserTurn } from "./stats";
import { buildNodeViz, buildSkillsByNodeId, type NodeViz } from "./viz";
import { useMessageSearch } from "./hooks/useMessageSearch";
import { useSkillUsage } from "./hooks/useSkillUsage";

import { AgentSwitcher } from "./parts/AgentSwitcher";
import { CtxBar } from "./parts/CtxBar";
import { Metric } from "./parts/Metric";
import { PartView } from "./parts/PartView";
import { ToolChips } from "./parts/ToolChips";
import { SkillChips } from "./parts/SkillChips";
import { ToolFilterDropdown } from "./parts/ToolFilterDropdown";
import {
  ToolBreakdownTooltip,
  SkillBreakdownTooltip,
  FileListTooltip,
  CtxCurveTooltip,
  TpsCurveTooltip,
} from "./parts/Tooltips";
import { SearchHighlightProvider } from "./parts/Highlight";
import "./viewer.css";

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
  user: "User",
  assistant: "Assistant",
  system: "System",
  tool_result: "Tool Result",
  sidechain: "Sidechain",
  meta: "Meta",
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

function TpsTooltip({ metrics }: { metrics: import("../../types").TpsMetrics | null | undefined }) {
  if (!metrics || metrics.sample_count === 0) {
    return <span className="metric-tooltip-empty">无合格 turn</span>;
  }
  const total = metrics.sample_count + metrics.excluded_count;
  return (
    <div className="metric-tooltip-tps-summary">
      <div>生成速度（t/s，仅含有效 turn）</div>
      <div>样本 {metrics.sample_count}/{total}</div>
      {metrics.tps_median != null && <div>中位数 {formatTps(metrics.tps_median)} t/s</div>}
      <div>{formatTokens(metrics.total_output_tokens)} tokens / {formatDuration(metrics.total_generation_ms)}</div>
      <div className="metric-tooltip-tps-caveat">
        短 turn（&lt;50 tokens）和超时 turn 已排除
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
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [toolFilter, setToolFilter] = useState<Set<string>>(new Set());
  const [currentUserIdx, setCurrentUserIdx] = useState(-1);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [pendingParentScrollTo, setPendingParentScrollTo] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement | null>(null);

  const skillUsage = useSkillUsage(session?.summary ?? null);
  const skillsByNodeId = useMemo(() => buildSkillsByNodeId(skillUsage), [skillUsage]);
  const subagents = session?.subagents ?? [];

  const subagentByToolUseId = useMemo(() => {
    const m = new Map<string, SubAgentSession>();
    for (const sa of subagents) {
      if (sa.parent_tool_use_id) m.set(sa.parent_tool_use_id, sa);
    }
    return m;
  }, [subagents]);

  const activeAgent = useMemo(() => {
    if (!session) return null;
    if (activeAgentId) {
      const sa = subagents.find((s) => s.agent_id === activeAgentId);
      if (sa) return { label: `${sa.agent_type}@${sa.type_ordinal}`, summary: sa.summary, nodes: sa.nodes, subagent: sa };
    }
    return { label: "主代理", summary: session.summary, nodes: session.nodes, subagent: null as SubAgentSession | null };
  }, [session, activeAgentId, subagents]);

  const { vizById, toolUniverse } = useMemo(() => {
    if (!activeAgent) return { vizById: new Map<string, NodeViz>(), toolUniverse: [] as Array<{ name: string; count: number }> };
    const peak = activeAgent.summary.peak_context_tokens || 0;
    const map = activeAgent.subagent ? new Map<string, SubAgentSession>() : subagentByToolUseId;
    const { byId, toolUniverse } = buildNodeViz(activeAgent.nodes, peak, map, skillsByNodeId);
    return { vizById: byId, toolUniverse };
  }, [activeAgent, subagentByToolUseId, skillsByNodeId]);

  const peakCtx = activeAgent?.summary.peak_context_tokens ?? 0;

  const counts = useMemo<ViewerCounts>(() => {
    if (!activeAgent) return { totalNodes: 0, expandedNodes: 0, peakCtx: 0 };
    const expandedNodes = activeAgent.nodes.reduce((acc, n) => acc + (overrides[n.id] ?? expandAll ? 1 : 0), 0);
    return { totalNodes: activeAgent.nodes.length, expandedNodes, peakCtx };
  }, [activeAgent, overrides, expandAll, peakCtx]);

  const agentStats = useMemo(() => activeAgent ? computeAgentStats(activeAgent.summary, activeAgent.nodes) : null, [activeAgent]);
  const sessionTotals = useMemo(() => session ? computeSessionTotals(session) : null, [session]);

  const visibleNodes = useMemo(() => {
    if (!activeAgent) return [] as SessionNode[];
    if (toolFilter.size === 0) return activeAgent.nodes;
    return activeAgent.nodes.filter((n) => {
      const viz = vizById.get(n.id);
      if (!viz) return false;
      return viz.toolNames.some((tn) => toolFilter.has(tn));
    });
  }, [activeAgent, vizById, toolFilter]);

  const userIndices = useMemo(() => {
    const out: number[] = [];
    visibleNodes.forEach((n, i) => { if (isHumanUserTurn(n)) out.push(i); });
    return out;
  }, [visibleNodes]);

  const forceExpand = useCallback((nodeId: string) => {
    setOverrides((o) => ({ ...o, [nodeId]: true }));
  }, []);

  const search = useMessageSearch(visibleNodes, bodyRef, forceExpand);
  const searchReset = search.reset;

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
    let cur = currentUserIdx;
    if (cur < 0) {
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
      body.scrollBy({ top: el.getBoundingClientRect().top - bodyTop - 8, behavior: "smooth" });
      setCurrentUserIdx(targetIdx);
    }
  };

  const enterSubagent = (agentId: string, fromNodeId?: string) => {
    setActiveAgentId(agentId);
    if (fromNodeId) setPendingParentScrollTo(fromNodeId);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };

  const exitSubagent = () => setActiveAgentId(null);

  useEffect(() => {
    if (activeAgentId !== null) return;
    if (!pendingParentScrollTo || !bodyRef.current) return;
    const body = bodyRef.current;
    requestAnimationFrame(() => {
      const el = body.querySelector<HTMLElement>(`#node-${CSS.escape(pendingParentScrollTo)}`);
      if (el) body.scrollBy({ top: el.getBoundingClientRect().top - body.getBoundingClientRect().top - 8, behavior: "smooth" });
      setPendingParentScrollTo(null);
    });
  }, [activeAgentId, pendingParentScrollTo]);

  useEffect(() => onCounts(counts), [counts, onCounts]);

  if (loading) return <div className="empty"><div className="big">加载中…</div></div>;
  if (error) return <div className="empty"><div className="big" style={{ color: "var(--error)" }}>加载失败</div><div className="hint selectable">{error}</div></div>;
  if (!session || !activeAgent || !sessionTotals || !agentStats) {
    return <div className="empty"><div className="big">未选择会话</div><div className="hint">从左侧列表选择一个会话</div></div>;
  }

  const sSummary = session.summary;
  const aSummary = activeAgent.summary;
  const inSubagent = activeAgent.subagent != null;

  const sessionTps = session.tps_session ?? null;
  const tpsByAgent = session.tps_per_agent ?? {};
  const activeAgentTps = activeAgent.subagent ? tpsByAgent[activeAgent.subagent.agent_id] : tpsByAgent[MAIN_AGENT_KEY];

  const sessionAiPctStr = sessionTotals.durationMs != null ? formatPercent(sessionTotals.aiWorkMs, sessionTotals.durationMs) : "—";

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

        <div className="metric-section">
          <div className="metric-section-label">
            会话总览
            {(sessionTotals.subagentCount > 0 || sessionTotals.asideQuestionCount > 0) && (
              <span className="metric-section-hint">
                {sessionTotals.subagentCount > 0 && <>{sessionTotals.subagentCount} 个子代理</>}
                {sessionTotals.subagentCount > 0 && sessionTotals.asideQuestionCount > 0 && <> · </>}
                {sessionTotals.asideQuestionCount > 0 && (
                  <>{sessionTotals.asideQuestionCount} 个侧链<span className="aside-hint" title="/aside 是主对话的镜像，不计入独立子代理">ⓘ</span></>
                )}
              </span>
            )}
          </div>
          <div className="metric-grid">
            <Metric label="消息数" value={String(sessionTotals.messageCount)} />
            <Metric label="工具调用次数" value={String(sessionTotals.toolCallTotal)} tooltip={<ToolBreakdownTooltip byName={sessionTotals.toolCallByName} />} />
            {skillUsage.length > 0 && (
              <Metric label="Skill 调用次数" value={String(skillUsage.reduce((s, r) => s + r.count, 0))} tooltip={<SkillBreakdownTooltip rows={skillUsage} />} />
            )}
            <Metric label="读取文件数" value={String(sessionTotals.filesRead)} />
            <Metric label="读取行数" value={String(sessionTotals.linesRead)} />
            <Metric label="写入文件数" value={String(sessionTotals.filesWritten)} />
            <Metric label="写入行数" value={String(sessionTotals.linesWritten)} />
            <Metric label="累计 Token（输入/输出）" value={`${formatTokens(sessionTotals.totalInputTokens)} / ${formatTokens(sessionTotals.totalOutputTokens)}`} />
            <Metric label="会话时长" value={formatDuration(sessionTotals.durationMs)} />
            <Metric label="AI 工作时长" value={formatDuration(sessionTotals.aiWorkMs)} />
            <Metric label="AI 工作占比" value={sessionAiPctStr} />
            <Metric label="子代理数" value={String(sessionTotals.subagentCount)} />
            <Metric label="平均 TPS" value={formatTps(sessionTps?.tps_mean ?? null)} tooltip={<TpsTooltip metrics={sessionTps} />} />
          </div>
        </div>

        <div className={`metric-section agent-section${inSubagent ? " is-subagent" : ""}`}>
          <div className="metric-section-label">
            <span className="agent-section-title">{inSubagent ? "当前子代理" : "当前 Agent"}</span>
            {subagents.length > 0 ? (
              <AgentSwitcher subagents={subagents} activeAgentId={activeAgentId} onPick={(agentId) => { if (agentId === null) exitSubagent(); else enterSubagent(agentId); }} />
            ) : (
              <span className="metric-section-hint mono">{activeAgent.label}</span>
            )}
            {inSubagent && activeAgent.subagent?.description && (
              <span className="agent-section-desc" title={activeAgent.subagent.description}>{activeAgent.subagent.description}</span>
            )}
            {inSubagent && (
              <button type="button" className="agent-back-btn" onClick={exitSubagent} title="返回主代理时间线">← 返回</button>
            )}
          </div>
          <div className="metric-grid">
            <Metric label="消息数" value={String(agentStats.messageCount)} />
            <Metric label="用户打断次数" value={String(agentStats.interruptions)} />
            <Metric label="工具调用次数" value={String(agentStats.toolCallTotal)} tooltip={<ToolBreakdownTooltip byName={agentStats.toolCallByName} />} />
            <Metric label="读取文件数" value={String(agentStats.filesRead)} tooltipMaxWidth={560} tooltip={<FileListTooltip paths={agentStats.filesReadList} emptyText="无文件读取记录" />} />
            <Metric label="读取行数" value={String(agentStats.linesRead)} />
            <Metric label="写入文件数" value={String(agentStats.filesWritten)} tooltipMaxWidth={560} tooltip={<FileListTooltip paths={agentStats.filesWrittenList} emptyText="无文件写入记录" />} />
            <Metric label="写入行数" value={String(agentStats.linesWritten)} />
            <Metric label="峰值上下文" value={formatTokens(aSummary.peak_context_tokens)} tooltipMinWidth={500} tooltipMaxWidth={520} tooltip={<CtxCurveTooltip nodes={activeAgent.nodes} vizById={vizById} emptyText="无上下文数据" />} />
            <Metric label="Agent 时长" value={formatDuration(agentStats.durationMs)} />
            <Metric label="平均 TPS" value={formatTps(activeAgentTps?.metrics.tps_mean ?? null)} tooltipMinWidth={500} tooltipMaxWidth={520} tooltip={
              <div className="metric-tooltip-tps">
                <TpsTooltip metrics={activeAgentTps?.metrics ?? null} />
                <TpsCurveTooltip series={activeAgentTps?.series ?? []} emptyText="无 TPS 数据" />
              </div>
            } />
          </div>
        </div>
      </div>

      <div className="timeline-table">
        <div className="timeline-header">
          <div className="th-left">
            <span className="th-title">消息</span>
            <span className="th-meta">{visibleNodes.length}/{activeAgent.nodes.length} 条</span>
            <span className="th-user-nav" title="在用户消息间导航">
              <button type="button" className="th-nav-btn" onClick={() => jumpToUser(-1)} disabled={userIndices.length === 0} title="上一条用户消息" aria-label="上一条用户消息">↑</button>
              <button type="button" className="th-nav-btn" onClick={() => jumpToUser(1)} disabled={userIndices.length === 0} title="下一条用户消息" aria-label="下一条用户消息">↓</button>
              <span className="th-meta">{currentUserIdx >= 0 ? `${currentUserIdx + 1}/` : ""}{userIndices.length}</span>
            </span>
            <span className="th-msg-search">
              <input
                ref={search.inputRef}
                className={`th-search-input${search.searchMissed ? " missed" : ""}`}
                placeholder="搜索消息…"
                value={search.messageSearch}
                onChange={(e) => search.onChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search.run(); } }}
                aria-label="搜索消息"
              />
              <button type="button" className="th-nav-btn" onClick={search.run} disabled={search.messageSearch.trim().length === 0} title="执行搜索" aria-label="执行搜索">🔍</button>
              {search.hitCount > 0 && (
                <span className="th-search-cursor">
                  <button type="button" className="th-nav-btn" onClick={() => search.goTo((Math.max(0, search.currentOrdinal) - 1 + search.hitCount) % search.hitCount)} disabled={search.hitCount <= 1} title="上一个匹配" aria-label="上一个匹配">‹</button>
                  <span className="th-search-counter">{Math.max(0, search.currentOrdinal) + 1}/{search.hitCount}</span>
                  <button type="button" className="th-nav-btn" onClick={() => search.goTo((Math.max(0, search.currentOrdinal) + 1) % search.hitCount)} disabled={search.hitCount <= 1} title="下一个匹配" aria-label="下一个匹配">›</button>
                </span>
              )}
            </span>
          </div>
          <div className="th-right">
            <span className="th-title">上下文 / 工具</span>
            <ToolFilterDropdown universe={toolUniverse} selected={toolFilter} onChange={setToolFilter} />
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
              const outStr = n.usage?.output_tokens != null ? formatTokens(n.usage.output_tokens) : "—";
              return (
                <div
                  key={n.id}
                  id={`node-${n.id}`}
                  className={`node${isHot ? " hot" : ""}${isPeak ? " peak" : ""}${hasSubagent ? " has-subagent" : ""}`}
                  data-hint={`Node ${n.id} · ${n.kind}`}
                >
                  <div className="node-main">
                    <div className="node-head" onClick={() => setOverrides((o) => ({ ...o, [n.id]: !(o[n.id] ?? expandAll) }))}>
                      <div className="chev">{expanded ? "▾" : "▸"}</div>
                      <div style={{ display: "flex", gap: 10, alignItems: "center", overflow: "hidden" }}>
                        <span className={`badge ${n.kind}`}>{KIND_LABEL[n.kind]}</span>
                        {!expanded && <span className="preview">{previewOf(n, previewChars)}</span>}
                        {expanded && n.model && <span className="tag">{n.model}</span>}
                      </div>
                      <div className="stats">
                        {n.usage && (
                          <>
                            <span title="输出 token 数">out {outStr}</span>
                            {(n.usage.cache_read_input_tokens > 0 || n.usage.cache_creation_input_tokens > 0) && (
                              <span title="缓存命中 + 缓存写入">
                                ⇣ {formatTokens(n.usage.cache_read_input_tokens)}{" "}+ {formatTokens(n.usage.cache_creation_input_tokens)}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                      <div className="ts">{n.timestamp ? formatLocalTime(n.timestamp).slice(11) : ""}</div>
                    </div>
                    {expanded && (
                      <div className="node-body selectable">
                        {n.parts.map((p, i) => <PartView key={i} part={p} kind={n.kind} />)}
                      </div>
                    )}
                  </div>
                  <div className="node-side">
                    <CtxBar viz={viz} />
                    <ToolChips viz={viz} onPick={(name) => setToolFilter(new Set([name]))} onEnterSubagent={(agentId) => enterSubagent(agentId, n.id)} />
                    <SkillChips viz={viz} />
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
