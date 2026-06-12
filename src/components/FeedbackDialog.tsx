import { useState } from 'react';
import { api } from '../api';
import type {
  FeedbackCategory,
  FeedbackSeverity,
  FeedbackAttachmentInput,
} from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmitted: (id: string) => void;
}

const TITLE_MAX = 80;
const FILE_BYTE_LIMIT = 10 * 1024 * 1024;

export function FeedbackDialog({ open, onClose, onSubmitted }: Props) {
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
        setErr('反馈未送达，已留存草稿');
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.info('submit feedback failed', e);
      setErr('反馈未送达，已留存草稿');
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
        <h3>提交反馈</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label>
            分类
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
            严重程度（选填）
            <select
              value={severity}
              onChange={(e) =>
                setSeverity(e.target.value as FeedbackSeverity | '')
              }
              style={{ marginLeft: 8 }}
            >
              <option value="">未指定</option>
              <option value="blocker">blocker</option>
              <option value="major">major</option>
              <option value="minor">minor</option>
              <option value="trivial">trivial</option>
            </select>
          </label>
          <label>
            标题（≤{TITLE_MAX} 字符）
            <input
              maxLength={TITLE_MAX}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{ width: '100%' }}
            />
          </label>
          <label>
            详细描述
            <textarea
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{ width: '100%' }}
            />
          </label>
          <label>
            联系邮箱（选填）
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ width: '100%' }}
            />
          </label>
          <label>
            截图（PNG/JPG，最多 10 MB/张）
            <input
              type="file"
              multiple
              accept="image/png,image/jpeg"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </label>
          <details>
            <summary>自动附带（可逐项取消）</summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
              <label>
                <input
                  type="checkbox"
                  checked={incVersion}
                  onChange={(e) => setIncVersion(e.target.checked)}
                />{' '}
                应用版本号
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={incOs}
                  onChange={(e) => setIncOs(e.target.checked)}
                />{' '}
                操作系统信息
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={incLog}
                  onChange={(e) => setIncLog(e.target.checked)}
                />{' '}
                近期日志摘要（已脱敏）
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={incDevice}
                  onChange={(e) => setIncDevice(e.target.checked)}
                />{' '}
                客户端设备 id（匿名）
              </label>
            </div>
          </details>
          {err && <div style={{ color: '#a33' }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={onClose}>取消</button>
            <button disabled={!valid || submitting} onClick={handleSubmit}>
              {submitting ? '提交中…' : '提交'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
