import { useEffect, useState, useCallback } from "react";
import { useI18n } from "../../i18n";
import { api } from "../../api";
import type { JudgmentDetail as JD } from "../../types";
import { RubricView } from "./RubricView";

interface Props {
  runId: string;
  onDeleted: () => void;
  onJumpToNode?: (sessionRef: string, nodeId: string) => void;
}

type Tab = "rubric" | "prompt" | "bundle" | "raw";

export function JudgmentDetail({ runId, onDeleted, onJumpToNode }: Props) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<JD | null>(null);
  const [tab, setTab] = useState<Tab>("rubric");
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setDetail(await api.judgerGet(runId));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [runId]);

  useEffect(() => { refetch(); }, [refetch]);

  async function onDelete() {
    if (!confirm(t("judger.detail.delete_confirm"))) return;
    await api.judgerDelete(runId);
    onDeleted();
  }

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <div className="muted">…</div>;

  const { meta, status, rubric, system_prompt, result_raw, files } = detail;

  return (
    <div className="judgment-detail">
      <header className="title-bar">
        <h2>
          {meta.session.title ?? meta.session.session_id.slice(0, 8)}
          <span className={`status ${status}`}>
            {t(`judger.list.status_${status}` as const)}
          </span>
        </h2>
        <div className="actions">
          <button onClick={() => api.judgerOpenWorkdir(runId)}>
            {t("judger.detail.open_workdir")}
          </button>
          <button onClick={onDelete} className="danger">
            {t("judger.detail.delete")}
          </button>
        </div>
      </header>

      <nav className="tabs">
        {(["rubric", "prompt", "bundle", "raw"] as Tab[]).map((k) => (
          <button
            key={k}
            className={tab === k ? "active" : ""}
            onClick={() => setTab(k)}
          >
            {t(`judger.detail.tab_${k}` as const)}
          </button>
        ))}
      </nav>

      <div className="body">
        {tab === "rubric" && (
          rubric ? (
            <RubricView
              rubric={rubric}
              onJumpToNode={(nid) => onJumpToNode?.(meta.session.source_path, nid)}
            />
          ) : (
            <div className="muted">
              {status === "failed"
                ? t("judger.detail.failed_hint")
                : t("judger.detail.pending_hint")}
            </div>
          )
        )}
        {tab === "prompt" && (
          <pre className="prompt">{system_prompt}</pre>
        )}
        {tab === "bundle" && (
          <ul className="files">
            {files.map((f) => <li key={f}>{f}</li>)}
          </ul>
        )}
        {tab === "raw" && (
          <pre className="raw">{result_raw ?? "(no result.json)"}</pre>
        )}
      </div>
    </div>
  );
}
