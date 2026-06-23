import { NavLink, Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { useTheme } from '../theme';

export default function NavBar() {
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();

  function logout() {
    document.cookie = 'aaa_user=; path=/; max-age=0';
    window.location.href = '/login';
  }

  return (
    <nav className="nav">
      <Link to="/" className="nav-logo">AAA · Agent Analyzer</Link>
      <div className="nav-links">
        <NavLink to="/download" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>下载</NavLink>
        {user && <NavLink to="/app/analysis" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>分析</NavLink>}
        {user && <NavLink to="/app/dashboard" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>看板</NavLink>}
        {user?.is_admin && <NavLink to="/app/admin/feedback" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>反馈</NavLink>}
        {user?.is_admin && <NavLink to="/app/admin/releases" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>发布</NavLink>}
      </div>
      <button className="btn btn-secondary" onClick={toggleTheme} style={{ padding: '4px 10px', fontSize: 13 }}>
        {theme === 'dark' ? '☀️' : '🌙'}
      </button>
      {user ? (
        <div className="nav-user-chip">
          <span>{user.display_name}</span>
          {user.is_admin && <span className="nav-role-badge">admin</span>}
          <button className="btn btn-secondary" onClick={logout} style={{ padding: '3px 8px', fontSize: 12 }}>退出</button>
        </div>
      ) : (
        <Link to="/login" className="btn btn-secondary" style={{ fontSize: 13 }}>登录</Link>
      )}
    </nav>
  );
}
