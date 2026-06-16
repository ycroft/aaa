import { useEffect, useMemo, useState } from "react";
import type { SessionFilter, SessionSummary } from "../types";
import { formatRelativeTime, formatTokens, shortPath } from "../format";
import { useT } from "../i18n";

interface Props {
  sessions: SessionSummary[];
  filter: SessionFilter;
  activeId: string | null;
  onPick: (s: SessionSummary) => void;
  /** True while the parent panel is scanning the data source. We use this to
   *  show a "scanning…" spinner instead of the "no matches" empty text on the
   *  first open of a large source — list_sessions can take 1-2s on big logs. */
  busy: boolean;
  /** Right-click → "Judge this session". When omitted the row falls back
   *  to the browser's default context menu so we don't trap clicks. */
  onJudgeSession?: (s: SessionSummary) => void;
}

// Convert filter.timePreset (+ custom range) to an absolute [from, to] window in ms.
// Returns null bounds where the side is open-ended.
function resolveTimeWindow(filter: SessionFilter): { from: number | null; to: number | null } {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  switch (filter.timePreset) {
    case "24h":
      return { from: now - day, to: null };
    case "1w":
      return { from: now - 7 * day, to: null };
    case "1m":
      return { from: now - 30 * day, to: null };
    case "custom": {
      // YYYY-MM-DD strings — treat start as 00:00 local, end as 23:59:59.999 local for inclusive range.
      const from = filter.customStart ? Date.parse(filter.customStart + "T00:00:00") : null;
      const to = filter.customEnd ? Date.parse(filter.customEnd + "T23:59:59.999") : null;
      return {
        from: Number.isNaN(from as number) ? null : from,
        to: Number.isNaN(to as number) ? null : to,
      };
    }
    case "all":
    default:
      return { from: null, to: null };
  }
}

export function SessionList({ sessions, filter, activeId, onPick, busy, onJudgeSession }: Props) {
  const t = useT();
  // Right-click context menu state. Stored at App-relative coordinates and
  // rendered as a fixed-position popover near the cursor. window.confirm()
  // used to stand in here but Tauri's WebView either auto-confirms or yields
  // empty strings depending on the platform — neither matches the design
  // spec of "show a menu, let the user pick".
  const [menu, setMenu] = useState<
    | { x: number; y: number; session: SessionSummary }
    | null
  >(null);

  // Close on click-outside (any pointerdown that isn't ours) and on Esc.
  // Pointerdown rather than click so the menu disappears the moment the
  // user starts a new gesture, even before mouseup — feels snappier.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".session-context-menu")) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    // Capture phase so we run before any onClick on the row beneath.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const filtered = useMemo(() => {
    const f = filter.search.trim().toLowerCase();
    const cwd = filter.cwd;
    const { from, to } = resolveTimeWindow(filter);

    return sessions.filter((s) => {
      // Text search across title / cwd / id / branch.
      if (f) {
        const fields = [s.title, s.cwd, s.session_id, s.git_branch]
          .filter(Boolean)
          .map(String);
        if (!fields.some((v) => v.toLowerCase().includes(f))) return false;
      }
      // Exact cwd match (case-sensitive — paths usually are).
      if (cwd && s.cwd !== cwd) return false;
      // Time window: prefer ended_at, fall back to started_at. Sessions without timestamps
      // pass only when no time bound is set.
      if (from != null || to != null) {
        const stamp = s.ended_at ?? s.started_at;
        if (!stamp) return false;
        const t = Date.parse(stamp);
        if (Number.isNaN(t)) return false;
        if (from != null && t < from) return false;
        if (to != null && t > to) return false;
      }
      return true;
    });
  }, [sessions, filter]);

  return (
    <div className="sidebar">
      <div className="sb-head">
        <span>{t("session_list.heading")}</span>
        <span className="count">{filtered.length}/{sessions.length}</span>
      </div>
      <div className="sb-list">
        {busy && sessions.length === 0 ? (
          <div className="sb-loading">
            <div className="sb-loading-spinner" aria-hidden="true" />
            <div className="sb-loading-text">{t("session_list.scanning")}</div>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 18, color: "var(--text-3)", fontSize: 12 }}>
            {t("session_list.empty")}
          </div>
        ) : null}
        {filtered.map((s) => (
          <div
            key={s.source_path}
            className={`session-row${activeId === s.source_path ? " active" : ""}`}
            onClick={() => onPick(s)}
            onContextMenu={
              onJudgeSession
                ? (e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, session: s });
                  }
                : undefined
            }
            data-hint={t("session_list.open_hint", { id: s.session_id })}
          >
            <div className="title">{s.title || s.session_id}</div>
            <div className="meta">
              <span title={s.cwd ?? ""}>{shortPath(s.cwd, 40)}</span>
              {s.git_branch && <span className="pill">{s.git_branch}</span>}
              {(s.used_skills ?? []).slice(0, 3).map((sid) => (
                <span
                  key={`skill-${sid}`}
                  className="pill skill-pill"
                  title={t("session_list.skill_pill_hint", { id: sid })}
                >
                  🧩 {sid}
                </span>
              ))}
              {(s.used_skills?.length ?? 0) > 3 && (
                <span
                  className="pill skill-pill more"
                  title={(s.used_skills ?? []).slice(3).join(", ")}
                >
                  {t("session_list.skill_more", { n: (s.used_skills?.length ?? 0) - 3 })}
                </span>
              )}
              <span>{formatRelativeTime(s.ended_at ?? s.started_at, t)}</span>
              <span className="pill">{t("session_list.msgs_pill", { n: s.message_count })}</span>
              <span className="pill" title={t("session_list.peak_ctx_hint")}>
                {t("session_list.peak_ctx", { tokens: formatTokens(s.peak_context_tokens) })}
              </span>
            </div>
          </div>
        ))}
      </div>
      {menu && onJudgeSession && (
        <div
          className="session-context-menu"
          // Fixed-position so the menu lives outside the scrolling list
          // container and isn't clipped by `overflow: hidden` on the sidebar.
          style={{ position: "fixed", top: menu.y, left: menu.x, zIndex: 200 }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const s = menu.session;
              setMenu(null);
              onJudgeSession(s);
            }}
          >
            {t("session_list.context.judge")}
          </button>
        </div>
      )}
    </div>
  );
}
