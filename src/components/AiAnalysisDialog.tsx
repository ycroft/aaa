import { useEffect, useState } from "react";
import { tempDir } from "@tauri-apps/api/path";
import type { AppSettings, ProviderInfo, SessionDetail, TemplateScope } from "../types";
import { api } from "../api";
import { sanitizeFileName } from "../format";

interface Props {
  open: boolean;
  settings: AppSettings;
  activeSession: SessionDetail | null;
  active: { provider: ProviderInfo; root: string } | null;
  onClose: () => void;
}

export function AiAnalysisDialog({ open, settings, activeSession, active, onClose }: Props) {
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

      let exportedPaths: string[];
      if (scope === "all") {
        exportedPaths = await api.exportAllSessions(active.provider.id, active.root, workDir);
      } else {
        if (!activeSession) return;
        const fileName = `${sanitizeFileName(activeSession.summary.title, activeSession.summary.session_id)}.json`;
        const path = await api.exportSession(active.provider.id, activeSession.summary.source_path, workDir, fileName);
        exportedPaths = [path];
      }

      const fileList = exportedPaths.map((p) => `- ${p}`).join("\n");
      const fullPrompt = [promptText, appendText, `\n导出的会话文件：\n${fileList}`]
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
      <div className="modal" data-hint="AI分析" style={{ maxWidth: 520, width: "100%" }}>
        <div className="modal-head">
          <div className="title">AI 辅助分析</div>
          <button className="close" onClick={onClose} data-hint="Close (Esc)">×</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>分析范围</label>
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
                当前会话
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="ai-scope"
                  value="all"
                  checked={scope === "all"}
                  onChange={() => { setScope("all"); setTemplateId("blank"); setPromptText(""); }}
                />
                所有会话
              </label>
            </div>
            {!activeSession && scope === "single" && (
              <div className="help">请先在左侧选择一个会话。</div>
            )}
          </div>

          <div className="field">
            <label>提示词模板</label>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              <option value="blank">空白模板（完全自定义）</option>
              {filteredTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>提示词</label>
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder="输入提示词，或从上方选择模板…"
              rows={6}
              style={{ width: "100%", resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
              spellCheck={false}
            />
          </div>

          <div className="field">
            <label>附加说明（追加在提示词后）</label>
            <textarea
              value={appendText}
              onChange={(e) => setAppendText(e.target.value)}
              placeholder="可选，追加在提示词末尾的补充说明…"
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
              请先在设置中选择一个 Agent 工具。
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose} disabled={exporting}>取消</button>
          <button
            className="btn primary"
            disabled={exporting || !selectedAgent || !active || (scope === "single" && !activeSession)}
            onClick={handleStart}
          >
            {exporting ? "导出中…" : "开始分析"}
          </button>
        </div>
      </div>
    </div>
  );
}
