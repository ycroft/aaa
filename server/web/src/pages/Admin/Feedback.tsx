import { useState, useEffect } from 'react';
import { getAdminFeedback, patchAdminFeedback } from '../../api';
import type { FeedbackItem } from '../../types';

const STATUSES = ['all', 'new', 'triaged', 'in_progress', 'resolved', 'wontfix'] as const;
const PAGE_SIZE = 50;

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge ${status}`}>{status}</span>;
}

function DetailModal({ item, onClose, onSaved }: { item: FeedbackItem; onClose: () => void; onSaved: (updated: FeedbackItem) => void }) {
  const [status, setStatus] = useState(item.status);
  const [note, setNote] = useState(item.admin_note ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setSaving(true);
    setError('');
    try {
      await patchAdminFeedback(item.id, { status, admin_note: note });
      onSaved({ ...item, status, admin_note: note });
    } catch (e: unknown) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">{item.title}</div>
        <div style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--text-3)' }}>
          <span>{item.category}</span>
          {item.severity && <span>· {item.severity}</span>}
          <span>· {item.app_version}</span>
          <span>· {item.os_info}</span>
        </div>
        <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '10px 12px', fontSize: 13, color: 'var(--text-1)', whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto' }}>
          {item.description}
        </div>
        {item.contact_email && (
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>联系邮箱：{item.contact_email}</div>
        )}
        <div className="form-group">
          <label className="form-label">状态</label>
          <select className="form-input" value={status} onChange={e => setStatus(e.target.value)}>
            {STATUSES.slice(1).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">管理员备注</label>
          <textarea className="form-input" rows={3} value={note} onChange={e => setNote(e.target.value)} style={{ resize: 'vertical', fontFamily: 'var(--font-sans)' }} />
        </div>
        {error && <div className="alert-error">{error}</div>}
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>关闭</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  );
}

export default function AdminFeedback() {
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [page, setPage] = useState(0);
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<FeedbackItem | null>(null);

  useEffect(() => {
    setLoading(true);
    setError('');
    getAdminFeedback({
      status: statusFilter === 'all' ? undefined : statusFilter,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
      .then(r => setItems(r.items))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [statusFilter, page]);

  function handleSaved(updated: FeedbackItem) {
    setItems(prev => prev.map(i => i.id === updated.id ? updated : i));
    setSelected(null);
  }

  return (
    <div className="page-container">
      <h1 className="page-title">用户反馈</h1>

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        {STATUSES.map(s => (
          <button
            key={s}
            className={`btn ${statusFilter === s ? 'btn-primary' : 'btn-secondary'}`}
            style={{ padding: '4px 12px', fontSize: 12 }}
            onClick={() => { setStatusFilter(s); setPage(0); }}
          >
            {s === 'all' ? '全部' : s}
          </button>
        ))}
      </div>

      {loading && <div className="spinner" />}
      {error && <div className="alert-error">{error}</div>}
      {!loading && !error && items.length === 0 && <div className="empty-state">暂无反馈数据</div>}
      {items.length > 0 && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>状态</th>
                <th>分类</th>
                <th>标题</th>
                <th>版本</th>
                <th>提交时间</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id} onClick={() => setSelected(item)}>
                  <td><StatusBadge status={item.status} /></td>
                  <td style={{ fontSize: 12, color: 'var(--text-3)' }}>{item.category}</td>
                  <td>{item.title}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{item.app_version}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-3)' }}>{new Date(item.created_at).toLocaleDateString('zh-CN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setPage(p => p - 1)} disabled={page === 0}>上一页</button>
            <span style={{ color: 'var(--text-3)', fontSize: 13, alignSelf: 'center' }}>第 {page + 1} 页</span>
            <button className="btn btn-secondary" onClick={() => setPage(p => p + 1)} disabled={items.length < PAGE_SIZE}>下一页</button>
          </div>
        </>
      )}

      {selected && <DetailModal item={selected} onClose={() => setSelected(null)} onSaved={handleSaved} />}
    </div>
  );
}
