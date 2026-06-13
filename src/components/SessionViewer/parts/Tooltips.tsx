import { useT } from "../../../i18n";
import { compactMiddlePath } from "../../../format";
import type { SessionNode, SkillUsage, TpsSeriesPoint } from "../../../types";
import type { NodeViz } from "../viz";

// Renders a tool-breakdown table inside a Metric tooltip (used by both the
// session-totals "tool calls" and the agent-level one).
export function ToolBreakdownTooltip({
  byName,
}: {
  byName: Array<[string, number]>;
}) {
  const t = useT();
  if (byName.length === 0) {
    return <span className="metric-tooltip-empty">{t("viewer.timeline.tooltip_no_tools")}</span>;
  }
  return (
    <table className="metric-tooltip-table">
      <tbody>
        {byName.map(([name, count]) => (
          <tr key={name}>
            <td className="name">{name}</td>
            <td className="count">{count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Per-skill breakdown for the skill-call tooltip. Rows are already sorted by
// count desc on the Rust side (see core/src/stats.rs::skill_usage). When a
// skill had any error, append "·err N" to its count cell so it stands out.
export function SkillBreakdownTooltip({ rows }: { rows: SkillUsage[] }) {
  const t = useT();
  if (rows.length === 0) {
    return <span className="metric-tooltip-empty">{t("viewer.timeline.tooltip_no_skills")}</span>;
  }
  return (
    <table className="metric-tooltip-table">
      <tbody>
        {rows.map((r) => (
          <tr key={r.skill_id}>
            <td className="name">{r.skill_id}</td>
            <td className="count">
              {r.count}
              {r.error_count > 0 ? ` · err ${r.error_count}` : ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// File-list tooltip for "files read" / "files written" agent metrics. Paths
// are deduped + insertion-ordered upstream (computeAgentStats); we just
// collapse middle segments here so very long absolute paths don't blow the
// tooltip out horizontally. Filename + last directory are always preserved.
export function FileListTooltip({ paths, emptyText }: { paths: string[]; emptyText: string }) {
  if (paths.length === 0) {
    return <span className="metric-tooltip-empty">{emptyText}</span>;
  }
  return (
    <ul className="metric-tooltip-files">
      {paths.map((p) => (
        <li key={p} className="metric-tooltip-file" title={p}>
          {compactMiddlePath(p)}
        </li>
      ))}
    </ul>
  );
}

// Line-chart tooltip for the agent-level "peak context" metric. X axis is
// node index (0, 1, 2, …) within the active agent — purely positional, no
// time semantics. Y axis is ratio*100, sourced from NodeViz.ratio so we reuse
// the same lookupContextWindow → peak fallback chain as the timeline.
//
// Nodes without usage data (user / tool_result / system) have viz.ctx == null
// and are skipped — the polyline connects across them, which is fine because
// the gap is meaningless to the user.
export function CtxCurveTooltip({
  nodes,
  vizById,
  emptyText,
}: {
  nodes: SessionNode[];
  vizById: Map<string, NodeViz>;
  emptyText: string;
}) {
  const t = useT();

  const points: Array<{ x: number; y: number; pct: number }> = [];
  let peakIdx = -1;
  let peakPct = -1;
  const W = 480;
  const H = 200;
  const padL = 36;
  const padR = 12;
  const padT = 10;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // Use the full node count as the x-axis domain (not just ctx-bearing nodes)
  // so users see at which point in the timeline the context spiked.
  const lastIdx = Math.max(0, nodes.length - 1);
  for (let i = 0; i < nodes.length; i++) {
    const v = vizById.get(nodes[i].id);
    if (!v || v.ctx == null) continue;
    const pct = v.ratio * 100;
    const x = padL + (lastIdx > 0 ? (i / lastIdx) * plotW : plotW / 2);
    const y = padT + plotH - (Math.min(100, pct) / 100) * plotH;
    points.push({ x, y, pct });
    if (pct > peakPct) {
      peakPct = pct;
      peakIdx = points.length - 1;
    }
  }

  if (points.length === 0) {
    return <span className="metric-tooltip-empty">{emptyText}</span>;
  }

  // Five Y grid lines at 0/25/50/75/100%.
  const yTicks = [0, 25, 50, 75, 100];
  // X ticks: 5 evenly spaced positions across the node range, integer-rounded.
  const xTickCount = Math.min(5, nodes.length);
  const xTicks: number[] = [];
  if (xTickCount === 1) {
    xTicks.push(0);
  } else {
    for (let i = 0; i < xTickCount; i++) {
      xTicks.push(Math.round((i / (xTickCount - 1)) * lastIdx));
    }
  }

  // Show per-point dots only when the timeline is short enough that they
  // don't visually merge into the line.
  const showDots = points.length <= 30;

  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  return (
    <div className="metric-tooltip-ctx">
      <div className="metric-tooltip-ctx-caption">{t("viewer.timeline.ctx_curve_caption")}</div>
      <svg
        className="ctx-curve"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t("viewer.timeline.ctx_curve_aria")}
      >
        {yTicks.map((p) => {
          const y = padT + plotH - (p / 100) * plotH;
          return (
            <g key={`y${p}`}>
              <line className="ctx-curve-grid" x1={padL} y1={y} x2={W - padR} y2={y} />
              <text className="ctx-curve-axis" x={padL - 4} y={y + 3} textAnchor="end">
                {p}%
              </text>
            </g>
          );
        })}
        {xTicks.map((idx) => {
          const x = padL + (lastIdx > 0 ? (idx / lastIdx) * plotW : plotW / 2);
          return (
            <text
              key={`x${idx}`}
              className="ctx-curve-axis"
              x={x}
              y={H - padB + 12}
              textAnchor="middle"
            >
              {idx}
            </text>
          );
        })}
        <line
          className="ctx-curve-grid"
          x1={padL}
          y1={padT + plotH}
          x2={W - padR}
          y2={padT + plotH}
        />
        <line
          className="ctx-curve-grid"
          x1={padL}
          y1={padT}
          x2={padL}
          y2={padT + plotH}
        />
        {points.length === 1 ? null : (
          <polyline className="ctx-curve-line" points={polyline} />
        )}
        {showDots &&
          points.map((p, i) => (
            <circle
              key={i}
              className={i === peakIdx ? "ctx-curve-dot is-peak" : "ctx-curve-dot"}
              cx={p.x}
              cy={p.y}
              r={i === peakIdx ? 3 : 2}
            />
          ))}
        {!showDots && peakIdx >= 0 && (
          <circle
            className="ctx-curve-dot is-peak"
            cx={points[peakIdx].x}
            cy={points[peakIdx].y}
            r={3}
          />
        )}
      </svg>
    </div>
  );
}

// Line-chart tooltip for the agent-level "TPS" metric. Mirrors the shape of
// CtxCurveTooltip but the y-axis is auto-scaled to the observed TPS range
// (no fixed 0–100 scale — model speeds vary by an order of magnitude).
//
// `series` already has forward-fill applied on the Rust side: each point's
// `interpolated` flag tells us whether to draw the segment leading into it
// as a solid or dashed line. We split the polyline into runs of the same
// segment kind and render each as its own <polyline> so the dash style only
// affects the interpolated sections.
//
// Empty series (no qualifying turns at all) renders the empty hint instead
// of an axis with no data — same convention as the context curve.
export function TpsCurveTooltip({
  series,
  emptyText,
}: {
  series: TpsSeriesPoint[];
  emptyText: string;
}) {
  const t = useT();

  const W = 480;
  const H = 200;
  const padL = 44;
  const padR = 12;
  const padT = 10;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  if (series.length === 0) {
    return <span className="metric-tooltip-empty">{emptyText}</span>;
  }

  // Y range: 0 to slightly above the observed max so the peak point doesn't
  // sit flush against the chart top. Ceiling rounded to a tidy 5/10/50/100.
  const maxObs = Math.max(...series.map((p) => p.tps));
  const yMax = niceCeil(maxObs * 1.1);
  const yMin = 0;

  const lastIdx = Math.max(0, series.length - 1);
  const xOf = (i: number) =>
    padL + (lastIdx > 0 ? (i / lastIdx) * plotW : plotW / 2);
  const yOf = (v: number) =>
    padT + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  // Split the series into segments. A segment is a run of consecutive points
  // sharing the same `interpolated` flag *for the segment leading INTO that
  // point*. We treat segments[i] as "the line from i-1 to i", so the kind is
  // determined by series[i].interpolated.
  type Seg = { interpolated: boolean; pts: Array<{ x: number; y: number }> };
  const segments: Seg[] = [];
  if (series.length > 0) {
    // First point starts a "real" segment by definition (no incoming line).
    segments.push({ interpolated: false, pts: [{ x: xOf(0), y: yOf(series[0].tps) }] });
    for (let i = 1; i < series.length; i++) {
      const interp = series[i].interpolated;
      const last = segments[segments.length - 1];
      const pt = { x: xOf(i), y: yOf(series[i].tps) };
      if (last.interpolated === interp) {
        last.pts.push(pt);
      } else {
        // Bridge the join: the new segment starts at the previous point so
        // there's no visual gap at the transition.
        const prev = last.pts[last.pts.length - 1];
        segments.push({ interpolated: interp, pts: [prev, pt] });
      }
    }
  }

  // Five evenly spaced y ticks from 0 to yMax.
  const yTicks: number[] = [];
  for (let i = 0; i <= 4; i++) yTicks.push((yMax / 4) * i);

  const xTickCount = Math.min(5, series.length);
  const xTicks: number[] = [];
  if (xTickCount === 1) {
    xTicks.push(0);
  } else {
    for (let i = 0; i < xTickCount; i++) {
      xTicks.push(Math.round((i / (xTickCount - 1)) * lastIdx));
    }
  }

  const showDots = series.length <= 30;

  // Highlight the highest *real* (non-interpolated) sample — the peak is the
  // most diagnostic single value on the curve.
  let peakIdx = -1;
  let peakTps = -1;
  for (let i = 0; i < series.length; i++) {
    if (!series[i].interpolated && series[i].tps > peakTps) {
      peakTps = series[i].tps;
      peakIdx = i;
    }
  }

  return (
    <div className="metric-tooltip-ctx">
      <div className="metric-tooltip-ctx-caption">{t("viewer.timeline.tps_curve_caption")}</div>
      <svg
        className="ctx-curve tps-curve"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t("viewer.timeline.tps_curve_aria")}
      >
        {yTicks.map((v) => {
          const y = yOf(v);
          return (
            <g key={`y${v}`}>
              <line className="ctx-curve-grid" x1={padL} y1={y} x2={W - padR} y2={y} />
              <text className="ctx-curve-axis" x={padL - 4} y={y + 3} textAnchor="end">
                {Math.round(v)}
              </text>
            </g>
          );
        })}
        {xTicks.map((idx) => (
          <text
            key={`x${idx}`}
            className="ctx-curve-axis"
            x={xOf(idx)}
            y={H - padB + 12}
            textAnchor="middle"
          >
            {idx}
          </text>
        ))}
        <line className="ctx-curve-grid" x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} />
        <line className="ctx-curve-grid" x1={padL} y1={padT} x2={padL} y2={padT + plotH} />
        {segments.map((seg, i) => {
          if (seg.pts.length < 2) return null;
          const pts = seg.pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
          return (
            <polyline
              key={i}
              className={seg.interpolated ? "ctx-curve-line is-interpolated" : "ctx-curve-line"}
              points={pts}
            />
          );
        })}
        {showDots &&
          series.map((p, i) => {
            const cx = xOf(i);
            const cy = yOf(p.tps);
            const cls = i === peakIdx
              ? "ctx-curve-dot is-peak"
              : p.interpolated
                ? "ctx-curve-dot is-interpolated"
                : "ctx-curve-dot";
            return <circle key={i} className={cls} cx={cx} cy={cy} r={i === peakIdx ? 3 : 2} />;
          })}
        {!showDots && peakIdx >= 0 && (
          <circle
            className="ctx-curve-dot is-peak"
            cx={xOf(peakIdx)}
            cy={yOf(series[peakIdx].tps)}
            r={3}
          />
        )}
      </svg>
    </div>
  );
}

// Round a number up to a friendly axis ceiling. Picks 1 / 2 / 5 × 10^k so
// the y-axis labels stay tidy regardless of input magnitude.
function niceCeil(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 1;
  const exp = Math.floor(Math.log10(x));
  const base = Math.pow(10, exp);
  const norm = x / base;
  let nice: number;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}
