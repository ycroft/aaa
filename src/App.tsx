import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { exit as processExit } from "@tauri-apps/plugin-process";

import { api } from "./api";
import type {
  AppSettings,
  ProviderInfo,
  RemoteHostInfo,
  SessionRef,
  SessionSummary,
} from "./types";

import { Menubar, type MenuDef } from "./components/Menubar";
import { SettingsDialog } from "./components/SettingsDialog";
import { UpdateBanner } from "./components/UpdateBanner";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { AboutDialog } from "./components/AboutDialog";
import { ProviderSplash } from "./components/ProviderSplash";
import { RemoteProgressDialog } from "./components/RemoteProgressDialog";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { providerLabel } from "./format";
import {
  SessionPanel,
  type ActiveBackend,
  type SessionPanelHandle,
  type SessionPanelSnapshot,
} from "./components/SessionPanel";
import { EmptyWorkspace } from "./components/EmptyWorkspace";
import { JudgerPanel } from "./components/JudgerPanel";

import { useStatusHint } from "./hooks/useStatusHint";
import { I18nProvider, useI18n, useT, type LanguagePref } from "./i18n";
import {
  JUDGER_PANEL_IDENTITY,
  JUDGER_PANEL_TITLE_KEY,
  panelIdentity,
  type PanelDescriptor,
} from "./panels";

interface PendingRemoteOpen {
  taskId: string;
  remote: RemoteHostInfo;
  provider: ProviderInfo;
  startKey: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  provider_roots: {},
  remotes: [],
  judger: { last_cmd: null },
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
  const t = useT();
  const { setPref: setLangPref } = useI18n();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [remotes, setRemotes] = useState<RemoteHostInfo[]>([]);

  // ---- Multi-panel state. ----
  const [panels, setPanels] = useState<PanelDescriptor[]>([]);
  const [activePanelId, setActivePanelId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, SessionPanelSnapshot>>({});
  const panelHandles = useRef<Map<string, SessionPanelHandle>>(new Map());

  const [splashOpen, setSplashOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [hubConnected, setHubConnected] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [pendingRemote, setPendingRemote] = useState<PendingRemoteOpen | null>(null);
  const [judgerPreselected, setJudgerPreselected] = useState<SessionRef[] | null>(null);
  const [sessionCatalog, setSessionCatalog] = useState<
    Map<string, { providerId: string; root: string; sessions: SessionSummary[] }>
  >(new Map());
  // Stable handler — must NOT be re-created per render or it re-triggers
  // SessionPanel's `refreshSessions` (which depends on it), causing an
  // infinite list_sessions loop. `setSessionCatalog` is identity-stable,
  // and the functional update form means we never need to capture state.
  const handleSessionsLoaded = useCallback(
    (providerId: string, root: string, sessions: SessionSummary[]) => {
      const key = `${providerId}::${root}`;
      setSessionCatalog((m) => {
        const next = new Map(m);
        next.set(key, { providerId, root, sessions });
        return next;
      });
    },
    [],
  );
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
      } catch (e: unknown) {
        console.error(e);
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

  // ---- Panel lifecycle ----------------------------------------------------
  const activeSnapshot = activePanelId ? snapshots[activePanelId] : undefined;

  const addOrFocusPanel = useCallback(
    (descriptor: Omit<PanelDescriptor, "id">) => {
      setPanels((prev) => {
        const dup = prev.find((p) => p.identity === descriptor.identity);
        if (dup) {
          // Update title/subtitle/backend in case the user re-selected the
          // same source via a different path (e.g. fresh re-sync).
          const next = prev.map((p) =>
            p.id === dup.id
              ? { ...p, title: descriptor.title, subtitle: descriptor.subtitle, backend: descriptor.backend }
              : p,
          );
          setActivePanelId(dup.id);
          return next;
        }
        const id =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `panel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        setActivePanelId(id);
        return [...prev, { ...descriptor, id }];
      });
    },
    [],
  );

  const closePanel = useCallback((id: string) => {
    setPanels((prev) => {
      const next = prev.filter((p) => p.id !== id);
      setActivePanelId((cur) => {
        if (cur !== id) return cur;
        if (next.length === 0) return null;
        const closingIdx = prev.findIndex((p) => p.id === id);
        // Pick the neighbouring tab — prefer the one to the left so closing the
        // last tab focuses the previous, which is typically what the user wants.
        const fallback = next[Math.max(0, closingIdx - 1)] ?? next[0];
        return fallback.id;
      });
      return next;
    });
    setSnapshots((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    panelHandles.current.delete(id);
  }, []);

  const openSessionPanel = useCallback(
    (active: ActiveBackend) => {
      addOrFocusPanel({
        identity: panelIdentity(active),
        kind: "session",
        title: providerLabel(active.provider, t),
        subtitle: active.remote ? `↗ ${active.remote.label}` : null,
        icon: active.remote ? "↗" : "▣",
        backend: active,
      });
    },
    [addOrFocusPanel, t],
  );

  const openJudgerPanel = useCallback((preselected?: SessionRef[]) => {
    setPanels((prev) => {
      if (prev.some((p) => p.identity === JUDGER_PANEL_IDENTITY)) {
        // Already open — just focus it.
        return prev;
      }
      const desc: PanelDescriptor = {
        id: JUDGER_PANEL_IDENTITY,
        identity: JUDGER_PANEL_IDENTITY,
        kind: "judger",
        title: t(JUDGER_PANEL_TITLE_KEY),
        subtitle: null,
        icon: "✦",
        backend: null,
      };
      return [...prev, desc];
    });
    setActivePanelId(JUDGER_PANEL_IDENTITY);
    if (preselected && preselected.length > 0) {
      setJudgerPreselected(preselected);
    }
  }, [t]);

  // When settings change a local provider's root override, propagate it to
  // any open local panels bound to that provider so they re-scan.
  useEffect(() => {
    setPanels((prev) => {
      let mutated = false;
      const next = prev.map((p) => {
        if (!p.backend) return p;
        if (p.backend.remote) return p;
        const overridden =
          settings.provider_roots[p.backend.provider.id] ||
          p.backend.provider.default_root ||
          "";
        if (!overridden || overridden === p.backend.root) return p;
        mutated = true;
        return { ...p, backend: { ...p.backend, root: overridden } };
      });
      return mutated ? next : prev;
    });
  }, [settings.provider_roots]);

  // ---- Splash callbacks ---------------------------------------------------
  const pickBackend = useCallback(
    (p: ProviderInfo, customRoot?: string) => {
      const root = customRoot || settings.provider_roots[p.id] || p.default_root || "";
      if (!root) {
        window.alert(t("alert.no_directory_configured"));
        return;
      }
      openSessionPanel({ provider: p, root, remote: null });
      setSplashOpen(false);
    },
    [settings.provider_roots, openSessionPanel, t],
  );

  const pickBackendCustom = useCallback(
    async (p: ProviderInfo) => {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") pickBackend(p, picked);
    },
    [pickBackend],
  );

  const onPickRemote = useCallback(
    (remote: RemoteHostInfo, providerId: string) => {
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) return;
      // Hand off to the progress dialog. It owns the actual remote_open call
      // and reports progress via the `remote-progress` Tauri event.
      const taskId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
      openSessionPanel({ provider, root: localRoot, remote });
      setSplashOpen(false);
    },
    [providers, openSessionPanel],
  );

  const onRemoteOpenSuccess = useCallback(
    (result: {
      local_root: string;
      sync_stats: { files_pulled: number; files_skipped: number; files_deleted_locally: number };
    }) => {
      const pending = pendingRemote;
      if (!pending) return;
      openSessionPanel({
        provider: pending.provider,
        root: result.local_root,
        remote: pending.remote,
      });
      setSplashOpen(false);
      setPendingRemote(null);
      void refreshRemotes();
    },
    [pendingRemote, openSessionPanel, refreshRemotes],
  );

  const onRemoteOpenCancelled = useCallback(() => {
    setPendingRemote(null);
  }, []);

  const onRemoteOpenError = useCallback(
    (msg: string) => {
      if (msg.startsWith("HOST_KEY_MISMATCH:")) {
        window.alert(
          t("alert.host_key_changed", {
            label: pendingRemote?.remote.label ?? t("alert.this_host"),
          }),
        );
      } else {
        window.alert(msg);
      }
      setPendingRemote(null);
    },
    [pendingRemote, t],
  );

  const onAddRemote = useCallback(() => setSettingsOpen(true), []);

  // ---- Settings save + propagation ---------------------------------------
  const onSaveSettings = useCallback(
    async (next: AppSettings) => {
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
    },
    [refreshRemotes, setLangPref],
  );

  // ---- Per-panel snapshot bookkeeping ------------------------------------
  const onPanelSnapshot = useCallback((panelId: string, snap: SessionPanelSnapshot) => {
    setSnapshots((prev) => ({ ...prev, [panelId]: snap }));
  }, []);

  const setPanelHandle = useCallback(
    (panelId: string, handle: SessionPanelHandle | null) => {
      if (handle) panelHandles.current.set(panelId, handle);
      else panelHandles.current.delete(panelId);
    },
    [],
  );

  const callActiveHandle = useCallback(
    (action: keyof SessionPanelHandle) => {
      if (!activePanelId) return;
      const h = panelHandles.current.get(activePanelId);
      h?.[action]();
    },
    [activePanelId],
  );

  // ---- Keyboard shortcuts. ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While a remote-open is in flight, swallow shortcuts that could pull the
      // user out of the progress dialog and leave the app in a half-set state.
      if (pendingRemote) return;
      const target = e.target as HTMLElement | null;
      const inEditable = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (e.key === "Escape") {
        if (settingsOpen) { setSettingsOpen(false); e.preventDefault(); return; }
        if (splashOpen && panels.length > 0) { setSplashOpen(false); e.preventDefault(); return; }
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
        if (e.altKey) callActiveHandle("focusSessionSearch");
        else callActiveHandle("focusMessageSearch");
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
        if (!inEditable) callActiveHandle("exportSession");
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "e" || e.key === "E") && !inEditable) {
        callActiveHandle("toggleExpandAll");
        e.preventDefault();
        return;
      }
      if (e.key === "F5") {
        callActiveHandle("refresh");
        e.preventDefault();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    settingsOpen,
    splashOpen,
    panels.length,
    pendingRemote,
    callActiveHandle,
  ]);

  // ---- Menus. ----
  const hasActivePanel = activePanelId !== null;
  const hasLoadedSession = !!activeSnapshot?.activeSession;
  const exporting = activeSnapshot?.canExport === false && hasLoadedSession;

  const menus: MenuDef[] = useMemo(
    () => [
      {
        label: t("menu.file"),
        accelerator: "F",
        items: [
          {
            label: t("menu.open_source"),
            shortcut: "Ctrl+Shift+P",
            hint: t("menu.open_source_hint"),
            onClick: () => setSplashOpen(true),
          },
          {
            label: t("menu.refresh_sessions"),
            shortcut: "F5",
            hint: t("menu.refresh_sessions_hint"),
            onClick: () => callActiveHandle("refresh"),
            disabled: !hasActivePanel,
          },
          {
            label: t("menu.export_session"),
            shortcut: "Ctrl+Shift+E",
            hint: t("menu.export_session_hint"),
            onClick: () => callActiveHandle("exportSession"),
            disabled: !hasLoadedSession || exporting,
          },
          {
            label: t("menu.judger"),
            hint: t("menu.judger_hint"),
            onClick: () => openJudgerPanel(),
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
            // window.close() is silently ignored by the WebView for windows
            // that weren't opened by JS (the main Tauri window qualifies),
            // so we go through plugin-process to ask Rust to tear down the
            // app cleanly: close all windows, drop background tasks, exit 0.
            onClick: () => { void processExit(0); },
          },
        ],
      },
      {
        label: t("menu.view"),
        accelerator: "V",
        items: [
          {
            label: activeSnapshot?.expandAll ? t("menu.collapse_all") : t("menu.expand_all"),
            shortcut: "Ctrl+E",
            hint: t("menu.expand_all_hint"),
            onClick: () => callActiveHandle("toggleExpandAll"),
            disabled: !hasActivePanel,
          },
          {
            label: t("menu.filter_sessions"),
            shortcut: "Ctrl+Alt+F",
            hint: t("menu.filter_sessions_hint"),
            onClick: () => callActiveHandle("focusSessionSearch"),
            disabled: !hasActivePanel,
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
        accelerator: "H",
        items: [
          {
            label: t("menu.about"),
            hint: t("menu.about_hint"),
            onClick: () => setAboutOpen(true),
          },
        ],
      },
    ],
    [t, settings, hasActivePanel, hasLoadedSession, exporting, openJudgerPanel, callActiveHandle, activeSnapshot?.expandAll],
  );

  // ---- Status bar source ---------------------------------------------------
  const providerLabelText =
    activeSnapshot ? providerLabel(activeSnapshot.active.provider, t) : t("format.em_dash");
  const remoteLabel = activeSnapshot?.active.remote?.label ?? null;
  const status = activeSnapshot?.status ?? t("status.ready");
  const busy = activeSnapshot?.busy ?? false;
  const sessionCount = activeSnapshot?.sessionCount ?? 0;
  const counts = activeSnapshot?.counts ?? { totalNodes: 0, expandedNodes: 0, peakCtx: 0 };

  return (
    <div className="app">
      <Menubar menus={menus} />
      <UpdateBanner />
      <TabBar
        panels={panels}
        activeId={activePanelId}
        onPick={setActivePanelId}
        onClose={closePanel}
        onNew={() => setSplashOpen(true)}
      />
      <div className="app-panels">
        {panels.length === 0 && (
          <EmptyWorkspace
            onOpenSplash={() => setSplashOpen(true)}
            onOpenJudger={() => openJudgerPanel()}
          />
        )}
        {panels.map((p) => {
          const visible = p.id === activePanelId;
          if (p.kind === "judger") {
            return (
              <div
                key={p.id}
                className="panel-host judger-panel-host"
                style={{ display: visible ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}
              >
                <JudgerPanel
                  settings={settings}
                  onSaveSettings={(next) => { void onSaveSettings(next); }}
                  pickerSources={Array.from(sessionCatalog.values())}
                  preselected={judgerPreselected}
                  onConsumePreselected={() => setJudgerPreselected(null)}
                  onJumpToNode={(_sourcePath, _nodeId) => {
                    // V1: deep-linking back to a session node from a rubric
                    // chip is deferred. The intent is to find the matching
                    // SessionPanel by source_path, focus it, and dispatch a
                    // scroll-to-node event the SessionViewer hook listens
                    // for. For now this is a no-op so the chip click is
                    // visible-only; the run-id and node-id are still useful
                    // as a reference the user can copy.
                    // TODO: wire to SessionPanel scroll-to-node.
                  }}
                />
              </div>
            );
          }
          if (!p.backend) return null;
          return (
            <SessionPanel
              key={p.id}
              ref={(h) => setPanelHandle(p.id, h)}
              visible={visible}
              backend={p.backend}
              settings={settings}
              hubConnected={hubConnected}
              onMetaChange={(snap) => onPanelSnapshot(p.id, snap)}
              onOpenSource={() => setSplashOpen(true)}
              onSettings={() => setSettingsOpen(true)}
              onJudgeSession={() => {
                const summary = snapshots[p.id]?.activeSession?.summary;
                if (!summary) return;
                const ref: SessionRef = {
                  session_id: summary.session_id,
                  source_path: summary.source_path,
                  title: summary.title ?? null,
                  cwd: summary.cwd ?? null,
                };
                openJudgerPanel([ref]);
              }}
              onJudgeSessionFromList={(s) => {
                const ref: SessionRef = {
                  session_id: s.session_id,
                  source_path: s.source_path,
                  title: s.title ?? null,
                  cwd: s.cwd ?? null,
                };
                openJudgerPanel([ref]);
              }}
              onSessionsLoaded={handleSessionsLoaded}
              onFeedback={() => setFeedbackOpen(true)}
            />
          );
        })}
      </div>
      <StatusBar
        hint={hint}
        providerLabel={providerLabelText}
        remoteLabel={remoteLabel}
        sessionCount={sessionCount}
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
        closable={panels.length > 0}
      />
      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        providers={providers}
        onClose={() => setSettingsOpen(false)}
        onSave={onSaveSettings}
        onRemotesChanged={refreshRemotes}
      />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <FeedbackDialog
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        // The dialog closes itself after submit; the receipt id isn't routed
        // anywhere user-facing here because status is now per-panel and
        // feedback is a global concern.
        onSubmitted={() => undefined}
      />
      <RemoteProgressDialog
        open={pendingRemote !== null}
        taskId={pendingRemote?.taskId ?? null}
        startKey={pendingRemote?.startKey ?? null}
        remoteId={pendingRemote?.remote.id ?? ""}
        providerId={pendingRemote?.provider.id ?? ""}
        remoteLabel={pendingRemote?.remote.label ?? ""}
        providerLabel={pendingRemote ? providerLabel(pendingRemote.provider, t) : ""}
        onSuccess={onRemoteOpenSuccess}
        onCancelled={onRemoteOpenCancelled}
        onError={onRemoteOpenError}
      />
    </div>
  );
}
