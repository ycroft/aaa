import type { ReactNode } from "react";

export function Metric({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: string;
  tooltip?: ReactNode;
}) {
  return (
    <div className={`metric${tooltip ? " has-tooltip" : ""}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {tooltip && <div className="metric-tooltip">{tooltip}</div>}
    </div>
  );
}
