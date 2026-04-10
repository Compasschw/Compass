import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './features/auth/AuthContext';
import { Layout } from './shared/components/Layout';

// Lazy-loaded page components
const WaitlistLandingPage = lazy(() => import('./features/landing/WaitlistLandingPage').then(m => ({ default: m.WaitlistLandingPage })));
const LandingPageA = lazy(() => import('./features/landing/LandingPageA').then(m => ({ default: m.LandingPageA })));
const LandingPageB = lazy(() => import('./features/landing/LandingPageB').then(m => ({ default: m.LandingPageB })));
const LandingPageC = lazy(() => import('./features/landing/LandingPageC').then(m => ({ default: m.LandingPageC })));
const LoginPage = lazy(() => import('./features/auth/LoginPage').then(m => ({ default: m.LoginPage })));
const RegisterPage = lazy(() => import('./features/auth/RegisterPage').then(m => ({ default: m.RegisterPage })));
const CHWOnboarding = lazy(() => import('./features/onboarding/CHWOnboarding').then(m => ({ default: m.CHWOnboarding })));
const MemberOnboarding = lazy(() => import('./features/onboarding/MemberOnboarding').then(m => ({ default: m.MemberOnboarding })));
const WaitlistAdmin = lazy(() => import('./features/admin/WaitlistAdmin').then(m => ({ default: m.WaitlistAdmin })));
const LegalPage = lazy(() => import('./features/legal/LegalPage').then(m => ({ default: m.LegalPage })));
const CHWDashboard = lazy(() => import('./features/chw/CHWDashboard').then(m => ({ default: m.CHWDashboard })));
const CHWRequests = lazy(() => import('./features/chw/CHWRequests').then(m => ({ default: m.CHWRequests })));
const CHWSessions = lazy(() => import('./features/chw/CHWSessions').then(m => ({ default: m.CHWSessions })));
const CHWEarnings = lazy(() => import('./features/chw/CHWEarnings').then(m => ({ default: m.CHWEarnings })));
const CHWProfile = lazy(() => import('./features/chw/CHWProfile').then(m => ({ default: m.CHWProfile })));
const CHWCalendar = lazy(() => import('./features/chw/CHWCalendar').then(m => ({ default: m.CHWCalendar })));
const MemberHome = lazy(() => import('./features/member/MemberHome').then(m => ({ default: m.MemberHome })));
const MemberFind = lazy(() => import('./features/member/MemberFind').then(m => ({ default: m.MemberFind })));
const MemberSessions = lazy(() => import('./features/member/MemberSessions').then(m => ({ default: m.MemberSessions })));
const MemberRoadmap = lazy(() => import('./features/member/MemberRoadmap').then(m => ({ default: m.MemberRoadmap })));
const MemberProfile = lazy(() => import('./features/member/MemberProfile').then(m => ({ default: m.MemberProfile })));
const MemberCalendar = lazy(() => import('./features/member/MemberCalendar').then(m => ({ default: m.MemberCalendar })));

function LoadingSpinner() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#FBF7F0]">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#6B8F71] border-t-transparent" />
        <span className="text-sm text-[#6B7280]">Loading...</span>
      </div>
    </div>
  );
}

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
  if (!isAuthenticated) return <WaitlistLandingPage />;
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
    <Suspense fallback={<LoadingSpinner />}>
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
      <Route path="/admin/waitlist" element={<ProtectedRoute><WaitlistAdmin /></ProtectedRoute>} />

      {/* Catch-all — redirect to root */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}
