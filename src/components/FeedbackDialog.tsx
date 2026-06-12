import { useState } from 'react';
import { api } from '../api';
import type {
  FeedbackCategory,
  FeedbackSeverity,
  FeedbackAttachmentInput,
} from '../types';
import { useT } from "../i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmitted: (id: string) => void;
}

const TITLE_MAX = 80;
const FILE_BYTE_LIMIT = 10 * 1024 * 1024;

export function FeedbackDialog({ open, onClose, onSubmitted }: Props) {
  const t = useT();
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [severity, setSeverity] = useState<FeedbackSeverity | ''>('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [email, setEmail] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [incVersion, setIncVersion] = useState(true);
  const [incOs, setIncOs] = useState(true);
  const [incLog, setIncLog] = useState(true);
  const [incDevice, setIncDevice] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) return null;
  const valid =
    title.trim().length > 0 &&
    title.length <= TITLE_MAX &&
    description.trim().length > 0;

  const handleSubmit = async () => {
    if (!valid) return;
    setSubmitting(true);
    setErr(null);
    try {
      const atts: FeedbackAttachmentInput[] = [];
      for (const f of files) {
        if (f.size > FILE_BYTE_LIMIT) continue;
        const buf = await f.arrayBuffer();
        const u8 = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
        const b64 = btoa(bin);
        atts.push({
          filename: f.name,
          mime: f.type || 'application/octet-stream',
          bytes_b64: b64,
        });
      }
      const res = await api.submitFeedback({
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
      if (res) {
        onSubmitted(res.id);
        onClose();
      } else {
        setErr(t("feedback.delivery_failed"));
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.info('submit feedback failed', e);
      setErr(t("feedback.delivery_failed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 560 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{t("feedback.title")}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label>
            {t("feedback.category")}
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
              style={{ marginLeft: 8 }}
            >
              <option value="bug">bug</option>
              <option value="feature">feature</option>
              <option value="question">question</option>
              <option value="other">other</option>
            </select>
          </label>
          <label>
            {t("feedback.severity")}
            <select
              value={severity}
              onChange={(e) =>
                setSeverity(e.target.value as FeedbackSeverity | '')
              }
              style={{ marginLeft: 8 }}
            >
              <option value="">{t("feedback.severity_unspecified")}</option>
              <option value="blocker">blocker</option>
              <option value="major">major</option>
              <option value="minor">minor</option>
              <option value="trivial">trivial</option>
            </select>
          </label>
          <label>
            {t("feedback.title_label", { max: TITLE_MAX })}
            <input
              maxLength={TITLE_MAX}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{ width: '100%' }}
            />
          </label>
          <label>
            {t("feedback.description_label")}
            <textarea
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{ width: '100%' }}
            />
          </label>
          <label>
            {t("feedback.email_label")}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ width: '100%' }}
            />
          </label>
          <label>
            {t("feedback.screenshot_label")}
            <input
              type="file"
              multiple
              accept="image/png,image/jpeg"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </label>
          <details>
            <summary>{t("feedback.auto_attach_summary")}</summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
              <label>
                <input
                  type="checkbox"
                  checked={incVersion}
                  onChange={(e) => setIncVersion(e.target.checked)}
                />{' '}
                {t("feedback.auto_app_version")}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={incOs}
                  onChange={(e) => setIncOs(e.target.checked)}
                />{' '}
                {t("feedback.auto_os")}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={incLog}
                  onChange={(e) => setIncLog(e.target.checked)}
                />{' '}
                {t("feedback.auto_log")}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={incDevice}
                  onChange={(e) => setIncDevice(e.target.checked)}
                />{' '}
                {t("feedback.auto_device_id")}
              </label>
            </div>
          </details>
          {err && <div style={{ color: '#a33' }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={onClose}>{t("feedback.cancel")}</button>
            <button disabled={!valid || submitting} onClick={handleSubmit}>
              {submitting ? t("feedback.submitting") : t("feedback.submit")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
