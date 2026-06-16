import { useEffect, useState, useCallback } from "react";
import { useI18n } from "../../i18n";
import { api } from "../../api";
import type { JudgmentListItem } from "../../types";

interface Props {
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  /** Bumped whenever an external action (start / delete) requires a refetch. */
  refreshKey: number;
}

export function JudgmentList({ selectedRunId, onSelect, refreshKey }: Props) {
  const { t } = useI18n();
  const [items, setItems] = useState<JudgmentListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const list = await api.judgerList();
      setItems(list);
    } catch (e) {
      setError(String(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch, refreshKey]);

  // Background poll: while any judgment is still pending, silently refetch
  // every 5s so the user sees status flip to done/failed without clicking ↻.
  // When everything is settled the interval shuts off — no idle work.
  const hasPending = items.some((it) => it.status === "pending");
  useEffect(() => {
    if (!hasPending) return;
    const id = setInterval(() => void refetch(true), 5000);
    return () => clearInterval(id);
  }, [hasPending, refetch]);

  return (
    <div className="judger-list">
      <div className="header">
        <span>{t("judger.list.header")}</span>
        <button
          type="button"
          className="refresh"
          title={t("judger.list.refresh")}
          onClick={() => void refetch(false)}
          disabled={loading}
        >
          ↻
        </button>
      </div>
      <div className="items">
        {loading && <div className="muted">…</div>}
        {error && <div className="error">{error}</div>}
        {!loading && items.length === 0 && (
          <div className="muted">{t("judger.list.empty")}</div>
        )}
        {items.map((it) => (
          <button
            key={it.meta.run_id}
            type="button"
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
              <span className="ts">
                {it.meta.started_at.slice(0, 16).replace("T", " ")}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
