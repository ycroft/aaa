import { formatTokens } from "../../../format";
import type { NodeViz } from "../viz";

export function CtxBar({ viz }: { viz: NodeViz | undefined }) {
  if (!viz || viz.ctx == null) return null;
  const pct = Math.round(viz.ratio * 100);
  const limitTitle = `100% = ${formatTokens(viz.limit)}`;
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
