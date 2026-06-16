import { useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { api } from "../../api";
import type { Dimension, SessionRef, StartJudgmentArgs } from "../../types";
import { SessionPicker, type PickerSource } from "./SessionPicker";
import { ALL_DIMENSIONS } from "./dims";

interface Props {
  sources: PickerSource[];
  defaultAgentCmd: string;
  preselected?: SessionRef[];
  /** Receives the list of started run-ids AND the agent_cmd the user submitted,
   *  so the parent can persist `last_cmd` without a side-channel. */
  onCommitted: (runIds: string[], agentCmd: string) => void;
  onCancel: () => void;
}

export function StartEvaluationForm({
  sources,
  defaultAgentCmd,
  preselected,
  onCommitted,
  onCancel,
}: Props) {
  const { t } = useI18n();
  const initialSelection = useMemo(() => {
    const m = new Map<string, SessionRef>();
    for (const s of preselected ?? []) m.set(s.source_path, s);
    return m;
  }, [preselected]);

  const [selected, setSelected] = useState<Map<string, SessionRef>>(initialSelection);
  const [agentCmd, setAgentCmd] = useState(defaultAgentCmd);
  const [dims, setDims] = useState<Set<Dimension>>(new Set(ALL_DIMENSIONS));
  const [promptOverride, setPromptOverride] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionList = useMemo(() => Array.from(selected.values()), [selected]);

  function toggleDim(d: Dimension) {
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
        <SessionPicker sources={sources} selected={selected} onChange={setSelected} />
      </section>

      <section>
        <label>{t("judger.start.agent_cmd_label")}</label>
        <input
          type="text"
          value={agentCmd}
          onChange={(e) => setAgentCmd(e.target.value)}
          placeholder="claude --dangerously-skip-permissions"
        />
        <div className="hint">{t("judger.start.agent_cmd_hint")}</div>
      </section>

      <section>
        <label>{t("judger.start.dimensions_label")}</label>
        <div className="dim-grid">
          {ALL_DIMENSIONS.map((d) => (
            <label key={d} className="dim-toggle">
              <input
                type="checkbox"
                checked={dims.has(d)}
                onChange={() => toggleDim(d)}
              />
              {t(`judger.dim.${d}` as const)}
            </label>
          ))}
        </div>
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
        <button onClick={onCancel} disabled={submitting}>
          {t("judger.start.cancel")}
        </button>
        <button onClick={submit} disabled={submitting} className="primary">
          {t("judger.start.submit")}
        </button>
      </div>
    </div>
  );
}
