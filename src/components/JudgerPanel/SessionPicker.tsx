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

  return (
    <div className="session-picker">
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
      <div className="footer">
        {t("judger.start.sessions_label")}: {selected.size}
      </div>
    </div>
  );
}
