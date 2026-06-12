import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { api } from "./api";
import type {
  AppSettings,
  ProviderInfo,
  RemoteHostInfo,
  SessionDetail,
  SessionFilter,
  SessionSummary,
} from "./types";
import { EMPTY_FILTER } from "./types";

import { Menubar, type MenuDef } from "./components/Menubar";
import { Toolbar } from "./components/Toolbar";
import { SessionList } from "./components/SessionList";
import { SessionViewer, type ViewerCounts } from "./components/SessionViewer";
import { SettingsDialog } from "./components/SettingsDialog";
import { UpdateBanner } from "./components/UpdateBanner";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { AiAnalysisDialog } from "./components/AiAnalysisDialog";
import { AboutDialog } from "./components/AboutDialog";
import { ProviderSplash } from "./components/ProviderSplash";
import { RemoteProgressDialog } from "./components/RemoteProgressDialog";
import { StatusBar } from "./components/StatusBar";

import { useStatusHint } from "./hooks/useStatusHint";
import { shortPath, sanitizeFileName, exportTimestamp } from "./format";

interface ActiveBackend {
  provider: ProviderInfo;
  root: string;
  remote: RemoteHostInfo | null;
}

interface PendingRemoteOpen {
  taskId: string;
  remote: RemoteHostInfo;
  provider: ProviderInfo;
  startKey: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  provider_roots: {},
  remotes: [],
  ai: { mode: "none", selected_agent: null, agents: [], prompt_templates: [] },
  ui: { theme: "light", preview_chars: 220, auto_expand_threshold_tokens: 0 },
  hub: { base_url: "", device_id: "" },
};

export function App() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [remotes, setRemotes] = useState<RemoteHostInfo[]>([]);
  const [active, setActive] = useState<ActiveBackend | null>(null);
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
  const [splashOpen, setSplashOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [hubConnected, setHubConnected] = useState(false);
  const [aiAnalysisOpen, setAiAnalysisOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [pendingRemote, setPendingRemote] = useState<PendingRemoteOpen | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready.");
  const [error, setError] = useState<string | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [exporting, setExporting] = useState(false);
  const hint = useStatusHint();

  // ---- Initial load: providers + settings + remotes, then show splash. ----
  useEffect(() => {
    void (async () => {
      try {
        const [ps, s, rs] = await Promise.all([
          api.listProviders(),
          api.getSettings(),
          api.listRemotes(),
        ]);
        setProviders(ps);
        setSettings(s);
        setRemotes(rs);
        setSplashOpen(true);
      } catch (e: any) {
        setError(String(e));
      }
    })();
  }, []);

  const refreshRemotes = useCallback(async () => {
    try {
      const rs = await api.listRemotes();
      setRemotes(rs);
    } catch {
      /* ignore */
    }
  }, []);

  // ---- Apply theme. ----
  useEffect(() => {
    document.documentElement.dataset.theme = settings.ui.theme || "light";
  }, [settings.ui.theme]);

  // ---- Session list refresh when active backend changes. ----
  const refreshSessions = useCallback(async () => {
    if (!active) return;
    setBusy(true);
    setStatus(`Scanning ${active.root}…`);
    try {
      const list = await api.listSessions(active.provider.id, active.root);
      setSessions(list);
      setStatus(`Loaded ${list.length} session(s).`);
      setError(null);
    } catch (e: any) {
      setError(String(e));
      setSessions([]);
      setStatus("Failed to scan directory.");
    } finally {
      setBusy(false);
    }
  }, [active]);

  useEffect(() => { void refreshSessions(); }, [refreshSessions]);

  // Probe the hub on startup, then every 30 minutes. All failures stay silent;
  // the only effect on the UI is the Toolbar's "Feedback" button enable state.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.hubStatus();
        if (alive) setHubConnected(s === "Connected");
      } catch {
        if (alive) setHubConnected(false);
      }
    };
    void tick();
    const t = setInterval(tick, 30 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const pickBackend = useCallback(
    async (p: ProviderInfo, customRoot?: string) => {
      const root = customRoot || settings.provider_roots[p.id] || p.default_root || "";
      if (!root) {
        setError("No directory configured for this backend.");
        return;
      }
      setActive({ provider: p, root, remote: null });
      setActiveSession(null);
      setActivePath(null);
      setSplashOpen(false);
    },
    [settings],
  );

  const pickBackendCustom = useCallback(async (p: ProviderInfo) => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") void pickBackend(p, picked);
  }, [pickBackend]);

  const onPickRemote = useCallback(
    (remote: RemoteHostInfo, providerId: string) => {
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) return;
      // Hand off to the progress dialog. It owns the actual remote_open call
      // and reports progress via the `remote-progress` Tauri event.
      const taskId =
        (typeof crypto !== "undefined" && "randomUUID" in crypto)
          ? crypto.randomUUID()
          : `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setError(null);
      setStatus(`Connecting to ${remote.label}…`);
      setPendingRemote({ taskId, remote, provider, startKey: taskId });
    },
    [providers],
  );

  // Open a previously-synced cache directly. Skips SSH so it works fully
  // offline — handy when the remote is unreachable or the user just wants
  // to revisit yesterday's snapshot without paying the sync cost.
  const onPickRemoteCache = useCallback(
    (remote: RemoteHostInfo, providerId: string, localRoot: string) => {
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) return;
      setActive({ provider, root: localRoot, remote });
      setActiveSession(null);
      setActivePath(null);
      setSplashOpen(false);
      setError(null);
      setStatus(`Opened cached ${provider.display_name} from ${remote.label} (offline).`);
    },
    [providers],
  );

  const onRemoteOpenSuccess = useCallback(
    (result: { local_root: string; sync_stats: { files_pulled: number; files_skipped: number; files_deleted_locally: number } }) => {
      const pending = pendingRemote;
      if (!pending) return;
      setActive({
        provider: pending.provider,
        root: result.local_root,
        remote: pending.remote,
      });
      setActiveSession(null);
      setActivePath(null);
      setSplashOpen(false);
      setStatus(
        `Synced from ${pending.remote.label}: ${result.sync_stats.files_pulled} pulled, ` +
        `${result.sync_stats.files_skipped} skipped, ` +
        `${result.sync_stats.files_deleted_locally} deleted`,
      );
      setPendingRemote(null);
      void refreshRemotes();
    },
    [pendingRemote, refreshRemotes],
  );

  const onRemoteOpenCancelled = useCallback(() => {
    setPendingRemote(null);
    setStatus("Connect cancelled.");
  }, []);

  const onRemoteOpenError = useCallback((msg: string) => {
    if (msg.startsWith("HOST_KEY_MISMATCH:")) {
      window.alert(
        `Host key for ${pendingRemote?.remote.label ?? "this host"} has changed.\n\n` +
        "If you're sure this is the same machine, delete this remote in Settings " +
        "and add it again to re-trust the new key.",
      );
    } else {
      setError(msg);
    }
    setStatus("Failed to connect.");
    setPendingRemote(null);
  }, [pendingRemote]);

  const onAddRemote = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const onSelectSession = useCallback(async (s: SessionSummary) => {
    if (!active) return;
    setActivePath(s.source_path);
    setLoadingSession(true);
    setActiveSession(null);
    setError(null);
    try {
      const d = await api.loadSession(active.provider.id, s.source_path);
      setActiveSession(d);
      setStatus(`Loaded: ${d.summary.title || d.summary.session_id}`);
    } catch (e: any) {
      setError(String(e));
      setStatus("Failed to load session.");
    } finally {
      setLoadingSession(false);
    }
  }, [active]);

  const handleExport = useCallback(async () => {
    if (!active || !activeSession) return;
    const summary = activeSession.summary;
    const titleSegment = sanitizeFileName(summary.title, summary.session_id);
    const fileName = `${titleSegment}__${exportTimestamp()}.json`;

    const targetDir = await openDialog({ directory: true, multiple: false });
    if (typeof targetDir !== "string") {
      setStatus("Export cancelled.");
      return;
    }

    setExporting(true);
    setError(null);
    try {
      const exportedPath = await api.exportSession(
        active.provider.id,
        summary.source_path,
        targetDir,
        fileName,
      );
      setStatus(`Exported to ${shortPath(exportedPath, 60)}`);
    } catch (e: any) {
      setError(String(e));
      setStatus("Export failed.");
    } finally {
      setExporting(false);
    }
  }, [active, activeSession]);

  const onSaveSettings = useCallback(async (next: AppSettings) => {
    await api.saveSettings(next);
    setSettings(next);
    // Re-fetch providers in case path overrides changed.
    const ps = await api.listProviders();
    setProviders(ps);
    // Re-fetch remotes too — settings may have edited them via Tab.
    await refreshRemotes();
    // Re-bind hub client to the (possibly new) base_url and re-probe status.
    try {
      await api.refreshHub();
      const s = await api.hubStatus();
      setHubConnected(s === "Connected");
    } catch {
      setHubConnected(false);
    }
    // If the active backend's override changed, re-scan.
    if (active && !active.remote) {
      const newRoot = next.provider_roots[active.provider.id] || active.provider.default_root || "";
      if (newRoot && newRoot !== active.root) {
        setActive({ ...active, root: newRoot });
      }
    }
    setStatus("Settings saved.");
  }, [active, refreshRemotes]);

  // ---- Keyboard shortcuts. ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While a remote-open is in flight, swallow shortcuts that could pull the
      // user out of the progress dialog and leave the app in a half-set state.
      if (pendingRemote) return;
      const target = e.target as HTMLElement | null;
      const inEditable = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (e.key === "Escape") {
        if (aiAnalysisOpen) { setAiAnalysisOpen(false); e.preventDefault(); return; }
        if (settingsOpen) { setSettingsOpen(false); e.preventDefault(); return; }
        if (splashOpen && active) { setSplashOpen(false); e.preventDefault(); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        setSettingsOpen(true);
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "P" || e.key === "p")) {
        setSplashOpen(true);
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F") && !inEditable) {
        // Ctrl+Alt+F → focus the session-list filter (the outer search box).
        // Ctrl+F (no Alt) → focus the in-session message search.
        const selector = e.altKey
          ? "input.search"
          : "input.th-search-input";
        const el = document.querySelector<HTMLInputElement>(selector);
        el?.focus();
        el?.select();
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "E" || e.key === "e")) {
        if (!inEditable) void handleExport();
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "e" || e.key === "E") && !inEditable) {
        setExpandAll((v) => !v);
        e.preventDefault();
        return;
      }
      if (e.key === "F5") {
        void refreshSessions();
        e.preventDefault();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, aiAnalysisOpen, splashOpen, active, refreshSessions, pendingRemote, handleExport]);

  // ---- Menus. ----
  const aiReady = settings.ai.mode === "agent" && !!settings.ai.selected_agent;
  const aiNotReadyMsg = !aiReady
    ? settings.ai.mode === "api" ? "api模式暂不支持，请切换为 Agent 模式。" : "请先在设置（AI辅助分析）中配置并选择一个 Agent 工具。"
    : null;

  const handleAiAnalysis = useCallback(() => {
    if (aiNotReadyMsg) { window.alert(aiNotReadyMsg); return; }
    setAiAnalysisOpen(true);
  }, [aiNotReadyMsg]);

  const menus: MenuDef[] = useMemo(
    () => [
      {
        label: "File",
        items: [
          {
            label: "Switch backend…",
            shortcut: "Ctrl+Shift+P",
            hint: "Pick a different agent backend",
            onClick: () => setSplashOpen(true),
          },
          {
            label: "Refresh sessions",
            shortcut: "F5",
            hint: "Re-scan the active directory",
            onClick: () => void refreshSessions(),
            disabled: !active,
          },
          {
            label: "Export current session…",
            shortcut: "Ctrl+Shift+E",
            hint: "Save the loaded session as JSON",
            onClick: () => void handleExport(),
            disabled: !activeSession || exporting,
          },
          {
            label: "AI分析…",
            hint: "启动AI辅助分析",
            onClick: handleAiAnalysis,
          },
          { separator: true, label: "" },
          {
            label: "Settings…",
            shortcut: "Ctrl+,",
            hint: "Open application settings",
            onClick: () => setSettingsOpen(true),
          },
          { separator: true, label: "" },
          {
            label: "Quit",
            hint: "Close AAA",
            onClick: () => window.close(),
          },
        ],
      },
      {
        label: "View",
        items: [
          {
            label: expandAll ? "Collapse all" : "Expand all",
            shortcut: "Ctrl+E",
            hint: "Toggle expand-all for the timeline",
            onClick: () => setExpandAll((v) => !v),
          },
          {
            label: "Filter sessions…",
            shortcut: "Ctrl+Alt+F",
            hint: "Focus the sessions filter box",
            onClick: () => {
              const el = document.querySelector<HTMLInputElement>("input.search");
              el?.focus(); el?.select();
            },
          },
          { separator: true, label: "" },
          ...(["light", "dark", "win98"] as const).map((t) => ({
            label:
              (settings.ui.theme === t ? "● " : "   ") +
              (t === "light" ? "Light theme" : t === "dark" ? "Dark theme" : "Windows 98 (retro)"),
            hint:
              t === "light"
                ? "Switch to light theme"
                : t === "dark"
                ? "Switch to dark theme"
                : "Switch to Windows 98 retro theme",
            onClick: () => {
              if (settings.ui.theme === t) return;
              const updated: AppSettings = { ...settings, ui: { ...settings.ui, theme: t } };
              setSettings(updated);
              void api.saveSettings(updated);
            },
          })),
        ],
      },
      {
        label: "Help",
        items: [
          {
            label: "About AAA",
            hint: "About this tool",
            onClick: () => setAboutOpen(true),
          },
        ],
      },
    ],
    [active, expandAll, refreshSessions, settings, activeSession, exporting, handleExport, handleAiAnalysis],
  );

  const providerLabel = active ? active.provider.display_name : "—";
  const rootLabel = active ? shortPath(active.root, 60) : "(no backend)";

  return (
    <div className="app">
      <Menubar menus={menus} />
      <UpdateBanner />
      <Toolbar
        filter={filter}
        onFilterChange={setFilter}
        sessions={sessions}
        onRefresh={refreshSessions}
        onExpandAll={() => setExpandAll(true)}
        onCollapseAll={() => setExpandAll(false)}
        expandAll={expandAll}
        onSwitchBackend={() => setSplashOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        providerLabel={providerLabel}
        rootLabel={rootLabel}
        onExport={handleExport}
        canExport={!!activeSession && !exporting}
        onAiAnalysis={handleAiAnalysis}
        canAiAnalysis={true}
        aiAnalysisHint="启动AI辅助分析"
        onFeedback={() => setFeedbackOpen(true)}
        hubConnected={hubConnected}
      />
      <div className="body">
        <SessionList
          sessions={sessions}
          filter={filter}
          activeId={activePath}
          onPick={onSelectSession}
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
      <StatusBar
        hint={hint}
        providerLabel={providerLabel}
        remoteLabel={active?.remote?.label ?? null}
        sessionCount={sessions.length}
        expandedNodes={counts.expandedNodes}
        totalNodes={counts.totalNodes}
        peakCtx={counts.peakCtx}
        status={status}
        busy={busy}
      />

      <ProviderSplash
        open={splashOpen}
        providers={providers}
        remotes={remotes}
        onPick={pickBackend}
        onCustom={pickBackendCustom}
        onPickRemote={onPickRemote}
        onPickRemoteCache={onPickRemoteCache}
        onAddRemote={onAddRemote}
        onClose={() => setSplashOpen(false)}
        closable={!!active}
      />
      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        providers={providers}
        onClose={() => setSettingsOpen(false)}
        onSave={onSaveSettings}
        onRemotesChanged={refreshRemotes}
      />
      <AiAnalysisDialog
        open={aiAnalysisOpen}
        settings={settings}
        activeSession={activeSession}
        active={active}
        onClose={() => setAiAnalysisOpen(false)}
      />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <FeedbackDialog
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        onSubmitted={(id) => setStatus(`反馈已提交：#${id.slice(0, 6)}`)}
      />
      <RemoteProgressDialog
        open={pendingRemote !== null}
        taskId={pendingRemote?.taskId ?? null}
        startKey={pendingRemote?.startKey ?? null}
        remoteId={pendingRemote?.remote.id ?? ""}
        providerId={pendingRemote?.provider.id ?? ""}
        remoteLabel={pendingRemote?.remote.label ?? ""}
        providerLabel={pendingRemote?.provider.display_name ?? ""}
        onSuccess={onRemoteOpenSuccess}
        onCancelled={onRemoteOpenCancelled}
        onError={onRemoteOpenError}
      />
    </div>
  );
}
