import { useState, useEffect } from 'react';
import { listReleases } from '../api';
import type { ReleaseItem } from '../types';

export default function Download() {
  const [items, setItems] = useState<ReleaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    listReleases()
      .then(r => setItems(r.items))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
    fetch('/api/release-notes').then(r => r.text()).then(setNotes).catch(() => {});
  }, []);

  return (
    <div className="page-container">
      <h1 className="page-title">下载</h1>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-title">系统要求</div>
        <ul style={{ color: 'var(--text-2)', fontSize: 13, paddingLeft: 20, lineHeight: 2 }}>
          <li>Windows 10 / 11（64 位）</li>
          <li>Microsoft Edge WebView2 Runtime（Windows 11 与现行 Windows 10 自带；老镜像请至微软官网下载 Evergreen 版本）</li>
        </ul>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-title">版本列表</div>
        {loading && <div className="spinner" />}
        {error && <div className="alert-error">{error}</div>}
        {!loading && !error && items.length === 0 && <div className="empty-state">暂无可用版本</div>}
        {items.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>版本</th>
                <th>MSI 安装包</th>
                <th>NSIS 安装包</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.version}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{item.version}</td>
                  <td><a href={item.msi_url} style={{ color: 'var(--accent)' }}>下载 MSI</a></td>
                  <td><a href={item.nsis_url} style={{ color: 'var(--accent)' }}>下载 NSIS</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {notes && (
        <div className="card">
          <div className="card-title">Release Notes</div>
          <pre style={{
            margin: 0,
            fontFamily: 'var(--font-sans)',
            fontSize: 13,
            color: 'var(--text-2)',
            whiteSpace: 'pre-wrap',
            lineHeight: 1.7,
            userSelect: 'text',
            cursor: 'text',
          }}>{notes}</pre>
        </div>
      )}
    </div>
  );
}
