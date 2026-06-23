import { useState, useEffect } from 'react';
import { listReleases } from '../api';
import type { ReleaseItem } from '../types';

export default function Download() {
  const [items, setItems] = useState<ReleaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    listReleases()
      .then(r => setItems(r.items))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
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

      <div className="alert-info" style={{ fontSize: 13 }}>
        完整版本说明请前往 <a href="https://github.com" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>GitHub Releases</a> 页面查看。
      </div>
    </div>
  );
}
