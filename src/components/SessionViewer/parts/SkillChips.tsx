import { useT } from "../../../i18n";
import type { NodeViz } from "../viz";

/// Per-node skill chip — one chip per skill detected on this node.
/// User-source (slash invocation / opencode injection) shows a 🧩 marker;
/// Assistant-source (Skill tool_use) shows a 🤖 marker so the user can
/// tell at a glance who triggered the skill.
export function SkillChips({ viz }: { viz: NodeViz | undefined }) {
  const t = useT();
  if (!viz || viz.skills.length === 0) return null;
  return (
    <div className="node-skills">
      {viz.skills.map((s, i) => {
        const label = s.name && s.name !== s.id ? `${s.name} (${s.id})` : s.id;
        const icon = s.source === "user" ? "🧩" : "🤖";
        const title = t("viewer.timeline.skill_chip_hint", {
          id: s.id,
          source: s.source,
        });
        return (
          <span
            key={`${s.id}-${i}`}
            className={`skill-chip src-${s.source}`}
            title={title}
          >
            <span>{icon} {label}</span>
          </span>
        );
      })}
    </div>
  );
}
