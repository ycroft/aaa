import { useEffect, useState, useCallback } from "react";
import { useI18n } from "../../i18n";
import { api } from "../../api";
import type { JudgmentListItem } from "../../types";

interface Props {
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onStartNew: () => void;
  /** Bumped whenever an external action (start / delete) requires a refetch. */
  refreshKey: number;
}

export function JudgmentList({ selectedRunId, onSelect, onStartNew, refreshKey }: Props) {
  const { t } = useI18n();
  const [items, setItems] = useState<JudgmentListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.judgerList();
      setItems(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refetch(); }, [refetch, refreshKey]);

  return (
    <aside className="judger-list">
      <button className="new" onClick={onStartNew}>
        {t("judger.list.new_button")}
      </button>
      <div className="header">{t("judger.list.header")}</div>
      <div className="items">
        {loading && <div className="muted">…</div>}
        {error && <div className="error">{error}</div>}
        {!loading && items.length === 0 && (
          <div className="muted">{t("judger.list.empty")}</div>
        )}
        {items.map((it) => (
          <button
            key={it.meta.run_id}
            className={`row ${selectedRunId === it.meta.run_id ? "active" : ""}`}
            onClick={() => onSelect(it.meta.run_id)}
          >
            <div className="title">
              {it.meta.session.title ?? it.meta.session.session_id.slice(0, 8)}
            </div>
            <div className="sub">
              <span className={`status ${it.status}`}>
                {t(`judger.list.status_${it.status}` as const)}
              </span>
              <span className="provider">{it.meta.provider_id}</span>
              <span className="ts">{it.meta.started_at.slice(0, 16).replace("T", " ")}</span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}
