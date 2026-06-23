import { compactMiddlePath } from "../../../format";
import type { SessionNode, SkillUsage, TpsSeriesPoint } from "../../../types";
import type { NodeViz } from "../viz";

export function ToolBreakdownTooltip({ byName }: { byName: Array<[string, number]> }) {
  if (byName.length === 0) {
    return <span className="metric-tooltip-empty">无工具调用</span>;
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

export function SkillBreakdownTooltip({ rows }: { rows: SkillUsage[] }) {
  if (rows.length === 0) {
    return <span className="metric-tooltip-empty">无 Skill 调用</span>;
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

export function CtxCurveTooltip({
  nodes,
  vizById,
  emptyText,
}: {
  nodes: SessionNode[];
  vizById: Map<string, NodeViz>;
  emptyText: string;
}) {
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

  const yTicks = [0, 25, 50, 75, 100];
  const xTickCount = Math.min(5, nodes.length);
  const xTicks: number[] = [];
  if (xTickCount === 1) {
    xTicks.push(0);
  } else {
    for (let i = 0; i < xTickCount; i++) {
      xTicks.push(Math.round((i / (xTickCount - 1)) * lastIdx));
    }
  }

  const showDots = points.length <= 30;
  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  return (
    <div className="metric-tooltip-ctx">
      <div className="metric-tooltip-ctx-caption">上下文用量走势（节点序号 → 占比%）</div>
      <svg
        className="ctx-curve"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="上下文用量折线图"
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
            <text key={`x${idx}`} className="ctx-curve-axis" x={x} y={H - padB + 12} textAnchor="middle">
              {idx}
            </text>
          );
        })}
        <line className="ctx-curve-grid" x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} />
        <line className="ctx-curve-grid" x1={padL} y1={padT} x2={padL} y2={padT + plotH} />
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

export function TpsCurveTooltip({
  series,
  emptyText,
}: {
  series: TpsSeriesPoint[];
  emptyText: string;
}) {
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

  const maxObs = Math.max(...series.map((p) => p.tps));
  const yMax = niceCeil(maxObs * 1.1);
  const yMin = 0;

  const lastIdx = Math.max(0, series.length - 1);
  const xOf = (i: number) =>
    padL + (lastIdx > 0 ? (i / lastIdx) * plotW : plotW / 2);
  const yOf = (v: number) =>
    padT + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

  type Seg = { interpolated: boolean; pts: Array<{ x: number; y: number }> };
  const segments: Seg[] = [];
  if (series.length > 0) {
    segments.push({ interpolated: false, pts: [{ x: xOf(0), y: yOf(series[0].tps) }] });
    for (let i = 1; i < series.length; i++) {
      const interp = series[i].interpolated;
      const last = segments[segments.length - 1];
      const pt = { x: xOf(i), y: yOf(series[i].tps) };
      if (last.interpolated === interp) {
        last.pts.push(pt);
      } else {
        const prev = last.pts[last.pts.length - 1];
        segments.push({ interpolated: interp, pts: [prev, pt] });
      }
    }
  }

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
      <div className="metric-tooltip-ctx-caption">TPS 走势（token/s，虚线为前向填充估算）</div>
      <svg
        className="ctx-curve tps-curve"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="TPS 折线图"
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
          <text key={`x${idx}`} className="ctx-curve-axis" x={xOf(idx)} y={H - padB + 12} textAnchor="middle">
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
