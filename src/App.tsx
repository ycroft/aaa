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
import { I18nProvider, useI18n, type LanguagePref } from "./i18n";

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
  ui: { theme: "light", preview_chars: 220, auto_expand_threshold_tokens: 0, language: "auto" },
  hub: { base_url: "", device_id: "" },
};

export function App() {
  const [bootstrapped, setBootstrapped] = useState(false);
  const [language, setLanguage] = useState<LanguagePref>("auto");

  // Read language preference once before mounting the i18n provider so the
  // first paint is in the correct language and we don't flash zh→en (or v.v).
  useEffect(() => {
    void (async () => {
      try {
        const s = await api.getSettings();
        const pref = s.ui.language;
        setLanguage(pref === "zh" || pref === "en" ? pref : "auto");
      } catch {
        /* fall back to auto */
      } finally {
        setBootstrapped(true);
      }
    })();
  }, []);

  if (!bootstrapped) return null;

  return (
    <I18nProvider pref={language} onPrefChange={setLanguage}>
      <AppInner />
    </I18nProvider>
  );
}

function AppInner() {
  const { t, setPref: setLangPref } = useI18n();
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
  const [status, setStatus] = useState(() => t("status.ready"));
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
    setStatus(t("status.scanning", { root: active.root }));
    try {
      const list = await api.listSessions(active.provider.id, active.root);
      setSessions(list);
      setStatus(t("status.loaded_sessions", { count: list.length }));
      setError(null);
    } catch (e: any) {
      setError(String(e));
      setSessions([]);
      setStatus(t("status.scan_failed"));
    } finally {
      setBusy(false);
    }
  }, [active, t]);

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
        setError(t("alert.no_directory_configured"));
        return;
      }
      setActive({ provider: p, root, remote: null });
      setActiveSession(null);
      setActivePath(null);
      setSplashOpen(false);
    },
    [settings, t],
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
      setStatus(t("status.connecting_to", { label: remote.label }));
      setPendingRemote({ taskId, remote, provider, startKey: taskId });
    },
    [providers, t],
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
      setStatus(t("status.opened_cache", { provider: provider.display_name, label: remote.label }));
    },
    [providers, t],
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
        t("status.synced_from", {
          label: pending.remote.label,
          pulled: result.sync_stats.files_pulled,
          skipped: result.sync_stats.files_skipped,
          deleted: result.sync_stats.files_deleted_locally,
        }),
      );
      setPendingRemote(null);
      void refreshRemotes();
    },
    [pendingRemote, refreshRemotes, t],
  );

  const onRemoteOpenCancelled = useCallback(() => {
    setPendingRemote(null);
    setStatus(t("status.connect_cancelled"));
  }, [t]);

  const onRemoteOpenError = useCallback((msg: string) => {
    if (msg.startsWith("HOST_KEY_MISMATCH:")) {
      window.alert(
        t("alert.host_key_changed", {
          label: pendingRemote?.remote.label ?? t("alert.this_host"),
        }),
      );
    } else {
      setError(msg);
    }
    setStatus(t("status.connect_failed"));
    setPendingRemote(null);
  }, [pendingRemote, t]);

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
      setStatus(t("status.loaded_session", { title: d.summary.title || d.summary.session_id }));
    } catch (e: any) {
      setError(String(e));
      setStatus(t("status.load_session_failed"));
    } finally {
      setLoadingSession(false);
    }
  }, [active, t]);

  const handleExport = useCallback(async () => {
    if (!active || !activeSession) return;
    const summary = activeSession.summary;
    const titleSegment = sanitizeFileName(summary.title, summary.session_id);
    const fileName = `${titleSegment}__${exportTimestamp()}.json`;

    const targetDir = await openDialog({ directory: true, multiple: false });
    if (typeof targetDir !== "string") {
      setStatus(t("status.export_cancelled"));
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
      setStatus(t("status.exported_to", { path: shortPath(exportedPath, 60) }));
    } catch (e: any) {
      setError(String(e));
      setStatus(t("status.export_failed"));
    } finally {
      setExporting(false);
    }
  }, [active, activeSession, t]);

  const onSaveSettings = useCallback(async (next: AppSettings) => {
    await api.saveSettings(next);
    setSettings(next);
    // Push the (possibly changed) language pref up to I18nProvider so the
    // catalog and document.lang switch over right away.
    const pref = next.ui.language;
    setLangPref(pref === "zh" || pref === "en" ? pref : "auto");
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
    setStatus(t("status.settings_saved"));
  }, [active, refreshRemotes, setLangPref, t]);

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
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        // Always preventDefault to suppress Edge WebView's native "find on page"
        // popup — that bar competes with our own search input and indexes the
        // raw rendered DOM (collapsed nodes, ARIA text…) which gives a different
        // result set than nodeHaystack(). When the user is already typing in an
        // input we leave focus alone; otherwise route to the right search box.
        e.preventDefault();
        if (inEditable) return;
        const selector = e.altKey
          ? "input.search"
          : "input.th-search-input";
        const el = document.querySelector<HTMLInputElement>(selector);
        el?.focus();
        el?.select();
        return;
      }
      // Ctrl+G is the WebView's "find next" companion — block it for the same
      // reason as Ctrl+F. Our cycle-to-next behaviour is on Enter inside the
      // session search input.
      if ((e.ctrlKey || e.metaKey) && (e.key === "g" || e.key === "G")) {
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
    ? settings.ai.mode === "api" ? t("ai_dialog.not_ready_api") : t("ai_dialog.not_ready_no_agent")
    : null;

  const handleAiAnalysis = useCallback(() => {
    if (aiNotReadyMsg) { window.alert(aiNotReadyMsg); return; }
    setAiAnalysisOpen(true);
  }, [aiNotReadyMsg]);

  const menus: MenuDef[] = useMemo(
    () => [
      {
        label: t("menu.file"),
        items: [
          {
            label: t("menu.switch_backend"),
            shortcut: "Ctrl+Shift+P",
            hint: t("menu.switch_backend_hint"),
            onClick: () => setSplashOpen(true),
          },
          {
            label: t("menu.refresh_sessions"),
            shortcut: "F5",
            hint: t("menu.refresh_sessions_hint"),
            onClick: () => void refreshSessions(),
            disabled: !active,
          },
          {
            label: t("menu.export_session"),
            shortcut: "Ctrl+Shift+E",
            hint: t("menu.export_session_hint"),
            onClick: () => void handleExport(),
            disabled: !activeSession || exporting,
          },
          {
            label: t("menu.ai_analysis"),
            hint: t("menu.ai_analysis_hint"),
            onClick: handleAiAnalysis,
          },
          { separator: true, label: "" },
          {
            label: t("menu.settings"),
            shortcut: "Ctrl+,",
            hint: t("menu.settings_hint"),
            onClick: () => setSettingsOpen(true),
          },
          { separator: true, label: "" },
          {
            label: t("menu.quit"),
            hint: t("menu.quit_hint"),
            onClick: () => window.close(),
          },
        ],
      },
      {
        label: t("menu.view"),
        items: [
          {
            label: expandAll ? t("menu.collapse_all") : t("menu.expand_all"),
            shortcut: "Ctrl+E",
            hint: t("menu.expand_all_hint"),
            onClick: () => setExpandAll((v) => !v),
          },
          {
            label: t("menu.filter_sessions"),
            shortcut: "Ctrl+Alt+F",
            hint: t("menu.filter_sessions_hint"),
            onClick: () => {
              const el = document.querySelector<HTMLInputElement>("input.search");
              el?.focus(); el?.select();
            },
          },
          { separator: true, label: "" },
          ...(["light", "dark", "win98"] as const).map((theme) => ({
            label:
              (settings.ui.theme === theme ? "● " : "   ") +
              (theme === "light"
                ? t("menu.light_theme")
                : theme === "dark"
                ? t("menu.dark_theme")
                : t("menu.win98_theme")),
            hint:
              theme === "light"
                ? t("menu.light_theme_hint")
                : theme === "dark"
                ? t("menu.dark_theme_hint")
                : t("menu.win98_theme_hint"),
            onClick: () => {
              if (settings.ui.theme === theme) return;
              const updated: AppSettings = { ...settings, ui: { ...settings.ui, theme } };
              setSettings(updated);
              void api.saveSettings(updated);
            },
          })),
        ],
      },
      {
        label: t("menu.help"),
        items: [
          {
            label: t("menu.about"),
            hint: t("menu.about_hint"),
            onClick: () => setAboutOpen(true),
          },
        ],
      },
    ],
    [active, expandAll, refreshSessions, settings, activeSession, exporting, handleExport, handleAiAnalysis, t],
  );

  const providerLabel = active ? active.provider.display_name : t("format.em_dash");
  const rootLabel = active ? shortPath(active.root, 60) : "—";

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
        onSubmitted={(id) => setStatus(t("status.feedback_submitted", { id: id.slice(0, 6) }))}
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
