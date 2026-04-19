/**
 * Register for push notifications on login and persist the Expo push token
 * with the backend so it can fan notifications out.
 *
 * Usage: call `useRegisterPushNotifications()` once after the user is
 * authenticated. It requests permission, obtains an Expo push token, and
 * POSTs it to /api/v1/devices/register. Called again on token refresh.
 *
 * Safe to call on web — it's a no-op there because Expo Push tokens are
 * mobile-only. The hook guards against running outside iOS/Android.
 */

import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

import { api } from '../api/client';

// Configure how foreground notifications are displayed. The default is silent,
// which is bad UX — users should see the banner + hear the sound even when
// the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function registerForPushNotificationsAsync(): Promise<string | null> {
  // Web has no native push notifications in Expo Go / EAS builds.
  if (Platform.OS === 'web') return null;

  // Must be a real device — simulators/emulators don't receive push.
  if (!Constants.isDevice) return null;

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    // User denied — this is fine. They can re-enable in settings.
    return null;
  }

  // Android requires a notification channel to show non-silent notifications.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#3D5A3E',
    });
  }

  try {
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
    const tokenResponse = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    return tokenResponse.data;
  } catch {
    return null;
  }
}

/** Register this device's push token with the backend after login. */
export async function registerDeviceForPush(): Promise<void> {
  const token = await registerForPushNotificationsAsync();
  if (!token) return;

  try {
    await api('/devices/register', {
      method: 'POST',
      body: JSON.stringify({
        token,
        platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
        provider: 'expo',
      }),
    });
  } catch {
    // Backend unreachable — retry on next login. Non-fatal.
  }
}

/** Hook that registers once on mount (post-auth) and cleans up on unmount. */
export function useRegisterPushNotifications(isAuthenticated: boolean): void {
  useEffect(() => {
    if (!isAuthenticated) return;
    void registerDeviceForPush();
  }, [isAuthenticated]);
}
