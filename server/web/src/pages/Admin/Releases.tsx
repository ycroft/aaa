import { useState, useEffect, useRef } from 'react';
import { publishRelease, listReleases } from '../../api';
import type { ReleaseItem } from '../../types';

export default function AdminReleases() {
  const [version, setVersion] = useState('');
  const artifactRef = useRef<HTMLInputElement>(null);
  const signatureRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [releases, setReleases] = useState<ReleaseItem[]>([]);

  useEffect(() => {
    listReleases().then(r => setReleases(r.items)).catch(() => {});
  }, []);

  async function handleSubmit() {
    const artifact = artifactRef.current?.files?.[0];
    const signature = signatureRef.current?.files?.[0];
    if (!version.trim() || !artifact || !signature) {
      setMsg({ type: 'err', text: '请填写所有必填项' });
      return;
    }
    setSubmitting(true);
    setMsg(null);
    try {
      await publishRelease(version.trim(), artifact, signature);
      setMsg({ type: 'ok', text: `v${version.trim()} 发布成功` });
      setVersion('');
      if (artifactRef.current) artifactRef.current.value = '';
      if (signatureRef.current) signatureRef.current.value = '';
      listReleases().then(r => setReleases(r.items)).catch(() => {});
    } catch (e: unknown) {
      setMsg({ type: 'err', text: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page-container">
      <h1 className="page-title">发布管理</h1>

      <div className="card" style={{ marginBottom: 24, maxWidth: 480 }}>
        <div className="card-title">上传新版本</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-group">
            <label className="form-label">版本号（SemVer）</label>
            <input className="form-input" value={version} onChange={e => setVersion(e.target.value)} placeholder="e.g. 0.5.0" />
          </div>
          <div className="form-group">
            <label className="form-label">安装包文件（.msi 或 .exe）</label>
            <input className="form-input" type="file" ref={artifactRef} accept=".msi,.exe" />
          </div>
          <div className="form-group">
            <label className="form-label">签名文件</label>
            <input className="form-input" type="file" ref={signatureRef} />
          </div>
          {msg && <div className={msg.type === 'ok' ? 'alert-info' : 'alert-error'}>{msg.text}</div>}
          <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting} style={{ alignSelf: 'flex-start' }}>
            {submitting ? '上传中…' : '发布'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">已发布版本</div>
        {releases.length === 0 ? (
          <div className="empty-state" style={{ padding: '30px 0' }}>暂无版本</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>版本</th>
                <th>MSI</th>
                <th>NSIS</th>
              </tr>
            </thead>
            <tbody>
              {releases.map(r => (
                <tr key={r.version}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{r.version}</td>
                  <td><a href={r.msi_url} style={{ color: 'var(--accent)', fontSize: 12 }}>下载</a></td>
                  <td><a href={r.nsis_url} style={{ color: 'var(--accent)', fontSize: 12 }}>下载</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
