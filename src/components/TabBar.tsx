import type { PanelDescriptor } from "../panels";
import { useT } from "../i18n";

interface Props {
  panels: PanelDescriptor[];
  activeId: string | null;
  onPick: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

/** Top-level tab strip that lets the user keep multiple data sources open in
 *  parallel. Each tab is one mounted panel; closing a tab destroys its
 *  internal state. The "+" button opens the source picker (ProviderSplash)
 *  so a new tab can be added without going through any menu. */
export function TabBar({ panels, activeId, onPick, onClose, onNew }: Props) {
  const t = useT();
  return (
    <div className="tabbar" role="tablist" data-hint={t("tabs.bar_hint")}>
      <div className="tabbar-tabs">
        {panels.map((p) => {
          const active = p.id === activeId;
          return (
            <div
              key={p.id}
              role="tab"
              aria-selected={active}
              className={`tab${active ? " active" : ""}`}
              onMouseDown={(e) => {
                // Middle-click closes — matches browser/IDE convention.
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(p.id);
                  return;
                }
                if (e.button === 0) onPick(p.id);
              }}
              data-hint={p.subtitle ? `${p.title} · ${p.subtitle}` : p.title}
              title={p.subtitle ? `${p.title} · ${p.subtitle}` : p.title}
            >
              <span className="tab-icon" aria-hidden="true">{p.icon}</span>
              <span className="tab-title">{p.title}</span>
              {p.subtitle && <span className="tab-subtitle">{p.subtitle}</span>}
              <button
                type="button"
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(p.id);
                }}
                aria-label={t("tabs.close_aria", { title: p.title })}
                title={t("tabs.close_hint")}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="tab-new"
        onClick={onNew}
        title={t("tabs.new_hint")}
        data-hint={t("tabs.new_hint")}
        aria-label={t("tabs.new_aria")}
      >
        +
      </button>
    </div>
  );
}
