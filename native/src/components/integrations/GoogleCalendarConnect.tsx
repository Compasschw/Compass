/**
 * GoogleCalendarConnect — web-only card that connects a user's Google Calendar
 * so Compass sessions are pushed onto it.
 *
 * Rendered in both member Settings and CHW profile/Settings. Two states:
 *   - Not connected: a "Connect Google Calendar" button that runs Google's
 *     authorization-CODE flow (offline access → refresh token on the backend)
 *     and POSTs the resulting code to /integrations/google-calendar/connect.
 *   - Connected: "Connected as {google_email}" + a "Disconnect" button that
 *     POSTs /integrations/google-calendar/disconnect.
 *
 * Hidden entirely on native (`Platform.OS !== 'web'`) and when Google OAuth is
 * not configured — the auth-code popup is a web-only GIS capability. All hooks
 * run unconditionally (rules of hooks); the null return happens after them and
 * the status query is disabled in the hidden case so it never fires.
 *
 * Failures surface inline in an on-brand destructive colour — never a browser
 * dialog. A user closing the popup without granting access is a benign cancel
 * (getGoogleCalendarAuthCode resolves null) and shows no error.
 */

import React, { useCallback, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  Platform,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

// Import Card directly (not via the `../ui` barrel) so this small card doesn't
// pull the barrel's navigation-dependent members (DashboardSidebar → an
// extension-less @react-navigation/native import that jsdom can't resolve).
import { Card } from '../ui/Card';
import { colors as tokens } from '../../theme/tokens';
import { colors } from '../../theme/colors';
import {
  getGoogleCalendarAuthCode,
  isGoogleConfigured,
  OAuthError,
} from '../../services/oauth';
import {
  useGoogleCalendarStatus,
  useConnectGoogleCalendar,
  useDisconnectGoogleCalendar,
} from '../../hooks/useApiQueries';

const CONNECT_ERROR = 'Could not connect Google Calendar. Please try again.';
const DISCONNECT_ERROR = 'Could not disconnect Google Calendar. Please try again.';

/**
 * Connect / disconnect a Google Calendar. Renders nothing on native or when
 * Google OAuth is unconfigured.
 */
export function GoogleCalendarConnect(): React.JSX.Element | null {
  // Evaluated before any early return so the hooks below always run in the same
  // order regardless of platform (rules of hooks). `isGoogleConfigured()`
  // already returns false on native, but the explicit Platform check documents
  // the web-only contract and guards against config drift.
  const isWeb = Platform.OS === 'web';
  const enabled = isWeb && isGoogleConfigured();

  const status = useGoogleCalendarStatus({ enabled });
  const connect = useConnectGoogleCalendar();
  const disconnect = useDisconnectGoogleCalendar();
  const [error, setError] = useState<string | null>(null);

  const handleConnect = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const result = await getGoogleCalendarAuthCode();
      // `null` = the user closed the consent popup without granting access.
      // Benign — leave the card in its not-connected state with no error.
      if (!result) return;
      connect.mutate(
        { code: result.code, redirectUri: result.redirectUri },
        { onError: () => setError(CONNECT_ERROR) },
      );
    } catch (err) {
      // A cancelled popup that surfaced as an OAuthError is still benign.
      if (err instanceof OAuthError && err.code === 'user_cancelled') return;
      setError(err instanceof OAuthError ? err.message : CONNECT_ERROR);
    }
  }, [connect]);

  const handleDisconnect = useCallback((): void => {
    setError(null);
    disconnect.mutate(undefined, { onError: () => setError(DISCONNECT_ERROR) });
  }, [disconnect]);

  // Web-only + configured. Placed AFTER the hooks so the component never
  // conditionally calls a hook.
  if (!enabled) return null;

  const isConnected = status.data?.connected === true;
  const googleEmail = status.data?.googleEmail ?? null;
  const connecting = connect.isPending;
  const disconnecting = disconnect.isPending;
  // Single string (not split JSX children) so the whole label renders as one
  // text node — matches how the connected-state test queries it.
  const connectedLabel = googleEmail ? `Connected as ${googleEmail}` : 'Connected';

  return (
    <Card style={styles.card}>
      <Text style={styles.title}>Google Calendar</Text>
      <Text style={styles.subtitle}>Add your Compass sessions to your Google Calendar.</Text>

      {isConnected ? (
        <View style={styles.connectedRow}>
          <Text style={styles.connectedText} accessibilityLabel="Google Calendar connected">
            {connectedLabel}
          </Text>
          <Pressable
            onPress={handleDisconnect}
            disabled={disconnecting}
            accessibilityRole="button"
            accessibilityLabel="Disconnect Google Calendar"
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
              styles.outlineBtn,
              (pressed || hovered) && styles.outlineBtnHover,
              disconnecting && styles.btnDisabled,
            ]}
          >
            <Text style={styles.outlineBtnText}>
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={() => void handleConnect()}
          disabled={connecting}
          accessibilityRole="button"
          accessibilityLabel="Connect Google Calendar"
          style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
            styles.primaryBtn,
            (pressed || hovered) && styles.primaryBtnHover,
            connecting && styles.btnDisabled,
          ]}
        >
          <Text style={styles.primaryBtnText}>
            {connecting ? 'Connecting…' : 'Connect Google Calendar'}
          </Text>
        </Pressable>
      )}

      {error != null && (
        <Text style={styles.error} accessibilityLabel="Google Calendar error">
          {error}
        </Text>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 24,
    padding:   24,
  } as ViewStyle,
  title: {
    fontSize:   16,
    fontWeight: '600',
    color:      tokens.textPrimary,
  } as TextStyle,
  subtitle: {
    marginTop: 4,
    fontSize:  12,
    color:     tokens.textMuted,
  } as TextStyle,
  connectedRow: {
    marginTop:      14,
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    flexWrap:       'wrap',
    gap:            12,
  } as ViewStyle,
  connectedText: {
    flexShrink: 1,
    fontSize:   13,
    fontWeight: '500',
    color:      tokens.textSecondary,
  } as TextStyle,
  primaryBtn: {
    marginTop:         14,
    alignSelf:         'flex-start',
    paddingHorizontal: 16,
    paddingVertical:   10,
    borderRadius:      10,
    backgroundColor:   tokens.primary,
  } as ViewStyle,
  primaryBtnHover: {
    backgroundColor: tokens.primaryHover,
  } as ViewStyle,
  primaryBtnText: {
    fontSize:   13,
    fontWeight: '700',
    color:      '#FFFFFF',
  } as TextStyle,
  outlineBtn: {
    paddingHorizontal: 16,
    paddingVertical:   9,
    borderRadius:      10,
    borderWidth:       1,
    borderColor:       tokens.cardBorder,
    backgroundColor:   tokens.cardBg,
  } as ViewStyle,
  outlineBtnHover: {
    backgroundColor: tokens.gray100,
  } as ViewStyle,
  outlineBtnText: {
    fontSize:   13,
    fontWeight: '600',
    color:      tokens.textSecondary,
  } as TextStyle,
  btnDisabled: {
    opacity: 0.6,
  } as ViewStyle,
  error: {
    marginTop:  12,
    fontSize:   13,
    fontWeight: '500',
    color:      colors.destructive,
  } as TextStyle,
});
