import { useEffect, useMemo, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import type {
  RemoteOpenResult,
  RemoteProgressEvent,
  SyncPhase,
  SyncProgress,
} from "../types";
import { formatBytes } from "../format";
import { useT, type TKey } from "../i18n";

interface Props {
  open: boolean;
  taskId: string | null;
  remoteLabel: string;
  providerLabel: string;
  onSuccess: (result: RemoteOpenResult) => void;
  onCancelled: () => void;
  onError: (err: string) => void;
  /** Imperative trigger: when this changes (truthy), kick off the open. */
  startKey: string | null;
  remoteId: string;
  providerId: string;
}

const PHASE_KEYS: Record<SyncPhase, TKey> = {
  connecting: "remote_progress.phase.connecting",
  probing: "remote_progress.phase.probing",
  listing: "remote_progress.phase.listing",
  downloading: "remote_progress.phase.downloading",
  cleaning: "remote_progress.phase.cleaning",
  done: "remote_progress.phase.done",
  up_to_date: "remote_progress.phase.up_to_date",
  probing_remote: "remote_progress.phase.probing_remote",
  incremental_query: "remote_progress.phase.incremental_query",
  incremental_apply: "remote_progress.phase.incremental_apply",
};

const INITIAL: SyncProgress = {
  phase: "connecting",
  current_file: null,
  files_done: 0,
  files_total: 0,
  bytes_done: 0,
  bytes_total: 0,
};

export function RemoteProgressDialog({
  open,
  taskId,
  remoteLabel,
  providerLabel,
  onSuccess,
  onCancelled,
  onError,
  startKey,
  remoteId,
  providerId,
}: Props) {
  const t = useT();
  const [progress, setProgress] = useState<SyncProgress>(INITIAL);
  const [cancelling, setCancelling] = useState(false);

  // Subscribe to progress events filtered by our task_id.
  useEffect(() => {
    if (!open || !taskId) return;
    setProgress(INITIAL);
    setCancelling(false);
    let unlisten: UnlistenFn | null = null;
    let active = true;
    void listen<RemoteProgressEvent>("remote-progress", (e) => {
      if (!active) return;
      if (e.payload.task_id !== taskId) return;
      setProgress(e.payload.progress);
    }).then((fn) => {
      if (!active) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [open, taskId]);

  // Drive the actual remote_open call from a startKey trigger so the parent
  // controls when the work begins (and we tear down naturally on close).
  useEffect(() => {
    if (!open || !startKey || !taskId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.remoteOpen(remoteId, providerId, taskId);
        if (cancelled) return;
        onSuccess(res);
      } catch (e: any) {
        if (cancelled) return;
        const msg = String(e);
        if (msg.includes("CANCELLED")) {
          onCancelled();
        } else {
          onError(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [startKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pct = useMemo(() => {
    if (progress.phase === "done" || progress.phase === "up_to_date") return 100;
    if (progress.phase === "incremental_query" || progress.phase === "incremental_apply") {
      if (progress.files_total > 0) {
        return Math.min(100, Math.round((progress.files_done / progress.files_total) * 100));
      }
      return null;
    }
    if (progress.phase !== "downloading") return null;
    if (progress.bytes_total > 0) {
      return Math.min(100, Math.round((progress.bytes_done / progress.bytes_total) * 100));
    }
    if (progress.files_total > 0) {
      return Math.min(100, Math.round((progress.files_done / progress.files_total) * 100));
    }
    return null;
  }, [progress]);

  async function doCancel() {
    if (!taskId || cancelling) return;
    setCancelling(true);
    try {
      await api.remoteCancel(taskId);
    } catch {
      /* ignore — the open will likely return CANCELLED shortly anyway */
    }
  }

  if (!open) return null;

  const indeterminate = pct == null;
  const phaseLabel = t(PHASE_KEYS[progress.phase] ?? "remote_progress.phase.connecting");

  return (
    <div className="overlay" data-hint={t("remote_progress.overlay_hint")}>
      <div className="modal progress-modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="title">
            {t("remote_progress.title", { label: remoteLabel, provider: providerLabel })}
          </div>
        </div>
        <div className="modal-body">
          <div className="progress-step">{phaseLabel}</div>
          <div className={`progress-bar${indeterminate ? " indeterminate" : ""}`}>
            <div
              className="progress-fill"
              style={indeterminate ? undefined : { width: `${pct}%` }}
            />
          </div>
          <div className="progress-meta">
            <span>
              {progress.files_total > 0
                ? t("remote_progress.files_count", { done: progress.files_done, total: progress.files_total })
                : t("remote_progress.files_unknown_total", { done: progress.files_done })}
            </span>
            <span>·</span>
            <span>
              {formatBytes(progress.bytes_done)}
              {progress.bytes_total > 0 ? ` / ${formatBytes(progress.bytes_total)}` : ""}
            </span>
            {pct != null && <><span>·</span><span>{pct}%</span></>}
          </div>
          {progress.current_file && (
            <div className="progress-file" title={progress.current_file}>
              {progress.current_file}
            </div>
          )}
          {cancelling && (
            <div className="help" style={{ marginTop: 10 }}>
              {t("remote_progress.cancelling_help")}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={doCancel} disabled={cancelling}>
            {cancelling ? t("remote_progress.cancelling") : t("remote_progress.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
