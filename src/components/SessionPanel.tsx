import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { api } from "../api";
import type {
  AppSettings,
  ProviderInfo,
  RemoteHostInfo,
  SessionDetail,
  SessionFilter,
  SessionSummary,
} from "../types";
import { EMPTY_FILTER } from "../types";
import { shortPath } from "../format";
import { useT } from "../i18n";

import { Toolbar } from "./Toolbar";
import { SessionList } from "./SessionList";
import { SessionViewer, type ViewerCounts } from "./SessionViewer";

export interface ActiveBackend {
  provider: ProviderInfo;
  root: string;
  remote: RemoteHostInfo | null;
}

/** Snapshot of a panel that the App layer needs to reflect outside the panel
 *  (status bar, AI dialog, menu disabled state). Pushed up via onMetaChange
 *  whenever it changes; the panel itself is the source of truth. */
export interface SessionPanelSnapshot {
  active: ActiveBackend;
  sessionCount: number;
  counts: ViewerCounts;
  status: string;
  error: string | null;
  busy: boolean;
  loadingSession: boolean;
  activeSession: SessionDetail | null;
  canExport: boolean;
  /** Mirrored so the menubar's "Expand all / Collapse all" label can flip
   *  to match the active panel's current state. */
  expandAll: boolean;
}

/** Imperative methods the App calls on the currently-active panel for global
 *  keyboard shortcuts and menu items. Hidden panels never receive these, so
 *  Ctrl+E / F5 / etc. always operate on what the user is looking at. */
export interface SessionPanelHandle {
  refresh: () => void;
  toggleExpandAll: () => void;
  exportSession: () => void;
  focusSessionSearch: () => void;
  focusMessageSearch: () => void;
}

interface Props {
  /** Whether this panel is the foreground one. Hidden panels stay mounted so
   *  their state (expand overrides, scroll position, filters) persists across
   *  tab switches. */
  visible: boolean;
  /** Backend bound to this panel for its lifetime. Only `root` may change
   *  later (when the user edits the provider override in Settings). */
  backend: ActiveBackend;
  settings: AppSettings;
  hubConnected: boolean;
  onMetaChange: (snapshot: SessionPanelSnapshot) => void;
  onOpenSource: () => void;
  onSettings: () => void;
  onAiAnalysis: () => void;
  onFeedback: () => void;
  /** Tooltip used by the toolbar when the AI button isn't ready. */
  aiNotReadyMsg: string | null;
}

export const SessionPanel = forwardRef<SessionPanelHandle, Props>(function SessionPanel(
  {
    visible,
    backend,
    settings,
    hubConnected,
    onMetaChange,
    onOpenSource,
    onSettings,
    onAiAnalysis,
    onFeedback,
    aiNotReadyMsg,
  },
  ref,
) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<SessionDetail | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [filter, setFilter] = useState<SessionFilter>(EMPTY_FILTER);
  const [expandAll, setExpandAll] = useState(false);
  const [counts, setCounts] = useState<ViewerCounts>({
    totalNodes: 0,
    expandedNodes: 0,
    peakCtx: 0,
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(() => t("status.ready"));
  const [error, setError] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [exporting, setExporting] = useState(false);

  // ---- Refresh sessions whenever the bound root changes (provider override,
  //      remote re-sync, etc.). Clearing activePath/activeSession lets the
  //      viewer fall back to its empty state until the user picks one. ----
  const refreshSessions = useCallback(async () => {
    setBusy(true);
    setStatus(t("status.scanning", { root: backend.root }));
    try {
      const list = await api.listSessions(backend.provider.id, backend.root);
      setSessions(list);
      setStatus(t("status.loaded_sessions", { count: list.length }));
      setError(null);
    } catch (e: unknown) {
      setError(String(e));
      setSessions([]);
      setStatus(t("status.scan_failed"));
    } finally {
      setBusy(false);
    }
  }, [backend.provider.id, backend.root, t]);

  useEffect(() => {
    setActivePath(null);
    setActiveSession(null);
    void refreshSessions();
  }, [refreshSessions]);

  const onSelectSession = useCallback(
    async (s: SessionSummary) => {
      setActivePath(s.source_path);
      setLoadingSession(true);
      setActiveSession(null);
      setError(null);
      try {
        const d = await api.loadSession(backend.provider.id, s.source_path);
        setActiveSession(d);
        setStatus(
          t("status.loaded_session", { title: d.summary.title || d.summary.session_id }),
        );
      } catch (e: unknown) {
        setError(String(e));
        setStatus(t("status.load_session_failed"));
      } finally {
        setLoadingSession(false);
      }
    },
    [backend.provider.id, t],
  );

  const handleExport = useCallback(async () => {
    if (!activeSession) return;
    const targetDir = await openDialog({ directory: true, multiple: false });
    if (typeof targetDir !== "string") {
      setStatus(t("status.export_cancelled"));
      return;
    }

    setExporting(true);
    setError(null);
    try {
      const bundleDir = await api.exportSessions(
        backend.provider.id,
        [activeSession.summary.source_path],
        backend.root,
        targetDir,
        "single",
      );
      setStatus(t("status.exported_to", { path: shortPath(bundleDir, 60) }));
    } catch (e: unknown) {
      setError(String(e));
      setStatus(t("status.export_failed"));
    } finally {
      setExporting(false);
    }
  }, [activeSession, backend.provider.id, backend.root, t]);

  // ---- Imperative handle for App-level keyboard shortcuts. Scoped to this
  //      panel's DOM so hidden panels never accidentally steal focus. ----
  useImperativeHandle(
    ref,
    (): SessionPanelHandle => ({
      refresh: () => void refreshSessions(),
      toggleExpandAll: () => setExpandAll((v) => !v),
      exportSession: () => void handleExport(),
      focusSessionSearch: () => {
        const el = rootRef.current?.querySelector<HTMLInputElement>("input.search");
        el?.focus();
        el?.select();
      },
      focusMessageSearch: () => {
        const el =
          rootRef.current?.querySelector<HTMLInputElement>("input.th-search-input");
        el?.focus();
        el?.select();
      },
    }),
    [refreshSessions, handleExport],
  );

  const canExport = !!activeSession && !exporting;

  // Push every meaningful state change up so the App can reflect this panel's
  // status in the (single) status bar and decide whether menu items / the AI
  // dialog should be enabled.
  const snapshot: SessionPanelSnapshot = useMemo(
    () => ({
      active: backend,
      sessionCount: sessions.length,
      counts,
      status,
      error,
      busy,
      loadingSession,
      activeSession,
      canExport,
      expandAll,
    }),
    [backend, sessions.length, counts, status, error, busy, loadingSession, activeSession, canExport, expandAll],
  );

  useEffect(() => {
    onMetaChange(snapshot);
  }, [snapshot, onMetaChange]);

  const rootLabel = shortPath(backend.root, 60);

  return (
    <div className="session-panel" style={{ display: visible ? "flex" : "none" }} ref={rootRef}>
      <Toolbar
        filter={filter}
        onFilterChange={setFilter}
        sessions={sessions}
        onRefresh={() => void refreshSessions()}
        onExpandAll={() => setExpandAll(true)}
        onCollapseAll={() => setExpandAll(false)}
        expandAll={expandAll}
        onOpenSource={onOpenSource}
        onSettings={onSettings}
        rootLabel={rootLabel}
        onExport={() => void handleExport()}
        canExport={canExport}
        onAiAnalysis={() => {
          if (aiNotReadyMsg) {
            window.alert(aiNotReadyMsg);
            return;
          }
          onAiAnalysis();
        }}
        canAiAnalysis={true}
        onFeedback={onFeedback}
        hubConnected={hubConnected}
      />
      <div className="app-body">
        <SessionList
          sessions={sessions}
          filter={filter}
          activeId={activePath}
          onPick={(s) => void onSelectSession(s)}
          busy={busy}
        />
        <SessionViewer
          session={activeSession}
          loading={loadingSession}
          error={error && !sessions.length ? null : error}
          expandAll={expandAll}
          previewChars={settings.ui.preview_chars}
          onCounts={setCounts}
        />
      </div>
    </div>
  );
});
