import { useState } from 'react';

export default function Login() {
  const [devUser, setDevUser] = useState('');

  function handleDevLogin() {
    if (!devUser.trim()) return;
    // TODO(real-sso): 实际实现时，此处跳转至公司 SSO URL，回跳后 SSO 服务已设置 cookie
    document.cookie = `aaa_user=${encodeURIComponent(devUser.trim())}; path=/`;
    window.location.href = '/app/analysis';
  }

  return (
    <div className="page-container" style={{ maxWidth: 480, marginTop: 60 }}>
      <div className="card">
        <div className="card-title">身份验证</div>
        {import.meta.env.DEV ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ color: 'var(--text-2)', fontSize: 13 }}>开发模式：输入用户标识以模拟登录。</p>
            <div className="form-group">
              <label className="form-label">用户标识（aaa_user cookie 值）</label>
              <input
                className="form-input"
                value={devUser}
                onChange={e => setDevUser(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleDevLogin()}
                placeholder="e.g. alice"
              />
            </div>
            <button className="btn btn-primary" onClick={handleDevLogin}>以此身份登录</button>
          </div>
        ) : (
          <div className="alert-info" style={{ fontSize: 13 }}>
            请通过公司内网访问此页面以完成身份验证。
          </div>
        )}
      </div>
    </div>
  );
}
