import { useT } from "../../../i18n";
import type { SkillUsage } from "../../../types";

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
