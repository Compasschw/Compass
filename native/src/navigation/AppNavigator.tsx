/**
 * Root navigator for CompassCHW.
 *
 * Routing logic:
 *   - While auth state is loading → blank screen (prevents flash)
 *   - Unauthenticated          → AuthStack  (Login, Waitlist, Landing)
 *   - CHW role                 → CHWTabNavigator
 *   - Admin role               → AdminHomeScreen (Member endpoints 403 for admins)
 *   - Member role              → MemberTabNavigator
 */

import React, { useCallback, useMemo, useRef } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import * as Linking from 'expo-linking';
import {
  NavigationContainer,
  type LinkingOptions,
  type NavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { useAuth } from '../context/AuthContext';
import { useRegisterPushNotifications } from '../hooks/usePushNotifications';
import { useDeepLinks } from '../hooks/useDeepLinks';
import { colors } from '../theme/colors';
import { LandingScreen } from '../screens/LandingScreen';
import { LoginScreen } from '../screens/auth/LoginScreen';
import { MagicLinkScreen } from '../screens/auth/MagicLinkScreen';
import { RegisterScreen } from '../screens/auth/RegisterScreen';
import { WaitlistScreen } from '../screens/auth/WaitlistScreen';
import { CHWIntakeScreen } from '../screens/chw/CHWIntakeScreen';
import { LegalScreen, type LegalPage } from '../screens/LegalScreen';
import { AdminHomeScreen } from '../screens/admin/AdminHomeScreen';
import { CHWTabNavigator } from './CHWTabNavigator';
import { MemberTabNavigator } from './MemberTabNavigator';

// ─── Web-only preview hatch (for team demos) ─────────────────────────────────
//
// Opening the web build with `?preview=intake` in the URL renders the CHW
// intake screen standalone with local state — no auth, no backend. Lets us
// share a single URL with TJ/Jemal to walk through the questionnaire UX
// without provisioning a CHW account.
function isPreviewRequested(slug: string): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  return window.location.search.includes(`preview=${slug}`);
}

// ─── Auth stack param list ────────────────────────────────────────────────────

export type AuthStackParamList = {
  Landing: undefined;
  Login: undefined;
  Register: undefined;
  Waitlist: undefined;
  MagicLink: { token?: string } | undefined;
  Legal: { page: LegalPage } | undefined;
};

// ─── Root stack param list ────────────────────────────────────────────────────

export type RootStackParamList = {
  Auth: undefined;
  CHW: undefined;
  Admin: undefined;
  Member: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const RootStack = createNativeStackNavigator<RootStackParamList>();
const PreviewStack = createNativeStackNavigator<{ Preview: undefined }>();

function PreviewIntakeRoute(): React.JSX.Element {
  return <CHWIntakeScreen previewMode />;
}

// ─── Auth stack ───────────────────────────────────────────────────────────────

interface AuthNavigatorProps {
  /** Initial route. Defaults to Landing (marketing page) for first-time visitors;
   *  AppNavigator passes `Login` after a sign-out so users skip the marketing
   *  pitch on the way back in. */
  initialRoute?: keyof AuthStackParamList;
}

function AuthNavigator({ initialRoute = 'Landing' }: AuthNavigatorProps): React.JSX.Element {
  return (
    <AuthStack.Navigator
      initialRouteName={initialRoute}
      screenOptions={{ headerShown: false }}
    >
      {/* Landing is the default initial route — unauthenticated users see the
          marketing page first before proceeding to Login/Register. After
          sign-out the initial route is overridden to Login. */}
      <AuthStack.Screen name="Landing" component={LandingScreen} />
      <AuthStack.Screen name="Waitlist" component={WaitlistScreen} />
      {/* MagicLink is always registered so deep links from email can route to it
          even pre-launch. The screen itself shows "Coming soon" if verification
          fails because the user isn't provisioned. */}
      <AuthStack.Screen name="MagicLink" component={MagicLinkScreen} />
      {/* Login is sign-in. RegisterScreen is the new self-service signup —
          launched 2026-05 alongside the Golden Path go-live so Jemal/JT and
          subsequent users can onboard themselves without waitlist intervention.
          Waitlist remains available for pre-launch leads. */}
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Register" component={RegisterScreen} />
      {/* LegalScreen reads `page` from route params so a single registration
          serves Privacy / Terms / HIPAA / Contact via navigation.navigate(
          'Legal', { page: 'privacy' | 'terms' | 'hipaa' | 'contact' }). */}
      <AuthStack.Screen name="Legal">
        {({ route }) => (
          <LegalScreen page={route.params?.page ?? 'privacy'} />
        )}
      </AuthStack.Screen>
    </AuthStack.Navigator>
  );
}

// ─── CHW root ─────────────────────────────────────────────────────────────────

function CHWNavigator(): React.JSX.Element {
  return <CHWTabNavigator />;
}

// ─── Member root ──────────────────────────────────────────────────────────────

function MemberNavigator(): React.JSX.Element {
  return <MemberTabNavigator />;
}

// ─── Admin root ───────────────────────────────────────────────────────────────
//
// Admins land on a dedicated screen rather than falling through to the Member
// tabs. Member endpoints are guarded by `require_role("member")` server-side
// and 403 for any admin token, which previously rendered an empty/skeleton UI
// and made the app look broken for admin accounts.

function AdminNavigator(): React.JSX.Element {
  return <AdminHomeScreen />;
}

// ─── Linking (URL routing on web + custom-scheme deep links on native) ──────
//
// Without this, every screen on web served at `https://joincompasschw.com/`
// — no bookmarks, no sharable URLs, browser back/forward unpredictable.
//
// The shape mirrors the navigator tree above. React Navigation switches the
// root screen on auth state, so unauthenticated users hitting `/chw/sessions`
// fall through to Landing, and authenticated CHWs hitting `/` fall through
// to their dashboard. That's the desired UX — URLs name screens, auth gates
// access.

function buildLinkingConfig(): LinkingOptions<RootStackParamList> {
  return {
    prefixes: [
      Linking.createURL('/'),                  // expo-go / native (compasschw://)
      'https://joincompasschw.com',            // production web
      'https://www.joincompasschw.com',
    ],
    config: {
      screens: {
        // ── Unauthenticated stack ───────────────────────────────────────────
        Auth: {
          screens: {
            Landing: '',
            Login: 'login',
            Register: 'register',
            Waitlist: 'waitlist',
            // Email magic-link callback — `?token=xyz` populates route params.
            MagicLink: 'auth/magic',
            // `/legal/privacy`, `/legal/terms`, `/legal/hipaa`, `/legal/contact`
            Legal: 'legal/:page',
          },
        },
        // ── CHW (authenticated, role=chw) ──────────────────────────────────
        CHW: {
          path: 'chw',
          screens: {
            DashboardStack: {
              screens: {
                Dashboard: '',                  // /chw
                Intake: 'intake',               // /chw/intake
                Reviews: 'reviews',             // /chw/reviews
              },
            },
            Requests: 'requests',               // /chw/requests
            SessionsStack: {
              path: 'sessions',
              screens: {
                Sessions: '',                   // /chw/sessions
                SessionReview: 'review/:sessionId', // /chw/sessions/review/abc123
              },
            },
            Calendar: 'calendar',               // /chw/calendar
            EarningsStack: {
              path: 'earnings',
              screens: {
                Earnings: '',                   // /chw/earnings
                Payments: 'payments',           // /chw/earnings/payments
              },
            },
            Profile: 'profile',                 // /chw/profile
          },
        },
        // ── Admin (authenticated, role=admin) ──────────────────────────────
        Admin: 'admin',
        // ── Member (authenticated, role=member) ────────────────────────────
        Member: {
          path: 'member',
          screens: {
            Home: {
              screens: {
                HomeMain: '',                   // /member
                Rewards: 'rewards',             // /member/rewards
              },
            },
            FindCHW: 'find',                    // /member/find
            Sessions: 'sessions',               // /member/sessions
            Calendar: 'calendar',               // /member/calendar
            Roadmap: 'roadmap',                 // /member/roadmap
            Profile: 'profile',                 // /member/profile
          },
        },
      },
    },
  };
}

// ─── Loading splash ───────────────────────────────────────────────────────────

function LoadingScreen(): React.JSX.Element {
  return (
    <View style={styles.loadingContainer}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

// ─── Root navigator ───────────────────────────────────────────────────────────

export function AppNavigator(): React.JSX.Element {
  const { isLoading, isAuthenticated, userRole, hasJustSignedOut } = useAuth();
  const navigationRef = useRef<NavigationContainerRef<RootStackParamList>>(null);

  // Register this device for push notifications once authenticated.
  // Re-runs if isAuthenticated flips back and forth (e.g., logout → login).
  useRegisterPushNotifications(isAuthenticated);

  // Handle magic-link tokens from deep links (email → compasschw://auth/magic?token=...)
  // by navigating to MagicLinkScreen with the token, which runs the verify mutation.
  const handleMagicLink = useCallback(
    (token: string) => {
      const nav = navigationRef.current;
      if (!nav) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (nav as any).navigate('Auth', { screen: 'MagicLink', params: { token } });
    },
    [],
  );

  // Install deep-link + push-tap handlers. The hook guards against duplicate URL
  // handling and no-ops on the web / in simulators.
  useDeepLinks(navigationRef, handleMagicLink);

  // Built once per session — prefixes/screens are static.
  const linking = useMemo(buildLinkingConfig, []);

  if (isLoading) {
    return <LoadingScreen />;
  }

  // Web-only preview hatch — demos the intake UX without auth/backend.
  if (isPreviewRequested('intake')) {
    return (
      <NavigationContainer>
        <PreviewStack.Navigator screenOptions={{ headerShown: false }}>
          <PreviewStack.Screen name="Preview" component={PreviewIntakeRoute} />
        </PreviewStack.Navigator>
      </NavigationContainer>
    );
  }

  return (
    <NavigationContainer ref={navigationRef} linking={linking}>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {!isAuthenticated ? (
          <RootStack.Screen name="Auth">
            {() => <AuthNavigator initialRoute={hasJustSignedOut ? 'Login' : 'Landing'} />}
          </RootStack.Screen>
        ) : userRole === 'chw' ? (
          <RootStack.Screen name="CHW" component={CHWNavigator} />
        ) : userRole === 'admin' ? (
          <RootStack.Screen name="Admin" component={AdminNavigator} />
        ) : (
          <RootStack.Screen name="Member" component={MemberNavigator} />
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});
