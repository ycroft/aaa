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
import { listen } from "@tauri-apps/api/event";

import { api } from "../api";
import type {
  AppSettings,
  ProviderInfo,
  RemoteHostInfo,
  SessionDetail,
  SessionFilter,
  SessionSummary,
  SkillScanDonePayload,
  SkillScanProgressPayload,
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
  onFeedback: () => void;
  /** Toolbar judge button — V1 evaluates the active session. */
  onJudgeSession?: () => void;
  /** SessionList right-click — V1 evaluates the picked session. */
  onJudgeSessionFromList?: (s: SessionSummary) => void;
  /** Pushed up whenever a fresh session list lands so the JudgerPanel picker
   *  can build a flattened "all currently-open data sources" view. */
  onSessionsLoaded?: (
    providerId: string,
    root: string,
    sessions: SessionSummary[],
  ) => void;
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
    onFeedback,
    onJudgeSession,
    onJudgeSessionFromList,
    onSessionsLoaded,
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
  // Background skill-scan progress. `null` outside a scan; `{k, n}` while one
  // is in flight. Drives the status bar and resets on cancel/refresh.
  const [skillScanProgress, setSkillScanProgress] =
    useState<{ k: number; n: number } | null>(null);
  // The scan id the listeners should currently honour. Refs (not state) so
  // updating it doesn't restart the listen-effect on each refresh.
  const skillScanIdRef = useRef<string | null>(null);

  // ---- Refresh sessions whenever the bound root changes (provider override,
  //      remote re-sync, etc.). Clearing activePath/activeSession lets the
  //      viewer fall back to its empty state until the user picks one. ----
  const refreshSessions = useCallback(async () => {
    setBusy(true);
    setStatus(t("status.scanning", { root: backend.root }));
    // Cancel any in-flight skill scan from a previous root before kicking
    // off the new one — events for the old scan are filtered out by the
    // listener via the ref, but we still want the worker to stop early.
    const previousScanId = skillScanIdRef.current;
    skillScanIdRef.current = null;
    setSkillScanProgress(null);
    if (previousScanId) {
      void api.cancelSkillScan(previousScanId).catch(() => {});
    }
    try {
      const list = await api.listSessions(backend.provider.id, backend.root);
      setSessions(list);
      setStatus(t("status.loaded_sessions", { count: list.length }));
      setError(null);
      onSessionsLoaded?.(backend.provider.id, backend.root, list);

      // Kick off the async skill-scan pass once the list is in. Empty list
      // = nothing to scan; bail without spawning.
      if (list.length > 0) {
        const scanId = crypto.randomUUID();
        skillScanIdRef.current = scanId;
        setSkillScanProgress({ k: 0, n: list.length });
        void api
          .startSkillScan(
            backend.provider.id,
            scanId,
            list.map((s) => s.source_path),
          )
          .catch((e) => {
            // Worker spawn failed — clear progress so the status bar
            // doesn't get stuck on 0/N. The list itself is fine.
            if (skillScanIdRef.current === scanId) {
              skillScanIdRef.current = null;
              setSkillScanProgress(null);
            }
            console.warn("startSkillScan failed:", e);
          });
      }
    } catch (e: unknown) {
      setError(String(e));
      setSessions([]);
      setStatus(t("status.scan_failed"));
    } finally {
      setBusy(false);
    }
  }, [backend.provider.id, backend.root, t, onSessionsLoaded]);

  useEffect(() => {
    setActivePath(null);
    setActiveSession(null);
    void refreshSessions();
  }, [refreshSessions]);

  // ---- Skill-scan event subscription. Mounted once for the panel's lifetime;
  //      `skillScanIdRef.current` selects which scan's events get applied.
  //      Cleanup cancels any still-running scan when the panel unmounts. ----
  useEffect(() => {
    let unlistenProgress: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const p = await listen<SkillScanProgressPayload>(
        "skill-scan-progress",
        (evt) => {
          if (evt.payload.scan_id !== skillScanIdRef.current) return;
          const { source_path, used_skills, k, n } = evt.payload;
          setSessions((prev) =>
            prev.map((s) =>
              s.source_path === source_path ? { ...s, used_skills } : s,
            ),
          );
          setSkillScanProgress({ k, n });
        },
      );
      const d = await listen<SkillScanDonePayload>(
        "skill-scan-done",
        (evt) => {
          if (evt.payload.scan_id !== skillScanIdRef.current) return;
          skillScanIdRef.current = null;
          setSkillScanProgress(null);
        },
      );
      if (cancelled) {
        p();
        d();
      } else {
        unlistenProgress = p;
        unlistenDone = d;
      }
    })();
    return () => {
      cancelled = true;
      unlistenProgress?.();
      unlistenDone?.();
      const id = skillScanIdRef.current;
      if (id) {
        skillScanIdRef.current = null;
        void api.cancelSkillScan(id).catch(() => {});
      }
    };
  }, []);

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

  // While a background skill scan is in flight, override the status string
  // with the (k/n) counter so the user sees the panel is still working.
  const displayStatus = useMemo(() => {
    if (skillScanProgress && skillScanProgress.n > 0) {
      return t("status.scanning_skills", {
        k: skillScanProgress.k,
        n: skillScanProgress.n,
      });
    }
    return status;
  }, [skillScanProgress, status, t]);

  // Push every meaningful state change up so the App can reflect this panel's
  // status in the (single) status bar and decide whether menu items / the AI
  // dialog should be enabled.
  const snapshot: SessionPanelSnapshot = useMemo(
    () => ({
      active: backend,
      sessionCount: sessions.length,
      counts,
      status: displayStatus,
      error,
      busy,
      loadingSession,
      activeSession,
      canExport,
      expandAll,
    }),
    [backend, sessions.length, counts, displayStatus, error, busy, loadingSession, activeSession, canExport, expandAll],
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
        onJudgeSession={onJudgeSession}
        canJudgeSession={true}
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
          onJudgeSession={onJudgeSessionFromList}
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
