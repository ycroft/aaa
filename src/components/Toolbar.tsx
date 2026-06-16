import { useMemo } from "react";
import type { SessionFilter, SessionSummary, TimeRangePreset } from "../types";
import { shortPath } from "../format";
import { useT } from "../i18n";

interface Props {
  filter: SessionFilter;
  onFilterChange: (next: SessionFilter) => void;
  sessions: SessionSummary[];
  onRefresh: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  expandAll: boolean;
  onOpenSource: () => void;
  onSettings: () => void;
  rootLabel: string;
  onExport: () => void;
  canExport: boolean;
  onJudgeSession?: () => void;
  canJudgeSession: boolean;
  onFeedback: () => void;
  hubConnected: boolean;
}

export function Toolbar({
  filter,
  onFilterChange,
  sessions,
  onRefresh,
  onExpandAll,
  onCollapseAll,
  expandAll,
  onOpenSource,
  onSettings,
  rootLabel,
  onExport,
  canExport,
  onJudgeSession,
  canJudgeSession,
  onFeedback,
  hubConnected,
}: Props) {
  const t = useT();

  const TIME_PRESETS: { value: TimeRangePreset; label: string; hint: string }[] = useMemo(
    () => [
      { value: "all", label: t("toolbar.time_all"), hint: t("toolbar.time_all_hint") },
      { value: "24h", label: t("toolbar.time_24h"), hint: t("toolbar.time_24h_hint") },
      { value: "1w", label: t("toolbar.time_1w"), hint: t("toolbar.time_1w_hint") },
      { value: "1m", label: t("toolbar.time_1m"), hint: t("toolbar.time_1m_hint") },
      { value: "custom", label: t("toolbar.time_custom"), hint: t("toolbar.time_custom_hint") },
    ],
    [t],
  );

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
        <button className="tbtn" onClick={onOpenSource} data-hint={t("toolbar.open_source_hint")}>
          {t("toolbar.open_source")}
        </button>
        <button className="tbtn" onClick={onRefresh} data-hint={t("toolbar.refresh_hint")}>
          ⟳ {t("toolbar.refresh")}
        </button>
      </div>
      <span className="sep" />
      <div className="group">
        <button
          className={`tbtn${expandAll ? " primary" : ""}`}
          onClick={expandAll ? onCollapseAll : onExpandAll}
          data-hint={t("toolbar.expand_all_hint")}
        >
          {expandAll ? t("toolbar.collapse_all") : t("toolbar.expand_all")}
        </button>
      </div>
      <span className="sep" />
      <div className="group">
        <button
          className="tbtn"
          onClick={onExport}
          disabled={!canExport}
          data-hint={t("toolbar.export_hint")}
        >
          {t("toolbar.export")}
        </button>
      </div>
      <span className="sep" />
      <div className="group">
        <button
          className="tbtn"
          onClick={() => onJudgeSession?.()}
          disabled={!canJudgeSession}
          data-hint={t("toolbar.judge_session_hint")}
        >
          {t("toolbar.judge_session")}
        </button>
      </div>
      <span className="sep" />
      <input
        className="search"
        placeholder={t("toolbar.filter_placeholder")}
        value={filter.search}
        onChange={(e) => setSearch(e.target.value)}
        data-hint={t("toolbar.filter_hint")}
      />
      <select
        className="filter-select"
        value={filter.cwd ?? ""}
        onChange={(e) => setCwd(e.target.value)}
        data-hint={t("toolbar.cwd_filter_hint")}
        title={filter.cwd ?? t("toolbar.cwd_filter_all")}
      >
        <option value="">{t("toolbar.cwd_filter_all")}</option>
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
        data-hint={t("toolbar.time_filter_hint")}
      >
        {TIME_PRESETS.map((p) => (
          <option key={p.value} value={p.value} title={p.hint}>
            {p.label}
          </option>
        ))}
      </select>
      {filter.timePreset === "custom" && (
        <div className="group date-range" data-hint={t("toolbar.date_range_hint")}>
          <input
            type="date"
            className="filter-date"
            value={filter.customStart ?? ""}
            onChange={(e) => setCustomStart(e.target.value)}
            aria-label={t("toolbar.date_start_label")}
          />
          <span className="date-sep">→</span>
          <input
            type="date"
            className="filter-date"
            value={filter.customEnd ?? ""}
            onChange={(e) => setCustomEnd(e.target.value)}
            aria-label={t("toolbar.date_end_label")}
          />
        </div>
      )}
      <span className="spacer" />
      <span className="crumb" data-hint={t("toolbar.scanning_hint")}>
        <span>{t("toolbar.scanning_label")} </span>
        <span className="strong">{rootLabel}</span>
      </span>
      <span className="sep" />
      <button
        className="tbtn"
        onClick={onFeedback}
        disabled={!hubConnected}
        data-hint={hubConnected ? t("toolbar.feedback_hint_connected") : t("toolbar.feedback_hint_offline")}
      >
        {t("toolbar.feedback")}
      </button>
      <button className="tbtn" onClick={onSettings} data-hint={t("toolbar.settings_hint")}>
        {t("toolbar.settings")}
      </button>
    </div>
  );
}
