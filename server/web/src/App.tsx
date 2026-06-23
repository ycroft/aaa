import { Routes, Route } from 'react-router-dom';
import { AuthProvider, RequireAuth, RequireAdmin } from './auth';
import { ThemeProvider } from './theme';
import NavBar from './components/NavBar';
import Landing from './pages/Landing';
import Download from './pages/Download';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Analysis from './pages/Analysis';
import AdminFeedback from './pages/Admin/Feedback';
import AdminReleases from './pages/Admin/Releases';

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <NavBar />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/download" element={<Download />} />
          <Route path="/login" element={<Login />} />
          <Route path="/app/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
          <Route path="/app/analysis" element={<RequireAuth><Analysis /></RequireAuth>} />
          <Route path="/app/admin/feedback" element={<RequireAuth><RequireAdmin><AdminFeedback /></RequireAdmin></RequireAuth>} />
          <Route path="/app/admin/releases" element={<RequireAuth><RequireAdmin><AdminReleases /></RequireAdmin></RequireAuth>} />
        </Routes>
      </AuthProvider>
    </ThemeProvider>
  );
}
