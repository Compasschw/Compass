import { Routes, Route, Navigate } from 'react-router-dom';

// Landing pages
import { WaitlistLandingPage } from './features/landing/WaitlistLandingPage';
import { LandingPageA } from './features/landing/LandingPageA';
import { LandingPageB } from './features/landing/LandingPageB';
import { LandingPageC } from './features/landing/LandingPageC';

// Auth
import { LoginPage } from './features/auth/LoginPage';
import { RegisterPage } from './features/auth/RegisterPage';
import { useAuth } from './features/auth/AuthContext';

// Onboarding
import { CHWOnboarding } from './features/onboarding/CHWOnboarding';
import { MemberOnboarding } from './features/onboarding/MemberOnboarding';

// Layout
import { Layout } from './shared/components/Layout';
import { WaitlistAdmin } from './features/admin/WaitlistAdmin';
import { LegalPage } from './features/legal/LegalPage';

// CHW pages
import { CHWDashboard } from './features/chw/CHWDashboard';
import { CHWRequests } from './features/chw/CHWRequests';
import { CHWSessions } from './features/chw/CHWSessions';
import { CHWEarnings } from './features/chw/CHWEarnings';
import { CHWProfile } from './features/chw/CHWProfile';

// Member pages
import { MemberHome } from './features/member/MemberHome';
import { MemberFind } from './features/member/MemberFind';
import { MemberSessions } from './features/member/MemberSessions';
import { MemberRoadmap } from './features/member/MemberRoadmap';
import { MemberProfile } from './features/member/MemberProfile';

// Calendar pages
import { CHWCalendar } from './features/chw/CHWCalendar';
import { MemberCalendar } from './features/member/MemberCalendar';

// ─── Guard components ──────────────────────────────────────────────────────────

/**
 * Redirects unauthenticated users to /login.
 * Renders children inside the authenticated Layout shell when authenticated.
 */
function ProtectedRoute({ children, requiredRole }: { children: React.ReactNode; requiredRole?: 'chw' | 'member' }) {
  const { isAuthenticated, userRole } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  if (requiredRole && userRole !== requiredRole) {
    const home = userRole === 'chw' ? '/chw/dashboard' : '/member/home';
    return <Navigate to={home} replace />;
  }
  return <Layout>{children}</Layout>;
}

// ─── Root redirect ─────────────────────────────────────────────────────────────

/**
 * Sends authenticated users to their role-appropriate home screen;
 * unauthenticated users land on the public landing page.
 */
function RootRedirect() {
  const { isAuthenticated, userRole } = useAuth();
  if (!isAuthenticated) return <Navigate to="/landing" replace />;
  if (userRole === 'chw') return <Navigate to="/chw/dashboard" replace />;
  return <Navigate to="/member/home" replace />;
}

// ─── App router ───────────────────────────────────────────────────────────────

/**
 * Application-level route tree.
 *
 * Public routes   — /login, /register
 * Onboarding      — /onboarding/chw, /onboarding/member (no Layout chrome)
 * CHW routes      — /chw/* (Layout with CHW nav)
 * Member routes   — /member/* (Layout with Member nav)
 */
export default function App() {
  return (
    <Routes>
      {/* Root redirect */}
      <Route path="/" element={<RootRedirect />} />

      {/* Public marketing page */}
      <Route path="/landing" element={<WaitlistLandingPage />} />
      <Route path="/landing/a" element={<LandingPageA />} />
      <Route path="/landing/b" element={<LandingPageB />} />
      <Route path="/landing/c" element={<LandingPageC />} />

      {/* Public auth pages */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      {/* Onboarding (no persistent nav chrome) */}
      <Route path="/onboarding/chw" element={<CHWOnboarding />} />
      <Route path="/onboarding/member" element={<MemberOnboarding />} />

      {/* CHW routes */}
      <Route
        path="/chw/dashboard"
        element={
          <ProtectedRoute requiredRole="chw">
            <CHWDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/chw/requests"
        element={
          <ProtectedRoute requiredRole="chw">
            <CHWRequests />
          </ProtectedRoute>
        }
      />
      <Route
        path="/chw/sessions"
        element={
          <ProtectedRoute requiredRole="chw">
            <CHWSessions />
          </ProtectedRoute>
        }
      />
      <Route
        path="/chw/earnings"
        element={
          <ProtectedRoute requiredRole="chw">
            <CHWEarnings />
          </ProtectedRoute>
        }
      />
      <Route
        path="/chw/profile"
        element={
          <ProtectedRoute requiredRole="chw">
            <CHWProfile />
          </ProtectedRoute>
        }
      />

      {/* Member routes */}
      <Route
        path="/member/home"
        element={
          <ProtectedRoute requiredRole="member">
            <MemberHome />
          </ProtectedRoute>
        }
      />
      <Route
        path="/member/find"
        element={
          <ProtectedRoute requiredRole="member">
            <MemberFind />
          </ProtectedRoute>
        }
      />
      <Route
        path="/member/sessions"
        element={
          <ProtectedRoute requiredRole="member">
            <MemberSessions />
          </ProtectedRoute>
        }
      />
      <Route
        path="/member/roadmap"
        element={
          <ProtectedRoute requiredRole="member">
            <MemberRoadmap />
          </ProtectedRoute>
        }
      />
      <Route
        path="/member/profile"
        element={
          <ProtectedRoute requiredRole="member">
            <MemberProfile />
          </ProtectedRoute>
        }
      />

      {/* Calendar routes */}
      <Route
        path="/chw/calendar"
        element={
          <ProtectedRoute requiredRole="chw">
            <CHWCalendar />
          </ProtectedRoute>
        }
      />
      <Route
        path="/member/calendar"
        element={
          <ProtectedRoute requiredRole="member">
            <MemberCalendar />
          </ProtectedRoute>
        }
      />

      {/* Legal pages */}
      <Route path="/privacy" element={<LegalPage page="privacy" />} />
      <Route path="/terms" element={<LegalPage page="terms" />} />
      <Route path="/hipaa" element={<LegalPage page="hipaa" />} />
      <Route path="/contact" element={<LegalPage page="contact" />} />

      {/* Admin */}
      <Route path="/admin/waitlist" element={<WaitlistAdmin />} />

      {/* Catch-all — redirect to root */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
