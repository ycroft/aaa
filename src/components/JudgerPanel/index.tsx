import { useState } from "react";
import { useI18n } from "../../i18n";
import type { AppSettings, SessionRef } from "../../types";
import { JudgmentList } from "./JudgmentList";
import { JudgmentDetail } from "./JudgmentDetail";
import { StartEvaluationForm } from "./StartEvaluationForm";
import type { PickerSource } from "./SessionPicker";

interface Props {
  settings: AppSettings;
  onSaveSettings: (next: AppSettings) => void;
  /** Snapshot of all currently-open data-source panels — flattened sessions
   *  feed the picker. */
  pickerSources: PickerSource[];
  /** Set when the user reached the panel via session right-click / toolbar button. */
  preselected: SessionRef[] | null;
  /** Clears `preselected` after consumption so revisiting the tab doesn't refill. */
  onConsumePreselected: () => void;
  /** Used by RubricView "evidence node id" chips to deep-link back to a session. */
  onJumpToNode: (sourcePath: string, nodeId: string) => void;
}

type RightPane =
  | { kind: "empty" }
  | { kind: "form" }
  | { kind: "detail"; runId: string };

export function JudgerPanel({
  settings,
  onSaveSettings,
  pickerSources,
  preselected,
  onConsumePreselected,
  onJumpToNode,
}: Props) {
  const { t } = useI18n();
  const [pane, setPane] = useState<RightPane>(
    preselected && preselected.length > 0 ? { kind: "form" } : { kind: "empty" },
  );
  const [refreshKey, setRefreshKey] = useState(0);

  function startNew() {
    setPane({ kind: "form" });
  }

  function onFormCommitted(runIds: string[]) {
    onConsumePreselected();
    setRefreshKey((k) => k + 1);
    if (runIds.length > 0) {
      setPane({ kind: "detail", runId: runIds[0] });
    } else {
      setPane({ kind: "empty" });
    }
  }

  function onCancel() {
    onConsumePreselected();
    setPane({ kind: "empty" });
  }

  function onDeleted() {
    setRefreshKey((k) => k + 1);
    setPane({ kind: "empty" });
  }

  return (
    <div className="judger-panel">
      <JudgmentList
        selectedRunId={pane.kind === "detail" ? pane.runId : null}
        onSelect={(runId) => setPane({ kind: "detail", runId })}
        onStartNew={startNew}
        refreshKey={refreshKey}
      />
      <main className="judger-right">
        {pane.kind === "empty" && (
          <div className="judger-empty">
            <h2>{t("judger.empty.title")}</h2>
            <p>{t("judger.empty.body")}</p>
            <button className="primary" onClick={startNew}>
              {t("judger.empty.start_button")}
            </button>
          </div>
        )}
        {pane.kind === "form" && (
          <StartEvaluationForm
            sources={pickerSources}
            defaultAgentCmd={settings.judger.last_cmd ?? ""}
            preselected={preselected ?? undefined}
            onCommitted={(ids, agentCmd) => {
              // Persist last_cmd straight from the form's submission, no
              // module-level state needed — onCommitted now carries it.
              if (agentCmd.trim()) {
                onSaveSettings({
                  ...settings,
                  judger: { ...settings.judger, last_cmd: agentCmd },
                });
              }
              onFormCommitted(ids);
            }}
            onCancel={onCancel}
          />
        )}
        {pane.kind === "detail" && (
          <JudgmentDetail
            runId={pane.runId}
            onDeleted={onDeleted}
            onJumpToNode={onJumpToNode}
          />
        )}
      </main>
    </div>
  );
}
