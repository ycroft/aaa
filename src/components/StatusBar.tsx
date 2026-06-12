import { formatTokens } from "../format";

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
  return (
    <div className="statusbar" data-hint="Status bar — hover any control for help">
      <span className="item">
        <span className="k">backend</span>
        <span className="v">{providerLabel}</span>
      </span>
      {remoteLabel && (
        <span className="item">
          <span className="k">remote</span>
          <span className="v">↗ {remoteLabel}</span>
        </span>
      )}
      <span className="item">
        <span className="k">sessions</span>
        <span className="v">{sessionCount}</span>
      </span>
      <span className="item">
        <span className="k">nodes</span>
        <span className="v">{expandedNodes}/{totalNodes}</span>
      </span>
      <span className="item">
        <span className="k">peak ctx</span>
        <span className="v">{formatTokens(peakCtx)}</span>
      </span>
      {busy && <span className="item"><span className="v">●</span><span>working…</span></span>}
      <span className="spacer" />
      <span className="hint">{hint || status}</span>
    </div>
  );
}
