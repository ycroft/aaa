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

interface Props {
  open: boolean;
  settings: AppSettings;
  providers: ProviderInfo[];
  onClose: () => void;
  onSave: (s: AppSettings) => Promise<void>;
  onRemotesChanged?: () => void;
}

type Tab = "backends" | "remotes" | "ai" | "display" | "hub" | "feedback";

const TAB_LABELS: Record<Tab, string> = {
  backends: "后端",
  remotes: "远程主机",
  ai: "AI辅助分析",
  display: "显示",
  hub: "Hub",
  feedback: "我的反馈",
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
    if (!window.confirm("Delete this remote? Cached files will also be removed.")) return;
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
    setAi({ prompt_templates: draft.ai.prompt_templates.map((t) => (t.id === id ? { ...t, ...patch } : t)) });

  const removeTemplate = (id: string) =>
    setAi({ prompt_templates: draft.ai.prompt_templates.filter((t) => t.id !== id) });

  const addTemplate = () =>
    setAi({ prompt_templates: [...draft.ai.prompt_templates, { id: genId(), name: "", content: "", scope: "single" as TemplateScope }] });

  const inEditor = tab === "remotes" && editing !== null;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" data-hint="Settings" style={{ maxWidth: 620, width: "100%" }}>
        <div className="modal-head">
          <div className="title">设置</div>
          <button className="close" onClick={onClose} data-hint="Close (Esc)">×</button>
        </div>
        <div style={{ display: "flex", gap: 4, padding: "8px 16px 0", borderBottom: "1px solid var(--border)" }}>
          {(["backends", "remotes", "ai", "display", "hub", "feedback"] as Tab[]).map((t) => (
            <button
              key={t}
              className={"btn" + (tab === t ? " primary" : "")}
              onClick={() => { setTab(t); setEditing(null); }}
            >{TAB_LABELS[t]}</button>
          ))}
        </div>

        {tab === "backends" && (
          <div className="modal-body">
            <h3 style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-2)" }}>后端</h3>
            {providers.map((p) => (
              <div className="field" key={p.id}>
                <label>{p.display_name}</label>
                <div className="row">
                  <input
                    value={draft.provider_roots[p.id] ?? p.default_root ?? ""}
                    onChange={(e) => setRoot(p.id, e.target.value)}
                    placeholder={p.default_root ?? "(none)"}
                    spellCheck={false}
                  />
                  <button className="btn" onClick={() => pickRoot(p.id)} data-hint="Pick a directory">浏览…</button>
                </div>
                <div className="help">
                  {p.is_implemented
                    ? p.root_exists
                      ? "已找到默认目录。"
                      : "未找到默认目录 — 请设置自定义路径。"
                    : "此后端尚未实现。"}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "remotes" && editing === null && (
          <div className="modal-body">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 13, color: "var(--text-2)" }}>远程主机</h3>
              <button className="btn primary" onClick={() => setEditing("new")}>+ 添加</button>
            </div>
            {remotes.length === 0 && <div className="help">暂无远程主机。</div>}
            {remotes.map((r) => (
              <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-1)" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{r.label}</div>
                  <div className="help" style={{ gridColumn: "auto" }}>
                    {r.user}@{r.host}:{r.port} · {r.auth_kind}
                  </div>
                  {!r.host_key_known && (
                    <div className="help" style={{ gridColumn: "auto", color: "var(--warn)" }}>
                      ⚠ 主机密钥尚未信任 — 首次成功连接时将自动固定（TOFU）
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button className="btn" onClick={() => setEditing(r)}>编辑</button>
                  <button className="btn" onClick={() => deleteRemote(r.id)}>×</button>
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
            {/* Section A: AI辅助模式 */}
            <h3 style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-2)" }}>AI辅助模式</h3>
            <div className="field">
              <label>模式</label>
              <select value={draft.ai.mode} onChange={(e) => setAi({ mode: e.target.value as AppSettings["ai"]["mode"] })}>
                <option value="none">无（不启用AI辅助分析）</option>
                <option value="agent">Agent 模式</option>
                <option value="api" disabled>API 模式（待开放）</option>
              </select>
            </div>

            {draft.ai.mode === "agent" && (
              <>
                <div className="help" style={{ marginBottom: 8 }}>选择一个 Agent 工具（单选），配置其启动命令。{"{prompt_file}"} 为提示词文件占位符。</div>
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
                            {missing && <span className="help" style={{ marginLeft: 6, color: "var(--text-2)" }}>（未检测到命令）</span>}
                          </div>
                        ) : (
                          <input
                            value={agent.name}
                            onChange={(e) => updateAgent(agent.id, { name: e.target.value })}
                            placeholder="工具名称"
                            style={{ marginBottom: 4, width: "100%", padding: "4px 8px", background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: "var(--radius-sm)", color: "var(--text-1)", fontSize: 12, fontFamily: "inherit" }}
                            spellCheck={false}
                          />
                        )}
                        <input
                          value={agent.cmd_template}
                          onChange={(e) => updateAgent(agent.id, { cmd_template: e.target.value })}
                          placeholder="命令行模板，如: mytool {prompt_file}"
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
                <button className="btn" onClick={addAgent} style={{ marginTop: 8 }}>+ 添加自定义工具</button>
              </>
            )}

            {/* Section B: 提示词模板 */}
            <h3 style={{ margin: "16px 0 10px", fontSize: 13, color: "var(--text-2)" }}>提示词模板</h3>
            <div className="help" style={{ marginBottom: 8 }}>管理 AI 分析时使用的提示词模板。"单个会话"模板用于分析当前选中的会话，"所有会话"模板用于跨会话批量分析。</div>
            {draft.ai.prompt_templates.map((tpl) => (
              <div key={tpl.id} style={{ marginBottom: 10, padding: "8px 0", borderBottom: "1px solid var(--border-1)" }}>
                <div style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center" }}>
                  <input
                    value={tpl.name}
                    onChange={(e) => updateTemplate(tpl.id, { name: e.target.value })}
                    placeholder="模板名称"
                    style={{ flex: 1, padding: "4px 8px", background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: "var(--radius-sm)", color: "var(--text-1)", fontSize: 12, fontFamily: "inherit" }}
                    spellCheck={false}
                  />
                  <select
                    value={tpl.scope}
                    onChange={(e) => updateTemplate(tpl.id, { scope: e.target.value as TemplateScope })}
                    style={{ padding: "4px 8px", background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: "var(--radius-sm)", color: "var(--text-1)", fontSize: 12, fontFamily: "inherit", cursor: "pointer", flexShrink: 0 }}
                  >
                    <option value="single">单个会话</option>
                    <option value="all">所有会话</option>
                  </select>
                  <button className="btn" onClick={() => removeTemplate(tpl.id)} style={{ flexShrink: 0, padding: "4px 8px" }}>×</button>
                </div>
                <textarea
                  value={tpl.content}
                  onChange={(e) => updateTemplate(tpl.id, { content: e.target.value })}
                  placeholder="提示词内容…"
                  rows={3}
                  style={{ width: "100%", resize: "vertical", fontFamily: "monospace", fontSize: 12, padding: "6px 8px", background: "var(--bg-2)", border: "1px solid var(--border-2)", borderRadius: "var(--radius-sm)", color: "var(--text-1)", boxSizing: "border-box" }}
                  spellCheck={false}
                />
              </div>
            ))}
            <button className="btn" onClick={addTemplate}>+ 添加模板</button>
          </div>
        )}

        {tab === "display" && (
          <div className="modal-body">
            <h3 style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-2)" }}>显示</h3>
            <div className="field">
              <label>主题</label>
              <select value={draft.ui.theme} onChange={(e) => setUi({ theme: e.target.value })}>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
                <option value="win98">Windows 98（复古）</option>
              </select>
            </div>
            <div className="field">
              <label>预览字符数</label>
              <input
                type="number"
                min={60}
                max={1000}
                value={draft.ui.preview_chars}
                onChange={(e) => setUi({ preview_chars: Number(e.target.value) })}
              />
              <div className="help">折叠节点中显示的文本长度。</div>
            </div>
          </div>
        )}

        {tab === "hub" && (
          <div className="modal-body">
            <h3 style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-2)" }}>aaa-hub</h3>
            <div className="field">
              <label>Base URL</label>
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
                留空表示禁用 hub。配置后客户端会探测连通性，连不上时反馈按钮自动灰显。
              </div>
            </div>
            <div className="field">
              <label>设备 id（匿名 ULID）</label>
              <input
                type="text"
                value={draft.hub?.device_id ?? ""}
                readOnly
                style={{ opacity: 0.7 }}
              />
              <div className="help">首次启动时自动生成；服务端用它关联同一台机器的多次反馈。</div>
            </div>
          </div>
        )}

        {tab === "feedback" && (
          <div className="modal-body">
            <h3 style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-2)" }}>我的反馈</h3>
            <FeedbackList />
          </div>
        )}

        {!inEditor && (
          <div className="modal-foot">
            <button className="btn" onClick={onClose}>取消</button>
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
            >保存</button>
          </div>
        )}
      </div>
    </div>
  );
}
