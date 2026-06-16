import { useT } from "../i18n";

interface Props {
  onOpenSplash: () => void;
  onOpenJudger: () => void;
}

/** What the body shows when no panel is open. Keeps the user's hands on the
 *  same affordances they'll use to add the next tab so the UI never feels
 *  like a dead-end. */
export function EmptyWorkspace({ onOpenSplash, onOpenJudger }: Props) {
  const t = useT();
  return (
    <div className="empty-workspace">
      <div className="empty-workspace-card">
        <div className="empty-workspace-icon" aria-hidden="true">▣</div>
        <h2>{t("workspace.empty_title")}</h2>
        <p className="lead">{t("workspace.empty_lead")}</p>
        <div className="empty-workspace-actions">
          <button className="btn primary" onClick={onOpenSplash}>
            {t("workspace.empty_open_button")}
          </button>
          <button className="btn" onClick={onOpenJudger}>
            {t("workspace.empty_judger_button")}
          </button>
        </div>
      </div>
    </div>
  );
}
