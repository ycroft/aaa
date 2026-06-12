import { formatTokens } from "../format";
import { useT } from "../i18n";

interface Props {
  hint: string;
  providerLabel: string;
  remoteLabel: string | null;
  sessionCount: number;
  expandedNodes: number;
  totalNodes: number;
  peakCtx: number;
  status: string;
  busy: boolean;
}

export function StatusBar({
  hint,
  providerLabel,
  remoteLabel,
  sessionCount,
  expandedNodes,
  totalNodes,
  peakCtx,
  status,
  busy,
}: Props) {
  const t = useT();
  return (
    <div className="statusbar" data-hint={t("status_bar.hint")}>
      <span className="item">
        <span className="k">{t("status_bar.backend")}</span>
        <span className="v">{providerLabel}</span>
      </span>
      {remoteLabel && (
        <span className="item">
          <span className="k">{t("status_bar.remote")}</span>
          <span className="v">↗ {remoteLabel}</span>
        </span>
      )}
      <span className="item">
        <span className="k">{t("status_bar.sessions")}</span>
        <span className="v">{sessionCount}</span>
      </span>
      <span className="item">
        <span className="k">{t("status_bar.nodes")}</span>
        <span className="v">{expandedNodes}/{totalNodes}</span>
      </span>
      <span className="item">
        <span className="k">{t("status_bar.peak_ctx")}</span>
        <span className="v">{formatTokens(peakCtx)}</span>
      </span>
      {busy && <span className="item"><span className="v">●</span><span>{t("status_bar.working")}</span></span>}
      <span className="spacer" />
      <span className="hint">{hint || status}</span>
    </div>
  );
}
