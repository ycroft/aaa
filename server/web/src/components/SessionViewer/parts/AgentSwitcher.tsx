import { useRef, useState } from "react";
import type { SubAgentSession } from "../../../types";
import { useDropdownDismiss } from "../hooks/useDropdownDismiss";

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

export function AgentSwitcher({
  subagents,
  activeAgentId,
  onPick,
}: {
  subagents: SubAgentSession[];
  activeAgentId: string | null;
  onPick: (agentId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useDropdownDismiss(open, rootRef, () => setOpen(false));

  const triggerLabel = activeAgentId
    ? (() => {
        const sa = subagents.find((s) => s.agent_id === activeAgentId);
        return sa ? `🐣 ${sa.agent_type}@${sa.type_ordinal}` : "子代理";
      })()
    : "主代理";

  const pick = (next: string | null) => {
    onPick(next);
    setOpen(false);
  };

  return (
    <div className="agent-switcher" ref={rootRef}>
      <button
        type="button"
        className={`agent-switcher-trigger${activeAgentId ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="切换查看的 Agent"
      >
        Agent · <span className="cur">{triggerLabel}</span> ▾
      </button>
      {open && (
        <div className="agent-switcher-menu" role="menu">
          <div
            className={`agent-switcher-item${activeAgentId === null ? " selected" : ""}`}
            role="menuitemradio"
            aria-checked={activeAgentId === null}
            onClick={() => pick(null)}
          >
            <span className="dot">{activeAgentId === null ? "●" : "○"}</span>
            <span className="name">主代理</span>
          </div>
          {subagents.map((sa) => {
            const sel = activeAgentId === sa.agent_id;
            const aside = sa.kind === "aside_question";
            return (
              <div
                key={sa.agent_id}
                className={`agent-switcher-item${sel ? " selected" : ""}${aside ? " aside" : ""}`}
                role="menuitemradio"
                aria-checked={sel}
                onClick={() => pick(sa.agent_id)}
                title={aside ? "侧链会话（/aside 镜像）" : sa.description ?? ""}
              >
                <span className="dot">{sel ? "●" : "○"}</span>
                <span className="name mono">{sa.agent_type}@{sa.type_ordinal}</span>
                {aside && <span className="kind-tag">（侧链）</span>}
                {sa.description && (
                  <span className="desc">{truncate(sa.description, 36)}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
