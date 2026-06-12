import { useRef, useState } from "react";
import { useT } from "../../../i18n";
import { useDropdownDismiss } from "../hooks/useDropdownDismiss";

export function ToolFilterDropdown({
  universe,
  selected,
  onChange,
}: {
  universe: Array<{ name: string; count: number }>;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useDropdownDismiss(open, rootRef, () => setOpen(false));

  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange(next);
  };

  const label = selected.size === 0
    ? t("viewer.timeline.tool_filter_idle")
    : t("viewer.timeline.tool_filter_active", { count: selected.size });

  return (
    <div className="tool-filter" ref={rootRef}>
      <button
        type="button"
        className={`tool-filter-trigger${selected.size > 0 ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={t("viewer.timeline.tool_filter_hint")}
      >
        {label}
      </button>
      {open && (
        <div className="tool-filter-menu" role="menu">
          {universe.length === 0 && (
            <div className="tool-filter-item" style={{ opacity: 0.6 }}>
              <span className="name">{t("viewer.timeline.tool_filter_empty")}</span>
            </div>
          )}
          {universe.map(({ name, count }) => {
            const checked = selected.has(name);
            return (
              <div
                key={name}
                className="tool-filter-item"
                onClick={() => toggle(name)}
                role="menuitemcheckbox"
                aria-checked={checked}
              >
                <span>{checked ? "☑" : "☐"}</span>
                <span className="name">{name}</span>
                <span className="count">{count}</span>
              </div>
            );
          })}
          {universe.length > 0 && (
            <div className="tool-filter-actions">
              <button onClick={() => onChange(new Set(universe.map((u) => u.name)))}>{t("viewer.timeline.tool_filter_select_all")}</button>
              <button onClick={() => onChange(new Set())}>{t("viewer.timeline.tool_filter_clear")}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
