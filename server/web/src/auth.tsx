import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { getMe } from './api';
import type { WebUser } from './types';

interface AuthCtx {
  user: WebUser | null;
  loading: boolean;
  reload: () => void;
}

const AuthContext = createContext<AuthCtx>({ user: null, loading: true, reload: () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<WebUser | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = () => {
    setLoading(true);
    getMe().then(u => { setUser(u); setLoading(false); }).catch(() => { setUser(null); setLoading(false); });
  };

  useEffect(reload, []);

  return <AuthContext.Provider value={{ user, loading, reload }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page-container"><div className="spinner" /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user?.is_admin) return (
    <div className="page-container">
      <div className="alert-error" style={{ marginTop: 40 }}>403 — 无访问权限</div>
    </div>
  );
  return <>{children}</>;
}
