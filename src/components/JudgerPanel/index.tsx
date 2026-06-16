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
  /** Shared queue of sessions chosen for the next evaluation run. Lifted to
   *  App.tsx so right-click → "judge this session" works whether this panel
   *  is currently mounted or not, and so toolbar buttons can navigate here
   *  without auto-adding the active session. */
  queue: Map<string, SessionRef>;
  onQueueChange: (next: Map<string, SessionRef>) => void;
  /** Used by RubricView "evidence node id" chips to deep-link back to a session. */
  onJumpToNode: (sourcePath: string, nodeId: string) => void;
}

export function JudgerPanel({
  settings,
  onSaveSettings,
  pickerSources,
  queue,
  onQueueChange,
  onJumpToNode,
}: Props) {
  const { t } = useI18n();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // Bumped on submit / delete to force JudgmentList to refetch.
  const [refreshKey, setRefreshKey] = useState(0);
  // Bumped on submit / reset to force StartEvaluationForm to remount with
  // cleared internal cmd/dims/prompt state. The shared queue is cleared
  // separately via onQueueChange.
  const [formKey, setFormKey] = useState(0);

  function handleCommitted(runIds: string[], agentCmd: string) {
    if (agentCmd.trim()) {
      onSaveSettings({
        ...settings,
        judger: { ...settings.judger, last_cmd: agentCmd },
      });
    }
    onQueueChange(new Map());
    setRefreshKey((k) => k + 1);
    setFormKey((k) => k + 1); // clear the form for the next run
    if (runIds.length > 0) {
      setSelectedRunId(runIds[0]);
    }
  }

  function handleReset() {
    onQueueChange(new Map());
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
          selected={queue}
          onSelectedChange={onQueueChange}
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
