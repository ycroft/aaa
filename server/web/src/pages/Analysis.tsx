import { useState, useEffect } from 'react';
import { listSessions, getSession, deleteSession, importSessions } from '../api';
import type { WebSessionMeta, SessionDetail } from '../types';
// @ts-ignore
import { SessionViewer } from '../components/SessionViewer';

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [employeeId, setEmployeeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    setLoading(true);
    setMsg('');
    try {
      await importSessions(employeeId, startDate, endDate);
      onClose();
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      if (status === 501) {
        setMsg('数据源导入功能待接入内网接口，请联系管理员。');
      } else {
        setMsg((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">导入会话</div>
        <div className="form-group">
          <label className="form-label">员工工号</label>
          <input className="form-input" value={employeeId} onChange={e => setEmployeeId(e.target.value)} placeholder="e.g. E12345" />
        </div>
        <div className="form-group">
          <label className="form-label">开始日期</label>
          <input className="form-input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">结束日期</label>
          <input className="form-input" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
        </div>
        {msg && <div className="alert-info">{msg}</div>}
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={loading}>
            {loading ? '导入中…' : '导入'}
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

function fmtDate(s: number) {
  return new Date(s).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function Analysis() {
  const [sessions, setSessions] = useState<WebSessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [showImport, setShowImport] = useState(false);

  useEffect(() => {
    listSessions().then(r => setSessions(r.items)).catch(() => {});
  }, []);

  async function selectSession(item: WebSessionMeta) {
    if (item.id === activeId) return;
    setActiveId(item.id);
    setSession(null);
    setSessionLoading(true);
    try {
      const detail = await getSession(item.id);
      setSession(detail);
    } finally {
      setSessionLoading(false);
    }
  }

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    await deleteSession(id).catch(() => {});
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeId === id) { setActiveId(null); setSession(null); }
  }

  return (
    <div className="app-layout">
      <aside className="app-sidebar">
        <div className="sidebar-header">
          <span className="sidebar-title">会话分析</span>
          <button className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: 12 }} onClick={() => setShowImport(true)}>导入</button>
        </div>
        <div className="session-list">
          {sessions.length === 0 && <div className="empty-state" style={{ padding: '40px 20px', fontSize: 12 }}>暂无会话<br />点击"导入"添加</div>}
          {sessions.map(item => (
            <div
              key={item.id}
              className={`session-item${activeId === item.id ? ' active' : ''}`}
              onClick={() => selectSession(item)}
            >
              <div className="session-item-title">
                <span className="provider-badge">{item.provider_id}</span>
                {item.summary.title || item.session_id}
              </div>
              <div className="session-item-meta">
                {item.imported_at && fmtDate(item.imported_at)} · {fmtTokens(item.summary.total_input_tokens + item.summary.total_output_tokens)} tok
              </div>
              <button className="session-item-delete" onClick={e => handleDelete(e, item.id)}>×</button>
            </div>
          ))}
        </div>
      </aside>

      <main className="app-main">
        {!activeId && !sessionLoading && (
          <div className="empty-state" style={{ paddingTop: 100 }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
            <div style={{ fontSize: 15, marginBottom: 6 }}>选择左侧会话以查看详情</div>
            <div style={{ fontSize: 12 }}>或点击"导入"从内网接口拉取会话数据</div>
          </div>
        )}
        {sessionLoading && <div className="spinner" />}
        {session && !sessionLoading && (
          <SessionViewer session={session} loading={false} error={null} expandAll={false} previewChars={220} onCounts={() => {}} />
        )}
      </main>

      {showImport && <ImportDialog onClose={() => setShowImport(false)} />}
    </div>
  );
}
