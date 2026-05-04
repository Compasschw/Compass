import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useFonts,
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
} from '@expo-google-fonts/dm-sans';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { Platform } from 'react-native';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

/**
 * On web, react-native-safe-area-context exports `initialWindowMetrics` as a
 * hardcoded `null` (see react-native-safe-area-context/src/InitialWindow.ts).
 * Passing that to SafeAreaProvider is equivalent to passing nothing — the
 * provider waits for async measurement, and any descendant calling
 * useSafeAreaInsets() before measurement settles throws
 *   "No safe area value available"
 * which is exactly what blanked /member/find on production.
 *
 * Fix: on web, supply an explicit zero-insets Metrics object so the
 * provider has a non-null initial value to hand out. On native, pass
 * the (non-null) initialWindowMetrics from the OS.
 */
const SAFE_AREA_INITIAL_METRICS =
  Platform.OS === 'web'
    ? {
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
        frame: {
          x: 0,
          y: 0,
          width: typeof window !== 'undefined' ? window.innerWidth : 0,
          height: typeof window !== 'undefined' ? window.innerHeight : 0,
        },
      }
    : initialWindowMetrics;
import { AuthProvider } from './src/context/AuthContext';
import { AppNavigator } from './src/navigation/AppNavigator';
import { ErrorBoundary } from './src/components/shared/ErrorBoundary';
import { crash } from './src/services/crash';
import { colors } from './src/theme/colors';

// Install crash reporting before anything renders. No-op when
// EXPO_PUBLIC_SENTRY_DSN is unset, so this is safe to leave in place.
crash.init();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

export default function App(): React.JSX.Element {
  const [fontsLoaded] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    DMSans_700Bold,
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
  });

  if (!fontsLoaded) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <ErrorBoundary>
      {/*
        SafeAreaProvider is REQUIRED by every screen that uses SafeAreaView
        from react-native-safe-area-context. On native iOS/Android the OS
        supplies insets directly, but the web build of the library throws
        "No safe area value available" if no provider is mounted higher in
        the tree.

        `initialMetrics={initialWindowMetrics}` seeds the provider with
        non-null insets immediately so `useSafeAreaInsets()` doesn't throw
        on the first render before web's async measurement settles. On
        native this falls back to the OS values; on web it provides
        (0,0,0,0) defaults until JS measurement completes — never null,
        which is the trigger for the throw. Without this, MemberFindScreen
        blanked even with the provider mounted.
      */}
      <SafeAreaProvider initialMetrics={SAFE_AREA_INITIAL_METRICS}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <AppNavigator />
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
