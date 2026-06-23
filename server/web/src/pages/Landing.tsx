import { Link } from 'react-router-dom';

export default function Landing() {
  return (
    <div>
      <div className="hero">
        <h1 className="hero-title">AAA · Agent Analyzer</h1>
        <p className="hero-sub">面向AI编码代理的会话日志分析平台</p>
        <div className="hero-actions">
          <Link to="/download" className="btn btn-primary" style={{ fontSize: 15, padding: '10px 24px' }}>立即下载</Link>
          <Link to="/app/analysis" className="btn btn-secondary" style={{ fontSize: 15, padding: '10px 24px' }}>进入应用</Link>
        </div>
      </div>

      <div className="page-container">
        <div className="feature-grid">
          <div className="card">
            <div className="card-title">多 Backend 支持</div>
            <p style={{ color: 'var(--text-2)', fontSize: 13 }}>原生支持 Claude Code、opencode 等主流 AI 编码代理，统一读取本地日志格式。</p>
          </div>
          <div className="card">
            <div className="card-title">成本与上下文追踪</div>
            <p style={{ color: 'var(--text-2)', fontSize: 13 }}>可视化 token 用量、缓存命中率与上下文窗口走势，精准定位成本峰值。</p>
          </div>
          <div className="card">
            <div className="card-title">可视化时间线</div>
            <p style={{ color: 'var(--text-2)', fontSize: 13 }}>折叠式消息时间线，峰值节点标红、上下文跳跃点标橙，快速定位问题所在。</p>
          </div>
        </div>

        <div className="screenshot-section" style={{ marginTop: 56 }}>
          <div className="screenshot-placeholder">会话列表截图预览</div>
          <div className="screenshot-desc">
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 10 }}>会话总览</h2>
            <p style={{ color: 'var(--text-2)', lineHeight: 1.7 }}>在侧边栏快速浏览所有 AI 编码代理会话，查看 token 消耗、会话时长与上下文峰值，一目了然地掌握各会话概况。</p>
          </div>
        </div>

        <div className="screenshot-section reverse">
          <div className="screenshot-placeholder">时间线详情截图预览</div>
          <div className="screenshot-desc">
            <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 10 }}>消息时间线</h2>
            <p style={{ color: 'var(--text-2)', lineHeight: 1.7 }}>展开任意会话，逐条查看 user/assistant/tool 消息，峰值节点自动标红，帮助定位"上下文窗口在哪一条消息炸掉"的根因。</p>
          </div>
        </div>

        <div className="cta-banner">
          <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>开始使用</h2>
          <p style={{ color: 'var(--text-2)', marginBottom: 20 }}>下载桌面客户端，或在浏览器中直接分析已导入的会话。</p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <Link to="/download" className="btn btn-primary">立即下载</Link>
            <Link to="/app/analysis" className="btn btn-secondary">在线分析</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
