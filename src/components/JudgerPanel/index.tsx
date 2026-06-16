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

export function JudgerPanel({
  settings,
  onSaveSettings,
  pickerSources,
  preselected,
  onConsumePreselected,
  onJumpToNode,
}: Props) {
  const { t } = useI18n();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // Bumped on submit / delete to force JudgmentList to refetch.
  const [refreshKey, setRefreshKey] = useState(0);
  // Bumped on submit to force StartEvaluationForm to remount with cleared
  // local state. The form is always visible on the left, so we can't rely
  // on unmount-on-pane-switch to clear it like the old design did.
  const [formKey, setFormKey] = useState(0);

  function handleCommitted(runIds: string[], agentCmd: string) {
    if (agentCmd.trim()) {
      onSaveSettings({
        ...settings,
        judger: { ...settings.judger, last_cmd: agentCmd },
      });
    }
    onConsumePreselected();
    setRefreshKey((k) => k + 1);
    setFormKey((k) => k + 1); // clear the form for the next run
    if (runIds.length > 0) {
      setSelectedRunId(runIds[0]);
    }
  }

  function handleReset() {
    onConsumePreselected();
    setFormKey((k) => k + 1);
  }

  function handleDeleted() {
    setRefreshKey((k) => k + 1);
    setSelectedRunId(null);
  }

  return (
    <div className="judger-panel">
      <aside className="judger-form-pane">
        <StartEvaluationForm
          key={formKey}
          sources={pickerSources}
          defaultAgentCmd={settings.judger.last_cmd ?? ""}
          preselected={preselected ?? undefined}
          onCommitted={handleCommitted}
          onReset={handleReset}
        />
      </aside>
      <main className="judger-right-pane">
        <JudgmentList
          selectedRunId={selectedRunId}
          onSelect={setSelectedRunId}
          refreshKey={refreshKey}
        />
        <section className="judger-detail-host">
          {selectedRunId ? (
            <JudgmentDetail
              runId={selectedRunId}
              onDeleted={handleDeleted}
              onJumpToNode={onJumpToNode}
            />
          ) : (
            <div className="judger-detail-empty muted">
              {t("judger.detail.select_hint")}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
