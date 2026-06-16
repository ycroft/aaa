import { useEffect, useState } from "react";
import type {
  AppSettings,
  ProviderInfo,
  RemoteHostInfo,
  RemoteHostInput,
} from "../types";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { RemoteEditor } from "./RemoteEditor";
import { FeedbackList } from "./FeedbackList";
import { useT, type TKey } from "../i18n";
import { providerLabel } from "../format";

interface Props {
  open: boolean;
  settings: AppSettings;
  providers: ProviderInfo[];
  onClose: () => void;
  onSave: (s: AppSettings) => Promise<void>;
  onRemotesChanged?: () => void;
}

type Tab = "backends" | "remotes" | "display" | "hub" | "feedback";

const TAB_KEYS: Record<Tab, TKey> = {
  backends: "settings.tab.backends",
  remotes: "settings.tab.remotes",
  display: "settings.tab.display",
  hub: "settings.tab.hub",
  feedback: "settings.tab.feedback",
};

export function SettingsDialog({
  open,
  settings,
  providers,
  onClose,
  onSave,
  onRemotesChanged,
}: Props) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("backends");
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [remotes, setRemotes] = useState<RemoteHostInfo[]>([]);
  const [editing, setEditing] = useState<RemoteHostInfo | "new" | null>(null);

  useEffect(() => { if (open) setDraft(settings); }, [open, settings]);
  useEffect(() => {
    if (open && tab === "remotes" && editing === null) {
      void api.listRemotes().then(setRemotes).catch(() => setRemotes([]));
    }
  }, [open, tab, editing]);

  if (!open) return null;

  const setRoot = (id: string, path: string) =>
    setDraft((d) => ({ ...d, provider_roots: { ...d.provider_roots, [id]: path } }));

  const pickRoot = async (id: string) => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setRoot(id, picked);
  };

  const setUi = (patch: Partial<AppSettings["ui"]>) =>
    setDraft((d) => ({ ...d, ui: { ...d.ui, ...patch } }));

  async function refreshRemotes() {
    const r = await api.listRemotes();
    setRemotes(r);
    onRemotesChanged?.();
  }

  async function deleteRemote(id: string) {
    if (!window.confirm(t("settings.delete_remote_confirm"))) return;
    await api.deleteRemote(id);
    await refreshRemotes();
  }

  async function saveRemote(input: RemoteHostInput) {
    await api.saveRemote(input);
    setEditing(null);
    await refreshRemotes();
  }

  const inEditor = tab === "remotes" && editing !== null;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" data-hint={t("settings.title")} style={{ maxWidth: 620, width: "100%" }}>
        <div className="modal-head">
          <div className="title">{t("settings.title")}</div>
          <button className="close" onClick={onClose} data-hint={t("settings.close_hint")}>×</button>
        </div>
        <div style={{ display: "flex", gap: 4, padding: "8px 16px 0", borderBottom: "1px solid var(--border)" }}>
          {(["backends", "remotes", "display", "hub", "feedback"] as Tab[]).map((tk) => (
            <button
              key={tk}
              className={"btn" + (tab === tk ? " primary" : "")}
              onClick={() => { setTab(tk); setEditing(null); }}
            >{t(TAB_KEYS[tk])}</button>
          ))}
        </div>

        {tab === "backends" && (
          <div className="modal-body">
            <h3 style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-2)" }}>{t("settings.backends.heading")}</h3>
            {providers.map((p) => (
              <div className="field" key={p.id}>
                <label>{providerLabel(p, t)}</label>
                <div className="row">
                  <input
                    value={draft.provider_roots[p.id] ?? p.default_root ?? ""}
                    onChange={(e) => setRoot(p.id, e.target.value)}
                    placeholder={p.default_root ?? t("splash.no_path")}
                    spellCheck={false}
                  />
                  <button className="btn" onClick={() => pickRoot(p.id)} data-hint={t("settings.backends.browse_hint")}>{t("settings.backends.browse")}</button>
                </div>
                <div className="help">
                  {p.is_implemented
                    ? p.root_exists
                      ? t("settings.backends.default_found")
                      : t("settings.backends.default_not_found")
                    : t("settings.backends.not_implemented")}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "remotes" && editing === null && (
          <div className="modal-body">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 13, color: "var(--text-2)" }}>{t("settings.remotes.heading")}</h3>
              <button className="btn primary" onClick={() => setEditing("new")}>{t("settings.remotes.add")}</button>
            </div>
            {remotes.length === 0 && <div className="help">{t("settings.remotes.empty")}</div>}
            {remotes.map((r) => (
              <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-1)" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{r.label}</div>
                  <div className="help" style={{ gridColumn: "auto" }}>
                    {r.user}@{r.host}:{r.port} · {r.auth_kind}
                  </div>
                  {!r.host_key_known && (
                    <div className="help" style={{ gridColumn: "auto", color: "var(--warn)" }}>
                      {t("settings.remotes.tofu_warning")}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button className="btn" onClick={() => setEditing(r)}>{t("settings.remotes.edit")}</button>
                  <button className="btn" onClick={() => deleteRemote(r.id)}>{t("settings.remotes.delete")}</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "remotes" && editing !== null && (
          <RemoteEditor
            initial={editing === "new" ? null : editing}
            providers={providers}
            onCancel={() => setEditing(null)}
            onSave={saveRemote}
          />
        )}

        {tab === "display" && (
          <div className="modal-body">
            <h3 style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-2)" }}>{t("settings.display.heading")}</h3>
            <div className="field">
              <label>{t("settings.display.theme")}</label>
              <select value={draft.ui.theme} onChange={(e) => setUi({ theme: e.target.value })}>
                <option value="light">{t("settings.display.theme_light")}</option>
                <option value="dark">{t("settings.display.theme_dark")}</option>
                <option value="win98">{t("settings.display.theme_win98")}</option>
              </select>
            </div>
            <div className="field">
              <label>{t("settings.display.preview_chars")}</label>
              <input
                type="number"
                min={60}
                max={1000}
                value={draft.ui.preview_chars}
                onChange={(e) => setUi({ preview_chars: Number(e.target.value) })}
              />
              <div className="help">{t("settings.display.preview_chars_help")}</div>
            </div>
            <div className="field">
              <label>{t("settings.display.language")}</label>
              <select
                value={draft.ui.language || "auto"}
                onChange={(e) => setUi({ language: e.target.value })}
              >
                <option value="auto">{t("settings.display.language_auto")}</option>
                <option value="zh">{t("settings.display.language_zh")}</option>
                <option value="en">{t("settings.display.language_en")}</option>
              </select>
              <div className="help">{t("settings.display.language_help")}</div>
            </div>
          </div>
        )}

        {tab === "hub" && (
          <div className="modal-body">
            <h3 style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-2)" }}>{t("settings.hub.heading")}</h3>
            <div className="field">
              <label>{t("settings.hub.base_url")}</label>
              <input
                type="url"
                placeholder="https://aaa.example.intranet"
                value={draft.hub?.base_url ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    hub: { ...d.hub, base_url: e.target.value },
                  }))
                }
              />
              <div className="help">
                {t("settings.hub.base_url_help")}
              </div>
            </div>
            <div className="field">
              <label>{t("settings.hub.device_id")}</label>
              <input
                type="text"
                value={draft.hub?.device_id ?? ""}
                readOnly
                style={{ opacity: 0.7 }}
              />
              <div className="help">{t("settings.hub.device_id_help")}</div>
            </div>
          </div>
        )}

        {tab === "feedback" && (
          <div className="modal-body">
            <h3 style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-2)" }}>{t("settings.feedback_tab.heading")}</h3>
            <FeedbackList />
          </div>
        )}

        {!inEditor && (
          <div className="modal-foot">
            <button className="btn" onClick={onClose}>{t("settings.cancel")}</button>
            <button
              className="btn primary"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                try {
                  await onSave(draft);
                  onClose();
                } finally {
                  setSaving(false);
                }
              }}
            >{t("settings.save")}</button>
          </div>
        )}
      </div>
    </div>
  );
}
