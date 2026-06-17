import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type {
  FeedbackAttachmentInput,
  FeedbackCategory,
  FeedbackSeverity,
  LocalTicket,
  RemoteTicketView,
} from "../types";
import { useT } from "../i18n";

interface Props {
  /** Whether the panel is currently the active tab — used to trigger an
   *  on-show refresh of remote ticket statuses (no polling). */
  visible: boolean;
  /** Reflects the App-level hub probe; when false, submission is blocked
   *  and the form/list show offline hints. The list still renders local
   *  records, just with empty remote columns. */
  hubConnected: boolean;
}

interface Row {
  local: LocalTicket;
  remote: RemoteTicketView | null;
  fetched: boolean;
}

const TITLE_MAX = 80;
const FILE_BYTE_LIMIT = 10 * 1024 * 1024;

export function FeedbackPanel({ visible, hubConnected }: Props) {
  const t = useT();

  // ---- Form state --------------------------------------------------------
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [severity, setSeverity] = useState<FeedbackSeverity | "">("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [incVersion, setIncVersion] = useState(true);
  const [incOs, setIncOs] = useState(true);
  const [incLog, setIncLog] = useState(true);
  const [incDevice, setIncDevice] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submittedOk, setSubmittedOk] = useState<string | null>(null);

  // ---- List state --------------------------------------------------------
  const [rows, setRows] = useState<Row[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // ---- List loading ------------------------------------------------------
  // `loadAndFetch` reads tickets.json then fans out one getFeedbackStatus
  // per row in parallel. Both halves fail silently — local read errors give
  // an empty list, remote fetch errors leave `remote = null` so the row
  // shows the local fields with status "unknown".
  const loadAndFetch = useCallback(async () => {
    setRefreshing(true);
    try {
      const tickets = await api.listLocalTickets();
      const initial: Row[] = tickets.items
        .slice()
        .sort((a, b) => b.created_at - a.created_at)
        .map((local) => ({ local, remote: null, fetched: false }));
      if (!aliveRef.current) return;
      setRows(initial);
      setListLoading(false);
      await Promise.all(
        initial.map(async (r, i) => {
          try {
            const remote = await api.getFeedbackStatus(r.local.id, r.local.claim_token);
            if (!aliveRef.current) return;
            setRows((rs) =>
              rs.map((x, j) => (j === i ? { ...x, remote, fetched: true } : x)),
            );
          } catch (e) {
            console.info("get_feedback_status silent fail", e);
          }
        }),
      );
    } catch (e) {
      console.info("list local tickets failed", e);
      if (aliveRef.current) setListLoading(false);
    } finally {
      if (aliveRef.current) setRefreshing(false);
    }
  }, []);

  // First render + every time the user switches back to this panel.
  // Using `visible` as the trigger means we refetch remote status without
  // polling — the user-driven action of clicking the tab acts as the
  // "manual refresh".
  useEffect(() => {
    if (!visible) return;
    void loadAndFetch();
  }, [visible, loadAndFetch]);

  // ---- Submit handler ----------------------------------------------------
  const valid =
    title.trim().length > 0 &&
    title.length <= TITLE_MAX &&
    description.trim().length > 0;

  const resetForm = () => {
    setCategory("bug");
    setSeverity("");
    setTitle("");
    setDescription("");
    setEmail("");
    setFiles([]);
    setIncVersion(true);
    setIncOs(true);
    setIncLog(true);
    setIncDevice(true);
    setSubmitErr(null);
    setSubmittedOk(null);
  };

  const handleSubmit = async () => {
    if (!valid || !hubConnected) return;
    setSubmitting(true);
    setSubmitErr(null);
    setSubmittedOk(null);
    try {
      const atts: FeedbackAttachmentInput[] = [];
      for (const f of files) {
        if (f.size > FILE_BYTE_LIMIT) continue;
        const buf = await f.arrayBuffer();
        const u8 = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
        const b64 = btoa(bin);
        atts.push({
          filename: f.name,
          mime: f.type || "application/octet-stream",
          bytes_b64: b64,
        });
      }
      const created = await api.submitFeedback({
        category,
        severity: severity || undefined,
        title,
        description,
        contact_email: email || undefined,
        include_version: incVersion,
        include_os: incOs,
        include_log_excerpt: incLog,
        include_device_id: incDevice,
        attachments: atts,
      });
      if (!created) {
        setSubmitErr(t("feedback_panel.form.delivery_failed"));
        return;
      }
      // Prepend the new row immediately so the user sees their submission
      // in the list without waiting for a refresh round-trip.
      setRows((rs) => [{ local: created, remote: null, fetched: false }, ...rs]);
      setSubmittedOk(created.id);
      // Clear form fields for the next submission, but keep the OK banner
      // visible until the user manually edits anything.
      setCategory("bug");
      setSeverity("");
      setTitle("");
      setDescription("");
      setEmail("");
      setFiles([]);
      // Best-effort: also fetch the remote status for this brand-new ticket
      // so the list cell fills in. Silent on failure.
      void (async () => {
        try {
          const remote = await api.getFeedbackStatus(created.id, created.claim_token);
          if (!aliveRef.current) return;
          setRows((rs) =>
            rs.map((r) =>
              r.local.id === created.id ? { ...r, remote, fetched: true } : r,
            ),
          );
        } catch (e) {
          console.info("post-submit status fetch failed", e);
        }
      })();
    } catch (e) {
      console.info("submit feedback failed", e);
      setSubmitErr(t("feedback_panel.form.delivery_failed"));
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Render ------------------------------------------------------------
  return (
    <div className="feedback-panel">
      <div className="feedback-form-pane">
        <h2>{t("feedback_panel.form.heading")}</h2>
        {!hubConnected && (
          <div className="feedback-offline-hint">
            {t("feedback_panel.form.offline_hint")}
          </div>
        )}
        <section>
          <label>{t("feedback_panel.form.category")}</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
          >
            <option value="bug">bug</option>
            <option value="feature">feature</option>
            <option value="question">question</option>
            <option value="other">other</option>
          </select>
        </section>
        <section>
          <label>{t("feedback_panel.form.severity")}</label>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as FeedbackSeverity | "")}
          >
            <option value="">{t("feedback_panel.form.severity_unspecified")}</option>
            <option value="blocker">blocker</option>
            <option value="major">major</option>
            <option value="minor">minor</option>
            <option value="trivial">trivial</option>
          </select>
        </section>
        <section>
          <label>{t("feedback_panel.form.title_label", { max: TITLE_MAX })}</label>
          <input
            maxLength={TITLE_MAX}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </section>
        <section>
          <label>{t("feedback_panel.form.description_label")}</label>
          <textarea
            rows={6}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </section>
        <section>
          <label>{t("feedback_panel.form.email_label")}</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </section>
        <section>
          <label>{t("feedback_panel.form.screenshot_label")}</label>
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
        </section>
        <details>
          <summary>{t("feedback_panel.form.auto_attach_summary")}</summary>
          <div className="feedback-auto-attach">
            <label>
              <input
                type="checkbox"
                checked={incVersion}
                onChange={(e) => setIncVersion(e.target.checked)}
              />{" "}
              {t("feedback_panel.form.auto_app_version")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={incOs}
                onChange={(e) => setIncOs(e.target.checked)}
              />{" "}
              {t("feedback_panel.form.auto_os")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={incLog}
                onChange={(e) => setIncLog(e.target.checked)}
              />{" "}
              {t("feedback_panel.form.auto_log")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={incDevice}
                onChange={(e) => setIncDevice(e.target.checked)}
              />{" "}
              {t("feedback_panel.form.auto_device_id")}
            </label>
          </div>
        </details>
        {submitErr && <div className="feedback-error">{submitErr}</div>}
        {submittedOk && (
          <div className="feedback-ok">
            {t("feedback_panel.form.submitted_ok", { id: submittedOk })}
          </div>
        )}
        <div className="feedback-form-actions">
          <button className="btn" onClick={resetForm} disabled={submitting}>
            {t("feedback_panel.form.reset")}
          </button>
          <button
            className="btn primary"
            disabled={!valid || submitting || !hubConnected}
            onClick={handleSubmit}
          >
            {submitting
              ? t("feedback_panel.form.submitting")
              : !hubConnected
              ? t("feedback_panel.form.submit_offline")
              : t("feedback_panel.form.submit")}
          </button>
        </div>

      </div>
      <div className="feedback-list-pane">
        <div className="feedback-list-head">
          <h2>{t("feedback_panel.list.heading")}</h2>
          <button
            className="btn"
            disabled={refreshing || listLoading}
            onClick={() => void loadAndFetch()}
          >
            {refreshing
              ? t("feedback_panel.list.refreshing")
              : t("feedback_panel.list.refresh")}
          </button>
        </div>
        {!hubConnected && (
          <div className="feedback-list-offline">
            {t("feedback_panel.list.offline_note")}
          </div>
        )}
        {listLoading && (
          <div className="feedback-list-empty">
            {t("feedback_panel.list.loading")}
          </div>
        )}
        {!listLoading && rows.length === 0 && (
          <div className="feedback-list-empty">
            {t("feedback_panel.list.empty")}
          </div>
        )}
        {!listLoading && rows.length > 0 && (
          <div className="feedback-list-scroll">
            <table className="feedback-list-table">
              <thead>
                <tr>
                  <th>{t("feedback_panel.list.col_time")}</th>
                  <th>{t("feedback_panel.list.col_category")}</th>
                  <th>{t("feedback_panel.list.col_title")}</th>
                  <th>{t("feedback_panel.list.col_status")}</th>
                  <th>{t("feedback_panel.list.col_note")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.local.id}>
                    <td>{new Date(r.local.created_at).toLocaleString()}</td>
                    <td>{r.local.category}</td>
                    <td title={r.local.title}>{r.local.title}</td>
                    <td className={r.remote ? "status-known" : "status-unknown"}>
                      {r.remote?.status ?? t("feedback_panel.list.status_unknown")}
                    </td>
                    <td title={r.remote?.admin_note ?? ""}>
                      {r.remote?.admin_note ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}



