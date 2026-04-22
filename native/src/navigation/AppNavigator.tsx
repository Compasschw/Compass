/**
 * Root navigator for CompassCHW.
 *
 * Routing logic:
 *   - While auth state is loading → blank screen (prevents flash)
 *   - Unauthenticated          → AuthStack  (Login/Register toggle, Waitlist)
 *   - CHW role                 → CHWTabNavigator
 *   - Member role              → MemberTabNavigator
 */

import React, { useCallback, useRef } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import {
  NavigationContainer,
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
import { WaitlistScreen } from '../screens/auth/WaitlistScreen';
import { CHWIntakeScreen } from '../screens/chw/CHWIntakeScreen';
import { CHWOnboardingScreen } from '../screens/onboarding/CHWOnboardingScreen';
import { MemberOnboardingScreen } from '../screens/onboarding/MemberOnboardingScreen';
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
  CHWOnboarding: undefined;
  MemberOnboarding: undefined;
};

// ─── Root stack param list ────────────────────────────────────────────────────

export type RootStackParamList = {
  Auth: undefined;
  CHW: undefined;
  Member: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const RootStack = createNativeStackNavigator<RootStackParamList>();
const PreviewStack = createNativeStackNavigator<{ Preview: undefined }>();

function PreviewIntakeRoute(): React.JSX.Element {
  return <CHWIntakeScreen previewMode />;
}

// ─── Auth stack ───────────────────────────────────────────────────────────────

function AuthNavigator(): React.JSX.Element {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      {/* Landing is the initial route — unauthenticated users see the
          marketing page first before proceeding to Login/Register. */}
      <AuthStack.Screen name="Landing" component={LandingScreen} />
      <AuthStack.Screen name="Waitlist" component={WaitlistScreen} />
      {/* MagicLink is always registered so deep links from email can route to it
          even pre-launch. The screen itself shows "Coming soon" if verification
          fails because the user isn't provisioned. */}
      <AuthStack.Screen name="MagicLink" component={MagicLinkScreen} />
      {/* Login/Register/Onboarding screens disabled until platform launch.
          Uncomment when ready to enable sign-in:
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Register" component={LoginScreen} />
      <AuthStack.Screen name="CHWOnboarding" component={CHWOnboardingScreen} />
      <AuthStack.Screen name="MemberOnboarding" component={MemberOnboardingScreen} />
      */}
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
  const { isLoading, isAuthenticated, userRole } = useAuth();
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
    <NavigationContainer ref={navigationRef}>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {!isAuthenticated ? (
          <RootStack.Screen name="Auth" component={AuthNavigator} />
        ) : userRole === 'chw' ? (
          <RootStack.Screen name="CHW" component={CHWNavigator} />
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
