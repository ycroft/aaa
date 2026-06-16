import { useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { api } from "../../api";
import type { Dimension, SessionRef, StartJudgmentArgs } from "../../types";
import { SessionPicker, type PickerSource } from "./SessionPicker";
import { ALL_DIMENSIONS } from "./dims";

const CMD_PRESETS = [
  "nga --prompt",
  "claude --dangerously-skip-permissions",
  "opencode --prompt",
] as const;
const CUSTOM_MODE = "__custom__";

interface Props {
  sources: PickerSource[];
  defaultAgentCmd: string;
  /** Shared "pending evaluation queue" lifted to JudgerPanel/App so that
   *  right-clicks on session rows can add to it whether the panel was
   *  already open or not. */
  selected: Map<string, SessionRef>;
  onSelectedChange: (next: Map<string, SessionRef>) => void;
  /** Receives the list of started run-ids AND the agent_cmd the user submitted,
   *  so the parent can persist `last_cmd` without a side-channel. */
  onCommitted: (runIds: string[], agentCmd: string) => void;
  /** Clear the form back to defaults. The parent typically force-remounts
   *  the form via key=, but exposing the action lets the user trigger it
   *  explicitly. */
  onReset: () => void;
}

export function StartEvaluationForm({
  sources,
  defaultAgentCmd,
  selected,
  onSelectedChange,
  onCommitted,
  onReset,
}: Props) {
  const { t } = useI18n();
  const initialMode = (CMD_PRESETS as readonly string[]).includes(defaultAgentCmd)
    ? defaultAgentCmd
    : CUSTOM_MODE;
  const initialCustom = initialMode === CUSTOM_MODE ? defaultAgentCmd : "";
  const [cmdMode, setCmdMode] = useState<string>(initialMode);
  const [customCmd, setCustomCmd] = useState(initialCustom);
  const agentCmd = cmdMode === CUSTOM_MODE ? customCmd : cmdMode;
  const [dims, setDims] = useState<Set<Dimension>>(new Set(ALL_DIMENSIONS));
  const [promptOverride, setPromptOverride] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionList = useMemo(() => Array.from(selected.values()), [selected]);

  // When the user provides a custom prompt, the backend uses it verbatim and
  // ignores the dimensions section template (see core/src/judger/runner.rs).
  // Reflect that in the UI by disabling the dimension toggles — they'd be
  // misleading as live controls, though we still keep the current selection
  // visible since it gets persisted to meta.json regardless.
  const promptOverridden = promptOverride.trim().length > 0;

  function toggleDim(d: Dimension) {
    if (promptOverridden) return;
    const next = new Set(dims);
    if (next.has(d)) next.delete(d);
    else next.add(d);
    setDims(next);
  }

  async function submit() {
    if (sessionList.length === 0) {
      setError(t("judger.start.error_no_sessions"));
      return;
    }
    if (!agentCmd.trim()) {
      setError(t("judger.start.error_no_cmd"));
      return;
    }
    setError(null);
    setSubmitting(true);
    const runIds: string[] = [];
    try {
      for (const s of sessionList) {
        const providerId = sources.find((src) =>
          src.sessions.some((sess) => sess.source_path === s.source_path),
        )?.providerId;
        if (!providerId) continue;
        const args: StartJudgmentArgs = {
          provider_id: providerId,
          session: s,
          agent_cmd: agentCmd,
          dimensions: Array.from(dims),
          prompt_override: promptOverride.trim() ? promptOverride : null,
        };
        const id = await api.judgerStart(args);
        runIds.push(id);
      }
      onCommitted(runIds, agentCmd);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="judger-start-form">
      <h2>{t("judger.start.title")}</h2>

      <section>
        <label>{t("judger.start.sessions_label")}</label>
        <SessionPicker
          sources={sources}
          selected={selected}
          onChange={onSelectedChange}
        />
      </section>

      <section>
        <label>{t("judger.start.agent_cmd_label")}</label>
        <select
          value={cmdMode}
          onChange={(e) => setCmdMode(e.target.value)}
        >
          {CMD_PRESETS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
          <option value={CUSTOM_MODE}>{t("judger.start.agent_cmd_custom")}</option>
        </select>
        {cmdMode === CUSTOM_MODE && (
          <input
            type="text"
            value={customCmd}
            onChange={(e) => setCustomCmd(e.target.value)}
            placeholder={t("judger.start.agent_cmd_custom_placeholder")}
          />
        )}
        <div className="hint">{t("judger.start.agent_cmd_hint")}</div>
      </section>

      <section>
        <label>{t("judger.start.dimensions_label")}</label>
        <div className="dim-grid">
          {ALL_DIMENSIONS.map((d) => (
            <label
              key={d}
              className={`dim-toggle ${promptOverridden ? "disabled" : ""}`}
            >
              <input
                type="checkbox"
                checked={dims.has(d)}
                onChange={() => toggleDim(d)}
                disabled={promptOverridden}
              />
              {t(`judger.dim.${d}` as const)}
            </label>
          ))}
        </div>
        {promptOverridden && (
          <div className="hint">{t("judger.start.dimensions_overridden_hint")}</div>
        )}
      </section>

      <section>
        <label>{t("judger.start.prompt_label")}</label>
        <textarea
          rows={8}
          value={promptOverride}
          onChange={(e) => setPromptOverride(e.target.value)}
          placeholder={t("judger.start.prompt_hint")}
        />
        <div className="hint">{t("judger.start.prompt_hint")}</div>
      </section>

      {error && <div className="error">{error}</div>}

      <div className="actions">
        <button onClick={onReset} disabled={submitting}>
          {t("judger.start.reset")}
        </button>
        <button onClick={submit} disabled={submitting} className="primary">
          {t("judger.start.submit")}
        </button>
      </div>
    </div>
  );
}
