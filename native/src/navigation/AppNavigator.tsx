/**
 * Root navigator for CompassCHW.
 *
 * Routing logic:
 *   - While auth state is loading → blank screen (prevents flash)
 *   - Unauthenticated          → AuthStack  (Login/Register toggle, Waitlist)
 *   - CHW role                 → CHWTabNavigator
 *   - Member role              → MemberTabNavigator
 */

import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { useAuth } from '../context/AuthContext';
import { colors } from '../theme/colors';
import { LandingScreen } from '../screens/LandingScreen';
import { LoginScreen } from '../screens/auth/LoginScreen';
import { WaitlistScreen } from '../screens/auth/WaitlistScreen';
import { CHWOnboardingScreen } from '../screens/onboarding/CHWOnboardingScreen';
import { MemberOnboardingScreen } from '../screens/onboarding/MemberOnboardingScreen';
import { CHWTabNavigator } from './CHWTabNavigator';
import { MemberTabNavigator } from './MemberTabNavigator';

// ─── Auth stack param list ────────────────────────────────────────────────────

export type AuthStackParamList = {
  Landing: undefined;
  Login: undefined;
  Register: undefined;
  Waitlist: undefined;
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

// ─── Auth stack ───────────────────────────────────────────────────────────────

function AuthNavigator(): React.JSX.Element {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      {/* Landing is the initial route — unauthenticated users see the
          marketing page first before proceeding to Login/Register. */}
      <AuthStack.Screen name="Landing" component={LandingScreen} />
      <AuthStack.Screen name="Waitlist" component={WaitlistScreen} />
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

  if (isLoading) {
    return <LoadingScreen />;
  }

  return (
    <NavigationContainer>
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
