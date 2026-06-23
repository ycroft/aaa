import type { NodeViz } from "../viz";

const TOOL_CHIPS_VISIBLE = 4;

export function ToolChips({
  viz,
  onPick,
  onEnterSubagent,
}: {
  viz: NodeViz | undefined;
  onPick: (name: string) => void;
  onEnterSubagent: (agentId: string) => void;
}) {
  if (!viz || (viz.toolNames.length === 0 && !viz.subagentLabel)) return null;
  const names = viz.toolNames;
  const visible = names.slice(0, TOOL_CHIPS_VISIBLE);
  const hidden = names.slice(TOOL_CHIPS_VISIBLE);
  return (
    <div className="node-tools">
      {viz.subagentLabel && viz.subagentId && (
        <span
          className="tool-chip subagent"
          title={`进入子代理：${viz.subagentLabel}`}
          onClick={(e) => {
            e.stopPropagation();
            onEnterSubagent(viz.subagentId!);
          }}
        >
          <span>🐣 {viz.subagentLabel}</span>
        </span>
      )}
      {visible.map((name) => {
        const count = viz.toolCounts[name] ?? 1;
        return (
          <span
            key={name}
            className="tool-chip"
            title={`只看使用了 ${name} 的节点`}
            onClick={(e) => {
              e.stopPropagation();
              onPick(name);
            }}
          >
            <span>{name}</span>
            {count > 1 && <span className="count">×{count}</span>}
          </span>
        );
      })}
      {hidden.length > 0 && (
        <span className="tool-chip more" title={hidden.join(", ")}>+{hidden.length}</span>
      )}
    </div>
  );
}
