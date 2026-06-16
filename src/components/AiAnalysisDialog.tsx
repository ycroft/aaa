import { useEffect, useState } from "react";
import { tempDir } from "@tauri-apps/api/path";
import type { AppSettings, ProviderInfo, SessionDetail, TemplateScope } from "../types";
import { api } from "../api";
import { useT } from "../i18n";

interface Props {
  open: boolean;
  settings: AppSettings;
  activeSession: SessionDetail | null;
  active: { provider: ProviderInfo; root: string } | null;
  onClose: () => void;
}

export function AiAnalysisDialog({ open, settings, activeSession, active, onClose }: Props) {
  const t = useT();
  const [scope, setScope] = useState<TemplateScope>("single");
  const [templateId, setTemplateId] = useState<string>("blank");
  const [promptText, setPromptText] = useState("");
  const [appendText, setAppendText] = useState("");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when dialog opens.
  useEffect(() => {
    if (open) {
      setScope(activeSession ? "single" : "all");
      setTemplateId("blank");
      setPromptText("");
      setAppendText("");
      setError(null);
    }
  }, [open, activeSession]);

  // Populate prompt text when template changes.
  useEffect(() => {
    if (templateId === "blank") return;
    const tpl = settings.ai.prompt_templates.find((t) => t.id === templateId);
    if (tpl) setPromptText(tpl.content);
  }, [templateId, settings.ai.prompt_templates]);

  if (!open) return null;

  const filteredTemplates = settings.ai.prompt_templates.filter((t) => t.scope === scope);
  const selectedAgent = settings.ai.agents.find((a) => a.id === settings.ai.selected_agent);

  async function handleStart() {
    if (!selectedAgent || !active) return;
    setExporting(true);
    setError(null);
    try {
      const td = await tempDir();
      const workDir = `${td}aaa-analysis-${Date.now()}`;

      const sourcePaths =
        scope === "all"
          ? (await api.listSessions(active.provider.id, active.root)).map((s) => s.source_path)
          : activeSession ? [activeSession.summary.source_path] : [];
      if (sourcePaths.length === 0) return;

      const bundleDir = await api.exportSessions(
        active.provider.id,
        sourcePaths,
        active.root,
        workDir,
        scope,
      );

      const fullPrompt = [
        promptText,
        appendText,
        `\n${t("ai_dialog.exported_files_label")}\n- ${bundleDir}`,
      ]
        .filter(Boolean)
        .join("\n\n");

      await api.launchAgent(selectedAgent.cmd_template, workDir, fullPrompt);
      onClose();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" data-hint={t("ai_dialog.hint")} style={{ maxWidth: 520, width: "100%" }}>
        <div className="modal-head">
          <div className="title">{t("ai_dialog.title")}</div>
          <button className="close" onClick={onClose} data-hint={t("ai_dialog.close_hint")}>×</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>{t("ai_dialog.scope")}</label>
            <div style={{ display: "flex", gap: 16 }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: activeSession ? "pointer" : "not-allowed", opacity: activeSession ? 1 : 0.45 }}>
                <input
                  type="radio"
                  name="ai-scope"
                  value="single"
                  checked={scope === "single"}
                  disabled={!activeSession}
                  onChange={() => { setScope("single"); setTemplateId("blank"); setPromptText(""); }}
                />
                {t("ai_dialog.scope_single")}
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="ai-scope"
                  value="all"
                  checked={scope === "all"}
                  onChange={() => { setScope("all"); setTemplateId("blank"); setPromptText(""); }}
                />
                {t("ai_dialog.scope_all")}
              </label>
            </div>
            {!activeSession && scope === "single" && (
              <div className="help">{t("ai_dialog.pick_session_first")}</div>
            )}
          </div>

          <div className="field">
            <label>{t("ai_dialog.template")}</label>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="blank">{t("ai_dialog.template_blank")}</option>
              {filteredTemplates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>{t("ai_dialog.prompt")}</label>
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder={t("ai_dialog.prompt_placeholder")}
              rows={6}
              style={{ width: "100%", resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
              spellCheck={false}
            />
          </div>

          <div className="field">
            <label>{t("ai_dialog.append")}</label>
            <textarea
              value={appendText}
              onChange={(e) => setAppendText(e.target.value)}
              placeholder={t("ai_dialog.append_placeholder")}
              rows={2}
              style={{ width: "100%", resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
              spellCheck={false}
            />
          </div>

          {exporting && (
            <div style={{ height: 4, background: "var(--border)", borderRadius: 2, marginBottom: 8 }}>
              <div style={{ width: "60%", background: "var(--accent, #0078d4)", height: "100%", borderRadius: 2, transition: "width .3s" }} />
            </div>
          )}

          {error && <div className="help" style={{ color: "var(--error, #c00)" }}>{error}</div>}

          {!selectedAgent && (
            <div className="help" style={{ color: "var(--warn, #a60)" }}>
              {t("ai_dialog.pick_agent_first")}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={exporting}>{t("ai_dialog.cancel")}</button>
          <button
            className="btn primary"
            disabled={exporting || !selectedAgent || !active || (scope === "single" && !activeSession)}
            onClick={handleStart}
          >
            {exporting ? t("ai_dialog.exporting") : t("ai_dialog.start")}
          </button>
        </div>
      </div>
    </div>
  );
}
