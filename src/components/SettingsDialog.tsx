import { useEffect, useState } from "react";
import type {
  AgentConfig,
  AppSettings,
  PromptTemplate,
  ProviderInfo,
  RemoteHostInfo,
  RemoteHostInput,
  TemplateScope,
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

type Tab = "backends" | "remotes" | "ai" | "display" | "hub" | "feedback";

const TAB_KEYS: Record<Tab, TKey> = {
  backends: "settings.tab.backends",
  remotes: "settings.tab.remotes",
  ai: "settings.tab.ai",
  display: "settings.tab.display",
  hub: "settings.tab.hub",
  feedback: "settings.tab.feedback",
};

function genId() {
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

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
  const [detected, setDetected] = useState<Record<string, boolean>>({});

  useEffect(() => { if (open) setDraft(settings); }, [open, settings]);
  useEffect(() => {
    if (open && tab === "remotes" && editing === null) {
      void api.listRemotes().then(setRemotes).catch(() => setRemotes([]));
    }
  }, [open, tab, editing]);

  // Auto-detect preset agent commands when AI tab is open in agent mode.
  useEffect(() => {
    if (!open || tab !== "ai" || draft.ai.mode !== "agent") return;
    const presets = draft.ai.agents.filter((a) => a.is_preset);
    // Extract first word (the actual command name) from cmd_template.
    void Promise.all(
      presets.map(async (a) => {
        const cmd = a.cmd_template.split(/\s/)[0];
        const exists = await api.checkCommandExists(cmd).catch(() => false);
        return [a.id, exists] as const;
      }),
    ).then((results) => {
      const map: Record<string, boolean> = {};
      for (const [id, exists] of results) map[id] = exists;
      setDetected(map);
    });
  }, [open, tab, draft.ai.mode, draft.ai.agents]);

  if (!open) return null;

  const setRoot = (id: string, path: string) =>
    setDraft((d) => ({ ...d, provider_roots: { ...d.provider_roots, [id]: path } }));

  const pickRoot = async (id: string) => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setRoot(id, picked);
  };

  const setAi = (patch: Partial<AppSettings["ai"]>) =>
    setDraft((d) => ({ ...d, ai: { ...d.ai, ...patch } }));

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

  const updateAgent = (id: string, patch: Partial<AgentConfig>) =>
    setAi({ agents: draft.ai.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) });

  const removeAgent = (id: string) =>
    setAi({ agents: draft.ai.agents.filter((a) => a.id !== id) });

  const addAgent = () =>
    setAi({ agents: [...draft.ai.agents, { id: genId(), name: "", cmd_template: "", is_preset: false }] });

  const updateTemplate = (id: string, patch: Partial<PromptTemplate>) =>
    setAi({ prompt_templates: draft.ai.prompt_templates.map((tpl) => (tpl.id === id ? { ...tpl, ...patch } : tpl)) });

  const removeTemplate = (id: string) =>
    setAi({ prompt_templates: draft.ai.prompt_templates.filter((tpl) => tpl.id !== id) });

  const addTemplate = () =>
    setAi({ prompt_templates: [...draft.ai.prompt_templates, { id: genId(), name: "", content: "", scope: "single" as TemplateScope }] });

  const inEditor = tab === "remotes" && editing !== null;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" data-hint={t("settings.title")} style={{ maxWidth: 620, width: "100%" }}>
        <div className="modal-head">
          <div className="title">{t("settings.title")}</div>
          <button className="close" onClick={onClose} data-hint={t("settings.close_hint")}>×</button>
        </div>
        <div style={{ display: "flex", gap: 4, padding: "8px 16px 0", borderBottom: "1px solid var(--border)" }}>
          {(["backends", "remotes", "ai", "display", "hub", "feedback"] as Tab[]).map((tk) => (
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

        {tab === "ai" && (
          <div className="modal-body">
            <h3 style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-2)" }}>{t("settings.ai.mode_heading")}</h3>
            <div className="field">
              <label>{t("settings.ai.mode")}</label>
              <select value={draft.ai.mode} onChange={(e) => setAi({ mode: e.target.value as AppSettings["ai"]["mode"] })}>
                <option value="none">{t("settings.ai.mode_none")}</option>
                <option value="agent">{t("settings.ai.mode_agent")}</option>
                <option value="api" disabled>{t("settings.ai.mode_api")}</option>
              </select>
            </div>

            {draft.ai.mode === "agent" && (
              <>
                <div className="help" style={{ marginBottom: 8 }}>{t("settings.ai.agent_help")}</div>
                {draft.ai.agents.map((agent) => {
                  const isSelected = draft.ai.selected_agent === agent.id;
                  const missing = agent.is_preset && detected[agent.id] === false;
                  return (
                    <div key={agent.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid var(--border-1)", opacity: missing ? 0.45 : 1 }}>
                      <input
                        type="radio"
                        name="sel-agent"
                        checked={isSelected}
                        disabled={missing}
                        onChange={() => setAi({ selected_agent: agent.id })}
                        style={{ marginTop: 4, flexShrink: 0 }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {agent.is_preset ? (
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>
                            {agent.name}
                            {missing && <span className="help" style={{ marginLeft: 6, color: "var(--text-2)" }}>{t("settings.ai.agent_missing")}</span>}
                          </div>
                        ) : (
                          <input
                            value={agent.name}
                            onChange={(e) => updateAgent(agent.id, { name: e.target.value })}
                            placeholder={t("settings.ai.agent_name_placeholder")}
                            style={{ marginBottom: 4, width: "100%", padding: "4px 8px", background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: "var(--radius-sm)", color: "var(--text-1)", fontSize: 12, fontFamily: "inherit" }}
                            spellCheck={false}
                          />
                        )}
                        <input
                          value={agent.cmd_template}
                          onChange={(e) => updateAgent(agent.id, { cmd_template: e.target.value })}
                          placeholder={t("settings.ai.agent_cmd_placeholder")}
                          style={{ width: "100%", padding: "4px 8px", background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: "var(--radius-sm)", color: "var(--text-1)", fontFamily: "monospace", fontSize: 12 }}
                          spellCheck={false}
                        />
                      </div>
                      {!agent.is_preset && (
                        <button className="btn" onClick={() => removeAgent(agent.id)} style={{ flexShrink: 0 }}>×</button>
                      )}
                    </div>
                  );
                })}
                <button className="btn" onClick={addAgent} style={{ marginTop: 8 }}>{t("settings.ai.add_custom_agent")}</button>
              </>
            )}

            <h3 style={{ margin: "16px 0 10px", fontSize: 13, color: "var(--text-2)" }}>{t("settings.ai.template_heading")}</h3>
            <div className="help" style={{ marginBottom: 8 }}>{t("settings.ai.template_help")}</div>
            {draft.ai.prompt_templates.map((tpl) => (
              <div key={tpl.id} style={{ marginBottom: 10, padding: "8px 0", borderBottom: "1px solid var(--border-1)" }}>
                <div style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center" }}>
                  <input
                    value={tpl.name}
                    onChange={(e) => updateTemplate(tpl.id, { name: e.target.value })}
                    placeholder={t("settings.ai.template_name_placeholder")}
                    style={{ flex: 1, padding: "4px 8px", background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: "var(--radius-sm)", color: "var(--text-1)", fontSize: 12, fontFamily: "inherit" }}
                    spellCheck={false}
                  />
                  <select
                    value={tpl.scope}
                    onChange={(e) => updateTemplate(tpl.id, { scope: e.target.value as TemplateScope })}
                    style={{ padding: "4px 8px", background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: "var(--radius-sm)", color: "var(--text-1)", fontSize: 12, fontFamily: "inherit", cursor: "pointer", flexShrink: 0 }}
                  >
                    <option value="single">{t("settings.ai.template_scope_single")}</option>
                    <option value="all">{t("settings.ai.template_scope_all")}</option>
                  </select>
                  <button className="btn" onClick={() => removeTemplate(tpl.id)} style={{ flexShrink: 0, padding: "4px 8px" }}>×</button>
                </div>
                <textarea
                  value={tpl.content}
                  onChange={(e) => updateTemplate(tpl.id, { content: e.target.value })}
                  placeholder={t("settings.ai.template_content_placeholder")}
                  rows={3}
                  style={{ width: "100%", resize: "vertical", fontFamily: "monospace", fontSize: 12, padding: "6px 8px", background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: "var(--radius-sm)", color: "var(--text-1)", boxSizing: "border-box" }}
                  spellCheck={false}
                />
              </div>
            ))}
            <button className="btn" onClick={addTemplate}>{t("settings.ai.add_template")}</button>
          </div>
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
