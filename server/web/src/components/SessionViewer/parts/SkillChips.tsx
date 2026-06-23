import type { NodeViz } from "../viz";

export function SkillChips({ viz }: { viz: NodeViz | undefined }) {
  if (!viz || viz.skills.length === 0) return null;
  return (
    <div className="node-skills">
      {viz.skills.map((s, i) => {
        const label = s.name && s.name !== s.id ? `${s.name} (${s.id})` : s.id;
        const icon = s.source === "user" ? "🧩" : "🤖";
        const title = `Skill: ${s.id}（来源：${s.source}）`;
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
