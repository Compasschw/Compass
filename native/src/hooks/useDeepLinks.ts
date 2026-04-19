/**
 * Deep link handling for CompassCHW.
 *
 * Supported URL schemes:
 *   compasschw://sessions/<session-id>        → route to CHW/MemberSessionsScreen
 *   compasschw://conversations/<conv-id>      → route to chat (inside the session)
 *   compasschw://requests                     → route to CHWRequestsScreen
 *   compasschw://auth/magic?token=<token>     → route to magic-link verification
 *
 * Two sources of deep links:
 *   1. Tapping a push notification (Expo Notifications)
 *   2. Following a universal link / custom scheme from outside the app
 *      (email magic links, shared CHW profile URLs, etc.)
 */

import { useEffect, useRef } from 'react';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import type { NavigationContainerRef } from '@react-navigation/native';

type RouteName = 'CHWTabs' | 'MemberTabs' | 'Waitlist' | 'Landing';

interface DeepLinkPayload {
  resource: 'sessions' | 'conversations' | 'requests' | 'auth';
  id?: string;
  token?: string;
}

function parseUrl(url: string): DeepLinkPayload | null {
  try {
    const { hostname, path, queryParams } = Linking.parse(url);
    // Expo's Linking.parse handles both custom-scheme and universal-link formats.
    // For `compasschw://sessions/abc`, hostname='sessions', path='abc'.
    // For `compasschw://auth/magic?token=xyz`, hostname='auth', path='magic', queryParams={token}.
    if (!hostname) return null;
    const resource = hostname as DeepLinkPayload['resource'];

    if (resource === 'auth') {
      const token = typeof queryParams?.token === 'string' ? queryParams.token : undefined;
      return token ? { resource: 'auth', token } : null;
    }

    const id = path?.split('/')[0] || undefined;
    return { resource, id };
  } catch {
    return null;
  }
}

/**
 * Install global deep-link listeners.
 *
 * @param navigationRef  the NavigationContainer ref so we can dispatch routes
 * @param onMagicLink    callback to handle auth magic links specifically —
 *                       the caller decides how to exchange the token for JWTs
 */
export function useDeepLinks(
  navigationRef: React.RefObject<NavigationContainerRef<Record<string, object | undefined>> | null>,
  onMagicLink: (token: string) => void,
): void {
  const lastHandledUrl = useRef<string | null>(null);

  useEffect(() => {
    function handleUrl(url: string): void {
      if (lastHandledUrl.current === url) return;
      lastHandledUrl.current = url;

      const payload = parseUrl(url);
      if (!payload) return;

      if (payload.resource === 'auth' && payload.token) {
        onMagicLink(payload.token);
        return;
      }

      const nav = navigationRef.current;
      if (!nav) return;

      // Route the user to the right screen. For authenticated flows we assume
      // the normal navigator is active — if not, we no-op (they'll land on the
      // right tab via the normal login flow).
      //
      // Types are loose here: the parent navigator's ParamList isn't inferable
      // at this module level (it depends on whether user is CHW or Member).
      // Use `dispatch` with a typed action object instead of the `navigate` overloads.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const navigateTo = (name: string, params?: object) => (nav as any).navigate(name, params);

      switch (payload.resource) {
        case 'sessions':
          navigateTo('CHWTabs', { screen: 'Sessions', params: { sessionId: payload.id } });
          break;
        case 'conversations':
          navigateTo('CHWTabs', { screen: 'Sessions', params: { openChatFor: payload.id } });
          break;
        case 'requests':
          navigateTo('CHWTabs', { screen: 'Requests' });
          break;
      }
    }

    // Cold-start: app opened from a deep link
    Linking.getInitialURL().then((initialUrl) => {
      if (initialUrl) handleUrl(initialUrl);
    });

    // Warm events: link tapped while app is running
    const linkingSubscription = Linking.addEventListener('url', (event) => {
      handleUrl(event.url);
    });

    // Push-notification tap → extract deeplink from data payload
    const notificationSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      if (typeof data?.deeplink === 'string') {
        handleUrl(data.deeplink);
      }
    });

    return () => {
      linkingSubscription.remove();
      notificationSubscription.remove();
    };
  }, [navigationRef, onMagicLink]);
}
