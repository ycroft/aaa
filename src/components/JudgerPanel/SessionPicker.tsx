import { useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import type { SessionSummary, SessionRef } from "../../types";

export interface PickerSource {
  providerId: string;
  root: string;
  sessions: SessionSummary[];
}

interface Props {
  sources: PickerSource[];
  selected: Map<string, SessionRef>;     // key: source_path
  onChange: (next: Map<string, SessionRef>) => void;
}

export function SessionPicker({ sources, selected, onChange }: Props) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");

  const flat = useMemo(() => {
    return sources.flatMap((src) =>
      src.sessions.map((s) => ({ src, s })),
    );
  }, [sources]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return flat;
    return flat.filter(
      ({ s }) =>
        (s.title ?? "").toLowerCase().includes(f) ||
        (s.cwd ?? "").toLowerCase().includes(f) ||
        s.session_id.toLowerCase().includes(f),
    );
  }, [flat, filter]);

  const toggle = (_providerId: string, s: SessionSummary) => {
    const key = s.source_path;
    const next = new Map(selected);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.set(key, {
        session_id: s.session_id,
        source_path: s.source_path,
        title: s.title ?? null,
        cwd: s.cwd ?? null,
      });
    }
    onChange(next);
  };

  const removeFromQueue = (sourcePath: string) => {
    const next = new Map(selected);
    next.delete(sourcePath);
    onChange(next);
  };

  const queue = useMemo(() => Array.from(selected.values()), [selected]);
  const providerOf = (sourcePath: string) =>
    sources.find((src) => src.sessions.some((s) => s.source_path === sourcePath))
      ?.providerId ?? "";

  return (
    <div className="session-picker">
      <div className="session-picker-section">
        <input
          type="search"
          placeholder={t("judger.start.sessions_hint")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="session-picker-list">
          {filtered.length === 0 && <div className="muted">—</div>}
          {filtered.map(({ src, s }) => {
            const checked = selected.has(s.source_path);
            return (
              <label key={`${src.providerId}::${s.source_path}`} className="row">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(src.providerId, s)}
                />
                <span className="title">{s.title ?? s.session_id.slice(0, 8)}</span>
                <span className="provider">{src.providerId}</span>
                <span className="cwd">{s.cwd ?? ""}</span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="session-picker-section">
        <div className="section-header">
          {t("judger.start.queue_label")} ({selected.size})
        </div>
        <div className="session-picker-queue">
          {queue.length === 0 ? (
            <div className="muted">{t("judger.start.queue_empty")}</div>
          ) : (
            queue.map((ref) => (
              <div key={ref.source_path} className="queue-row">
                <span className="title">
                  {ref.title ?? ref.session_id.slice(0, 8)}
                </span>
                <span className="provider">{providerOf(ref.source_path)}</span>
                <button
                  type="button"
                  className="remove"
                  onClick={() => removeFromQueue(ref.source_path)}
                  title={t("judger.start.remove_session")}
                  aria-label={t("judger.start.remove_session")}
                >
                  ×
                </button>
                <span className="cwd">{ref.cwd ?? ""}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
