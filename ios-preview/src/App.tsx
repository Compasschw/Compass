import { Navigate, Route, Routes } from 'react-router-dom';
import { IPhoneFrame } from './components/IPhoneFrame';
import { LoginPage } from './features/auth/LoginPage';
import { useAuth } from './features/auth/AuthContext';
import { CHWDashboard } from './features/chw/CHWDashboard';
import { CHWRequests } from './features/chw/CHWRequests';
import { CHWSessions } from './features/chw/CHWSessions';
import { CHWEarnings } from './features/chw/CHWEarnings';
import { CHWProfile } from './features/chw/CHWProfile';
import { MemberHome } from './features/member/MemberHome';
import { MemberFindCHW } from './features/member/MemberFindCHW';
import { MemberSessions } from './features/member/MemberSessions';
import { MemberRoadmap } from './features/member/MemberRoadmap';
import { MemberProfile } from './features/member/MemberProfile';

// ─── Auth guard ───────────────────────────────────────────────────────────────

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
}

// ─── Role redirect ────────────────────────────────────────────────────────────

function RoleRedirect() {
  const { isAuthenticated, userRole } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (userRole === 'chw') return <Navigate to="/chw/dashboard" replace />;
  if (userRole === 'member') return <Navigate to="/member/home" replace />;
  return <Navigate to="/login" replace />;
}

// ─── App ─────────────────────────────────────────────────────────────────────

/**
 * Root app component.
 * The IPhoneFrame wraps the entire route tree so every page renders inside
 * the device chrome. Routes mirror the web app structure.
 */
export default function App() {
  return (
    <IPhoneFrame>
      <Routes>
        {/* Root redirect */}
        <Route path="/" element={<RoleRedirect />} />

        {/* Auth */}
        <Route path="/login" element={<LoginPage />} />

        {/* CHW routes */}
        <Route
          path="/chw/dashboard"
          element={
            <RequireAuth>
              <CHWDashboard />
            </RequireAuth>
          }
        />
        <Route
          path="/chw/requests"
          element={
            <RequireAuth>
              <CHWRequests />
            </RequireAuth>
          }
        />
        <Route
          path="/chw/sessions"
          element={
            <RequireAuth>
              <CHWSessions />
            </RequireAuth>
          }
        />
        <Route
          path="/chw/earnings"
          element={
            <RequireAuth>
              <CHWEarnings />
            </RequireAuth>
          }
        />
        <Route
          path="/chw/profile"
          element={
            <RequireAuth>
              <CHWProfile />
            </RequireAuth>
          }
        />

        {/* Member routes */}
        <Route
          path="/member/home"
          element={
            <RequireAuth>
              <MemberHome />
            </RequireAuth>
          }
        />
        <Route
          path="/member/find-chw"
          element={
            <RequireAuth>
              <MemberFindCHW />
            </RequireAuth>
          }
        />
        <Route
          path="/member/sessions"
          element={
            <RequireAuth>
              <MemberSessions />
            </RequireAuth>
          }
        />
        <Route
          path="/member/roadmap"
          element={
            <RequireAuth>
              <MemberRoadmap />
            </RequireAuth>
          }
        />
        <Route
          path="/member/profile"
          element={
            <RequireAuth>
              <MemberProfile />
            </RequireAuth>
          }
        />

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </IPhoneFrame>
  );
}
