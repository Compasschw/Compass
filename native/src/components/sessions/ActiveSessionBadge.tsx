/**
 * ActiveSessionBadge — persistent bottom-right badge showing a CHW's
 * in-progress session while they navigate anywhere in the CHW dashboard.
 *
 * Mounted once, in AppShell, for `role === 'chw'` (see AppShell.tsx) — so it
 * floats above every CHW page (Member Profile, Journeys, Calendar, etc.)
 * without each screen having to know about it. Renders nothing when the CHW
 * has no in-progress session.
 *
 * Source of truth: `useActiveChwSession()`, which derives the active session
 * from the shared conversations query (backend-driven — `activeSessionId` /
 * `activeSessionStartedAt` on ConversationData). This component holds no
 * session start/stop state of its own; it only ticks a local 1s interval to
 * redraw the elapsed-time display between conversations refetches.
 *
 * "Complete Session" navigates to the CHW Messages screen for the active
 * member with `promptComplete: true`, which CHWMessagesScreen reads on mount
 * to auto-open the same inline Complete-Session confirm panel the CHW would
 * reach manually from MemberContextRail — see CHWMessagesScreen's
 * `shouldPromptComplete` wiring.
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Platform,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Clock, LogOut } from 'lucide-react-native';

import { useActiveChwSession } from '../../hooks/useActiveChwSession';
import { formatElapsedSince } from '../../utils/sessionTimer';
import { colors as tokens, spacing, radius, shadows, numerals } from '../../theme/tokens';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * React Native Web supports `position: 'fixed'` at runtime via the underlying
 * CSS mapping, but the TypeScript types only expose 'absolute' | 'relative'.
 * Cast once here so it flows through StyleSheet.create without an inline `as`.
 */
const POSITION_FIXED = 'fixed' as unknown as ViewStyle['position'];

/**
 * Above app chrome (sidebar/edge-flap = zIndex 100) and the update banner
 * (999), but below the modal/drawer layer (RightDrawer = 1000+) so a modal
 * opened from elsewhere still wins.
 */
const Z_INDEX = 998;

// ─── Component ────────────────────────────────────────────────────────────────

export function ActiveSessionBadge(): React.JSX.Element | null {
  const activeSession = useActiveChwSession();
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!activeSession) return;
    // Re-render every second while a session is live. Cleared on unmount or
    // when the underlying session changes (effect re-runs on sessionId).
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activeSession?.sessionId]);

  if (!activeSession) return null;

  const handleCompleteSession = (): void => {
    // Mirrors the existing `navigate('SessionsStack', { screen: 'Messages', ... })`
    // pattern used by CHWCalendarScreen's Begin Session / member-profile flows.
    navigation.navigate('SessionsStack', {
      screen: 'Messages',
      params: {
        memberId: activeSession.memberId,
        promptComplete: true,
      },
    });
  };

  return (
    <View
      style={styles.container}
      testID="active-session-badge"
      accessibilityLabel={`Active session with ${activeSession.memberName}`}
    >
      <View style={styles.info}>
        <Text
          style={styles.memberName}
          testID="active-session-badge-member-name"
          numberOfLines={1}
        >
          {activeSession.memberName}
        </Text>
        <View style={styles.timerRow}>
          <Clock size={13} color={tokens.emerald700} />
          <Text
            style={[styles.timerText, numerals.tabular]}
            testID="active-session-badge-timer"
            accessibilityLabel="Session elapsed time"
          >
            {formatElapsedSince(activeSession.startedAt, nowMs)}
          </Text>
        </View>
      </View>

      <Pressable
        onPress={handleCompleteSession}
        style={({ pressed }) => [
          styles.completeBtn,
          pressed && styles.completeBtnPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Complete session"
        testID="active-session-badge-complete-button"
      >
        <LogOut size={14} color="#ffffff" />
        <Text style={styles.completeBtnText}>Complete Session</Text>
      </Pressable>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    position:          Platform.OS === 'web' ? POSITION_FIXED : 'absolute',
    // Native has no safe-area-insets wiring elsewhere in this codebase (see
    // StickyActionBar/UpdateAvailableBanner) — a fixed bottom offset large
    // enough to clear the bottom tab bar (60px on iOS) mirrors that approach.
    bottom:            Platform.OS === 'web' ? 24 : 76,
    right:             16,
    maxWidth:          300,
    backgroundColor:   tokens.cardBg,
    borderRadius:      radius.lg,
    borderWidth:       1,
    borderColor:       tokens.cardBorder,
    borderTopWidth:    3,
    borderTopColor:    '#dc2626',
    paddingVertical:   spacing.md,
    paddingHorizontal: spacing.lg,
    gap:               spacing.sm,
    zIndex:            Z_INDEX,
    ...(shadows.elevated as object),
  } as ViewStyle,

  info: {
    gap: 2,
  } as ViewStyle,

  memberName: {
    fontSize:   13,
    fontWeight: '700',
    color:      tokens.textPrimary,
  } as TextStyle,

  timerRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.xs,
  } as ViewStyle,

  timerText: {
    fontSize:   12,
    fontWeight: '600',
    color:      tokens.emerald700,
  } as TextStyle,

  completeBtn: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'center',
    gap:               spacing.xs,
    paddingVertical:   9,
    paddingHorizontal: spacing.md,
    backgroundColor:   '#dc2626',
    borderRadius:      radius.md,
  } as ViewStyle,

  completeBtnPressed: {
    backgroundColor: '#b91c1c',
  } as ViewStyle,

  completeBtnText: {
    fontSize:   12,
    fontWeight: '700',
    color:      '#ffffff',
  } as TextStyle,
});
