import { useMemo } from "react";
import type { SessionFilter, SessionSummary, TimeRangePreset } from "../types";
import { shortPath } from "../format";

interface Props {
  filter: SessionFilter;
  onFilterChange: (next: SessionFilter) => void;
  sessions: SessionSummary[];
  onRefresh: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  expandAll: boolean;
  onSwitchBackend: () => void;
  onSettings: () => void;
  providerLabel: string;
  rootLabel: string;
  onExport: () => void;
  canExport: boolean;
  onAiAnalysis: () => void;
  canAiAnalysis: boolean;
  aiAnalysisHint?: string;
}

const TIME_PRESETS: { value: TimeRangePreset; label: string; hint: string }[] = [
  { value: "all", label: "All time", hint: "No time filter" },
  { value: "24h", label: "Last 24h", hint: "Sessions in the past 24 hours" },
  { value: "1w", label: "Last 7 days", hint: "Sessions in the past week" },
  { value: "1m", label: "Last 30 days", hint: "Sessions in the past month" },
  { value: "custom", label: "Custom…", hint: "Pick a custom range" },
];

export function Toolbar({
  filter,
  onFilterChange,
  sessions,
  onRefresh,
  onExpandAll,
  onCollapseAll,
  expandAll,
  onSwitchBackend,
  onSettings,
  providerLabel,
  rootLabel,
  onExport,
  canExport,
  onAiAnalysis,
  canAiAnalysis,
  aiAnalysisHint,
}: Props) {
  // Distinct, non-empty cwds present in the current session list — sorted, capped to keep menu sane.
  const cwdOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const s of sessions) {
      if (s.cwd) seen.add(s.cwd);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [sessions]);

  const setSearch = (v: string) => onFilterChange({ ...filter, search: v });

  const setCwd = (v: string) =>
    onFilterChange({ ...filter, cwd: v === "" ? null : v });

  const setPreset = (v: TimeRangePreset) =>
    onFilterChange({ ...filter, timePreset: v });

  const setCustomStart = (v: string) =>
    onFilterChange({ ...filter, customStart: v || null });

  const setCustomEnd = (v: string) =>
    onFilterChange({ ...filter, customEnd: v || null });

  return (
    <div className="toolbar">
      <div className="group">
        <button className="tbtn" onClick={onSwitchBackend} data-hint="Switch backend (Ctrl+Shift+P)">
          ▣ {providerLabel}
        </button>
        <button className="tbtn" onClick={onRefresh} data-hint="Reload sessions from disk (F5)">
          ⟳ Refresh
        </button>
      </div>
      <span className="sep" />
      <div className="group">
        <button
          className={`tbtn${expandAll ? " primary" : ""}`}
          onClick={expandAll ? onCollapseAll : onExpandAll}
          data-hint="Toggle expand-all for nodes (Ctrl+E)"
        >
          {expandAll ? "▾ Collapse all" : "▸ Expand all"}
        </button>
      </div>
      <span className="sep" />
      <div className="group">
        <button
          className="tbtn"
          onClick={onExport}
          disabled={!canExport}
          data-hint="Export the loaded session as JSON (Ctrl+Shift+E)"
        >
          ⤓ Export
        </button>
      </div>
      <span className="sep" />
      <div className="group">
        <button
          className="tbtn"
          onClick={onAiAnalysis}
          disabled={!canAiAnalysis}
          data-hint={aiAnalysisHint ?? "启动AI辅助分析"}
        >
          ✦ AI分析
        </button>
      </div>
      <span className="sep" />
      <input
        className="search"
        placeholder="Filter sessions… (Ctrl+Alt+F)"
        value={filter.search}
        onChange={(e) => setSearch(e.target.value)}
        data-hint="Filter by title / cwd / branch / id"
      />
      <select
        className="filter-select"
        value={filter.cwd ?? ""}
        onChange={(e) => setCwd(e.target.value)}
        data-hint="Filter by working directory"
        title={filter.cwd ?? "All directories"}
      >
        <option value="">All directories</option>
        {cwdOptions.map((p) => (
          <option key={p} value={p} title={p}>
            {shortPath(p, 48)}
          </option>
        ))}
      </select>
      <select
        className="filter-select"
        value={filter.timePreset}
        onChange={(e) => setPreset(e.target.value as TimeRangePreset)}
        data-hint="Filter by time range"
      >
        {TIME_PRESETS.map((p) => (
          <option key={p.value} value={p.value} title={p.hint}>
            {p.label}
          </option>
        ))}
      </select>
      {filter.timePreset === "custom" && (
        <div className="group date-range" data-hint="Pick start and end dates (inclusive)">
          <input
            type="date"
            className="filter-date"
            value={filter.customStart ?? ""}
            onChange={(e) => setCustomStart(e.target.value)}
            aria-label="Start date"
          />
          <span className="date-sep">→</span>
          <input
            type="date"
            className="filter-date"
            value={filter.customEnd ?? ""}
            onChange={(e) => setCustomEnd(e.target.value)}
            aria-label="End date"
          />
        </div>
      )}
      <span className="spacer" />
      <span className="crumb" data-hint="Currently scanned directory">
        <span>scanning </span>
        <span className="strong">{rootLabel}</span>
      </span>
      <span className="sep" />
      <button className="tbtn" onClick={onSettings} data-hint="Open settings (Ctrl+,)">
        ⚙ Settings
      </button>
    </div>
  );
}
