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
 * "Complete" (#19/#20, 2026-07-13): navigates to the CHW Messages screen for
 * the active member with `promptComplete: true`, which CHWMessagesScreen
 * reads on mount to immediately call POST /sessions/{id}/end and open
 * DocumentationModal directly as an overlay — NO intermediate confirm panel.
 * (Before this change, `promptComplete` opened MemberContextRail's inline
 * Complete-Session confirm panel instead; that panel — and the rail's
 * separate manual "Complete Session" button — have been removed. This badge
 * is now the CHW's only active-session control surface: it already offers
 * Cancel/Missed right here, so a second confirm step after Complete was
 * redundant.) See CHWMessagesScreen's `shouldPromptComplete` wiring.
 *
 * "Cancel Session" / "Missed Session" (Epic P + O2): unlike Complete
 * Session, these two act directly from the badge — no navigation needed —
 * via `useAbortSession` / `useMarkSessionNoShow`. Both are destructive
 * (they end the session without documentation/billing), so both are gated
 * behind an in-app confirm Modal (`SessionActionConfirmModal` below) —
 * NEVER `window.confirm`/`Alert.alert` — mirroring the on-brand pattern
 * CHWCalendarScreen's `RemoveSessionConfirmModal` and MemberProfileScreen's
 * `RefuseServicesConfirmModal` already use. On success (query invalidation
 * flips the conversation's `activeSessionId` to null), `useActiveChwSession`
 * returns null and this whole badge unmounts — same "clears itself" effect
 * Complete Session's navigation produces on the Messages screen.
 *
 * Draggable (full 2D — #19): the badge's default bottom-right position can
 * sit directly over other on-screen controls (e.g. the Messages rail), so
 * the CHW can drag it anywhere on screen by its grip handle to uncover
 * whatever it's covering. Drag is implemented with `PanResponder` +
 * `Animated.ValueXY`, which works uniformly for mouse-drag on web and touch
 * on native (same approach as `SwipeableThreadRow`) — no gesture-handler/
 * Reanimated dependency needed. The resulting {x, y} offset is clamped every
 * frame on both axes so the badge can never be dragged off-screen, and is
 * re-clamped on window resize. On web the last offset is persisted to
 * `localStorage` (as `{x, y}` JSON) so it survives reloads/navigation;
 * native has no durable per-CHW local store wired here, so it resets to the
 * default position each mount (acceptable — the badge is reachable again
 * immediately).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  View,
  Text,
  Pressable,
  PanResponder,
  Platform,
  StyleSheet,
  Modal,
  ActivityIndicator,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type PanResponderGestureState,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Clock, LogOut, GripHorizontal, XCircle, UserX } from 'lucide-react-native';

import { useActiveChwSession } from '../../hooks/useActiveChwSession';
import { useAbortSession, useMarkSessionNoShow } from '../../hooks/useApiQueries';
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

/**
 * Default distance from the bottom edge, matched to the pre-existing static
 * `bottom` value (native clears the bottom tab bar; web sits closer down).
 * Also the anchor the drag offset is measured relative to — see
 * `clampDragOffset`.
 */
const DEFAULT_BOTTOM_OFFSET = Platform.OS === 'web' ? 24 : 76;

/** Minimum gap (px) kept between the dragged badge and either screen edge. */
const DRAG_EDGE_MARGIN = 8;

/**
 * Default distance from the right edge — the anchor the horizontal drag
 * offset is measured relative to, mirroring `DEFAULT_BOTTOM_OFFSET` for the
 * vertical axis. Matches the pre-existing static `right` style value.
 */
const DEFAULT_RIGHT_OFFSET = 16;

/**
 * Fallback badge height (px) used to clamp drag before the real height is
 * known from `onLayout` (first paint). Roughly matches the two-line info
 * block + complete button + grip handle at default padding.
 */
const ESTIMATED_BADGE_HEIGHT = 140;

/**
 * Fallback badge width (px) used to clamp horizontal drag before the real
 * width is known from `onLayout` (first paint). Matches the container's
 * `maxWidth` — the badge's actual rendered width is usually smaller (content
 * is short), so this is a conservative (safe, not over-permissive) estimate.
 */
const ESTIMATED_BADGE_WIDTH = 340;

/** Drag must move at least this many px (either axis) before we claim the
 *  gesture (keeps an accidental micro-jitter from feeling like a stuck drag). */
const DRAG_CLAIM_THRESHOLD = 2;

/** `localStorage` key the badge's last dragged {x, y} offset is persisted
 *  under (web only — see module docstring). Renamed from the vertical-only
 *  `dragOffsetY` key now that drag is full 2D (#19); the old key is simply
 *  abandoned (unread) rather than migrated — losing a previously-dragged
 *  position on upgrade is a cosmetic, one-time reset back to default. */
const LS_KEY_BADGE_OFFSET = 'compass:activeSessionBadge:dragOffset';

/** Persisted drag offset, both axes. */
interface DragOffset {
  x: number;
  y: number;
}

const ZERO_OFFSET: DragOffset = { x: 0, y: 0 };

// ─── Persisted offset (web only) ───────────────────────────────────────────────

/**
 * Reads the CHW's last-dragged {x, y} offset from `localStorage`.
 * Returns `{x: 0, y: 0}` (default position) in SSR/native context or when
 * the stored value is absent, malformed, or non-numeric.
 */
function readStoredOffset(): DragOffset {
  if (typeof window === 'undefined') return ZERO_OFFSET;
  try {
    const stored = window.localStorage.getItem(LS_KEY_BADGE_OFFSET);
    if (stored === null) return ZERO_OFFSET;
    const parsed: unknown = JSON.parse(stored);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      Number.isFinite((parsed as { x?: unknown }).x) &&
      Number.isFinite((parsed as { y?: unknown }).y)
    ) {
      return { x: (parsed as DragOffset).x, y: (parsed as DragOffset).y };
    }
    return ZERO_OFFSET;
  } catch {
    return ZERO_OFFSET;
  }
}

/**
 * Persists the CHW's dragged {x, y} offset to `localStorage`.
 * Silently swallows errors (e.g. private-browsing quota exceptions).
 */
function writeStoredOffset(value: DragOffset): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_KEY_BADGE_OFFSET, JSON.stringify(value));
  } catch {
    // Storage unavailable — ignore.
  }
}

/**
 * Clamps a candidate vertical drag offset so the badge's top and bottom
 * edges both stay within the viewport (with `DRAG_EDGE_MARGIN` of breathing
 * room).
 *
 * The badge is positioned with `bottom: DEFAULT_BOTTOM_OFFSET` and dragging
 * translates it vertically on top of that anchor — positive `offsetY` moves
 * it DOWN (toward the bottom edge, shrinking its effective bottom margin)
 * and negative moves it UP (toward the top edge). Given that:
 *   - effective bottom margin = DEFAULT_BOTTOM_OFFSET - offsetY, must stay
 *     >= DRAG_EDGE_MARGIN, so offsetY <= DEFAULT_BOTTOM_OFFSET - DRAG_EDGE_MARGIN.
 *   - effective top position = windowHeight - badgeHeight - effective bottom
 *     margin, must stay >= DRAG_EDGE_MARGIN, so
 *     offsetY >= DEFAULT_BOTTOM_OFFSET - (windowHeight - badgeHeight - DRAG_EDGE_MARGIN).
 */
function clampDragOffsetY(
  offsetY: number,
  windowHeight: number,
  badgeHeight: number,
): number {
  const maxOffsetY = DEFAULT_BOTTOM_OFFSET - DRAG_EDGE_MARGIN;
  const minOffsetY =
    DEFAULT_BOTTOM_OFFSET - (windowHeight - badgeHeight - DRAG_EDGE_MARGIN);
  // On a very short viewport (or before a real badgeHeight is known) the
  // bounds can invert — normalize so Math.max/min below never throws the
  // range away entirely.
  const lo = Math.min(minOffsetY, maxOffsetY);
  const hi = Math.max(minOffsetY, maxOffsetY);
  return Math.max(lo, Math.min(hi, offsetY));
}

/**
 * Clamps a candidate horizontal drag offset so the badge's left and right
 * edges both stay within the viewport (with `DRAG_EDGE_MARGIN` of breathing
 * room). Mirrors `clampDragOffsetY`'s derivation exactly, just on the
 * horizontal axis: the badge is positioned with `right: DEFAULT_RIGHT_OFFSET`
 * and dragging translates it horizontally on top of that anchor — positive
 * `offsetX` moves it RIGHT (shrinking its effective right margin) and
 * negative moves it LEFT (toward the left edge).
 */
function clampDragOffsetX(
  offsetX: number,
  windowWidth: number,
  badgeWidth: number,
): number {
  const maxOffsetX = DEFAULT_RIGHT_OFFSET - DRAG_EDGE_MARGIN;
  const minOffsetX =
    DEFAULT_RIGHT_OFFSET - (windowWidth - badgeWidth - DRAG_EDGE_MARGIN);
  const lo = Math.min(minOffsetX, maxOffsetX);
  const hi = Math.max(minOffsetX, maxOffsetX);
  return Math.max(lo, Math.min(hi, offsetX));
}

/** Clamps a full {x, y} candidate offset against both axes at once. */
function clampDragOffset(
  offset: DragOffset,
  windowWidth: number,
  windowHeight: number,
  badgeWidth: number,
  badgeHeight: number,
): DragOffset {
  return {
    x: clampDragOffsetX(offset.x, windowWidth, badgeWidth),
    y: clampDragOffsetY(offset.y, windowHeight, badgeHeight),
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ActiveSessionBadge(): React.JSX.Element | null {
  const activeSession = useActiveChwSession();
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  // `useWindowDimensions()` is the reactive (resize-aware) source of truth,
  // but react-native-web's underlying Dimensions module can report a
  // transient `{width: 0, height: 0}` before the web viewport is measured
  // (observed consistently in jsdom-based component tests, and plausible
  // during SSR/hydration on real web deploys too). A zero dimension would
  // collapse `clampDragOffset`'s safe range to a single point and yank the
  // badge to that point the instant the mount-reconciliation effect below
  // runs — so fall back to a direct `window.innerWidth`/`innerHeight` read
  // (always populated, just not resize-reactive) whenever the hook hasn't
  // caught up yet. Native RN always reports real dimensions from the first
  // render, so this fallback is a no-op there.
  const rawWindowDimensions = useWindowDimensions();
  const windowWidth =
    rawWindowDimensions.width > 0
      ? rawWindowDimensions.width
      : typeof window !== 'undefined' && typeof window.innerWidth === 'number'
        ? window.innerWidth
        : rawWindowDimensions.width;
  const windowHeight =
    rawWindowDimensions.height > 0
      ? rawWindowDimensions.height
      : typeof window !== 'undefined' && typeof window.innerHeight === 'number'
        ? window.innerHeight
        : rawWindowDimensions.height;

  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // ── Drag state (2D — #19) ────────────────────────────────────────────────
  // `translate` (an `Animated.ValueXY`) drives the visible position (Animated
  // so drag tracking is smooth); `offsetRef` mirrors the last *committed*
  // (post-clamp) {x, y} value so gesture callbacks — which close over stale
  // state otherwise — always compute deltas from the true current position,
  // same pattern as `SwipeableThreadRow`'s `isOpenRef`.
  const translate = useRef(new Animated.ValueXY(readStoredOffset())).current;
  const offsetRef = useRef<DragOffset>(readStoredOffset());
  const dragStartOffsetRef = useRef<DragOffset>(ZERO_OFFSET);
  const [badgeWidth, setBadgeWidth] = useState<number>(ESTIMATED_BADGE_WIDTH);
  const [badgeHeight, setBadgeHeight] = useState<number>(ESTIMATED_BADGE_HEIGHT);

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: measuredWidth, height: measuredHeight } = e.nativeEvent.layout;
    if (measuredWidth > 0) setBadgeWidth(measuredWidth);
    if (measuredHeight > 0) setBadgeHeight(measuredHeight);
  }, []);

  // Re-clamp whenever the viewport or measured size changes (e.g. browser
  // window resize, or device rotation) so a previously-valid offset can't
  // strand the badge off-screen.
  useEffect(() => {
    // Still no usable viewport size (e.g. native's very first frame,
    // pre-measurement) — nothing safe to reconcile against yet.
    if (windowWidth <= 0 || windowHeight <= 0) return;
    const clamped = clampDragOffset(offsetRef.current, windowWidth, windowHeight, badgeWidth, badgeHeight);
    if (clamped.x !== offsetRef.current.x || clamped.y !== offsetRef.current.y) {
      offsetRef.current = clamped;
      translate.setValue(clamped);
      writeStoredOffset(clamped);
    }
  }, [windowWidth, windowHeight, badgeWidth, badgeHeight, translate]);

  const panResponder = useRef(
    PanResponder.create({
      // Only the grip handle's panHandlers are attached (see JSX below), so
      // claiming here doesn't fight the member-name text or the Complete
      // Session Pressable for the gesture.
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (
        _e: GestureResponderEvent,
        g: PanResponderGestureState,
      ) => Math.abs(g.dx) > DRAG_CLAIM_THRESHOLD || Math.abs(g.dy) > DRAG_CLAIM_THRESHOLD,
      onPanResponderGrant: () => {
        dragStartOffsetRef.current = offsetRef.current;
      },
      onPanResponderMove: (_e, g: PanResponderGestureState) => {
        const next = clampDragOffset(
          { x: dragStartOffsetRef.current.x + g.dx, y: dragStartOffsetRef.current.y + g.dy },
          windowWidth,
          windowHeight,
          badgeWidth,
          badgeHeight,
        );
        translate.setValue(next);
      },
      onPanResponderRelease: (_e, g: PanResponderGestureState) => {
        const next = clampDragOffset(
          { x: dragStartOffsetRef.current.x + g.dx, y: dragStartOffsetRef.current.y + g.dy },
          windowWidth,
          windowHeight,
          badgeWidth,
          badgeHeight,
        );
        offsetRef.current = next;
        translate.setValue(next);
        writeStoredOffset(next);
      },
      onPanResponderTerminate: () => {
        // Some other component grabbed the gesture mid-drag — snap back to
        // the last committed offset rather than leaving the badge stuck at
        // an unclamped position.
        translate.setValue(offsetRef.current);
      },
    }),
  ).current;

  useEffect(() => {
    if (!activeSession) return;
    // Re-render every second while a session is live. Cleared on unmount or
    // when the underlying session changes (effect re-runs on sessionId).
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [activeSession?.sessionId]);

  // ── Cancel / Missed Session (Epic P + O2) ─────────────────────────────────
  // `confirmAction` drives the shared SessionActionConfirmModal below: null
  // means no modal is showing; 'cancel' | 'no_show' selects which
  // destructive action is pending confirmation. Neither action navigates —
  // both fire directly from the badge and, on success, the sessions-query
  // invalidation clears activeSessionId, which unmounts this whole badge
  // (see the `if (!activeSession) return null` guard below).
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'no_show' | null>(null);
  const abortSession = useAbortSession();
  const markSessionNoShow = useMarkSessionNoShow();
  const actionPending = abortSession.isPending || markSessionNoShow.isPending;

  const handleConfirmAction = useCallback(async (): Promise<void> => {
    if (!activeSession || confirmAction === null) return;
    const sessionId = activeSession.sessionId;
    const action = confirmAction;
    setConfirmAction(null);
    if (action === 'cancel') {
      await abortSession.mutateAsync(sessionId).catch(() => {
        // useAbortSession's onError already shows the on-brand alert;
        // swallow here so this handler doesn't produce an unhandled
        // rejection warning in tests/console.
      });
    } else {
      await markSessionNoShow.mutateAsync(sessionId).catch(() => {
        // useMarkSessionNoShow's onError already shows the on-brand alert.
      });
    }
  }, [activeSession, confirmAction, abortSession, markSessionNoShow]);

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
    <>
      <Animated.View
        style={[
          styles.container,
          { transform: [{ translateX: translate.x }, { translateY: translate.y }] },
        ]}
        onLayout={handleLayout}
        testID="active-session-badge"
        accessibilityLabel={`Active session with ${activeSession.memberName}`}
      >
        <View
          style={styles.dragHandle}
          testID="active-session-badge-drag-handle"
          accessibilityRole="adjustable"
          accessibilityLabel="Drag to move active session badge"
          accessibilityHint="Drag anywhere to reposition this badge so it doesn't cover other controls"
          {...panResponder.panHandlers}
        >
          <GripHorizontal size={16} color={tokens.textSecondary} />
        </View>

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

        <View style={styles.actionsRow}>
          <Pressable
            onPress={() => setConfirmAction('cancel')}
            disabled={actionPending}
            style={({ pressed }) => [
              styles.secondaryBtn,
              pressed && styles.secondaryBtnPressed,
              actionPending && styles.actionBtnDisabled,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Cancel session"
            accessibilityState={{ disabled: actionPending }}
            testID="active-session-badge-cancel-button"
          >
            <XCircle size={13} color={tokens.textSecondary} />
            <Text style={styles.secondaryBtnText}>Cancel</Text>
          </Pressable>

          <Pressable
            onPress={() => setConfirmAction('no_show')}
            disabled={actionPending}
            style={({ pressed }) => [
              styles.secondaryBtn,
              pressed && styles.secondaryBtnPressed,
              actionPending && styles.actionBtnDisabled,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Mark session missed"
            accessibilityState={{ disabled: actionPending }}
            testID="active-session-badge-missed-button"
          >
            <UserX size={13} color={tokens.textSecondary} />
            <Text style={styles.secondaryBtnText}>Missed</Text>
          </Pressable>

          <Pressable
            onPress={handleCompleteSession}
            disabled={actionPending}
            style={({ pressed }) => [
              styles.completeBtn,
              pressed && styles.completeBtnPressed,
              actionPending && styles.actionBtnDisabled,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Complete session"
            accessibilityState={{ disabled: actionPending }}
            testID="active-session-badge-complete-button"
          >
            <LogOut size={14} color="#ffffff" />
            <Text style={styles.completeBtnText}>Complete</Text>
          </Pressable>
        </View>
      </Animated.View>

      <SessionActionConfirmModal
        action={confirmAction}
        memberName={activeSession.memberName}
        isPending={actionPending}
        onConfirm={() => void handleConfirmAction()}
        onCancel={() => setConfirmAction(null)}
      />
    </>
  );
}

// ─── Cancel / Missed confirm modal ─────────────────────────────────────────────

interface SessionActionConfirmModalProps {
  /** null = hidden. 'cancel' = Cancel Session copy; 'no_show' = Missed Session copy. */
  action: 'cancel' | 'no_show' | null;
  memberName: string;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * On-brand Yes/No confirmation for the badge's destructive Cancel/Missed
 * actions — an in-app Modal, never `window.confirm`/`Alert.alert`, mirroring
 * CHWCalendarScreen's `RemoveSessionConfirmModal` / MemberProfileScreen's
 * `RefuseServicesConfirmModal`. A single component handles both actions
 * (distinguished by `action`) rather than two near-identical modals.
 */
function SessionActionConfirmModal({
  action,
  memberName,
  isPending,
  onConfirm,
  onCancel,
}: SessionActionConfirmModalProps): React.JSX.Element {
  const copy =
    action === 'no_show'
      ? {
          title: 'Mark this session as missed?',
          body: `This records that the session with ${memberName} was started but the member did not attend. No documentation or claim will be filed. This can't be undone.`,
          confirmLabel: 'Yes, Mark Missed',
        }
      : {
          title: 'Cancel this session?',
          body: `The in-progress session with ${memberName} will be discarded — no documentation or claim will be filed. This can't be undone.`,
          confirmLabel: 'Yes, Cancel Session',
        };

  return (
    <Modal
      visible={action !== null}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      accessibilityViewIsModal
    >
      <View style={confirmModalStyles.overlay}>
        <View style={confirmModalStyles.dialog}>
          <Text style={confirmModalStyles.title}>{copy.title}</Text>
          <Text style={confirmModalStyles.body}>{copy.body}</Text>
          <View style={confirmModalStyles.actions}>
            <Pressable
              style={confirmModalStyles.cancelBtn}
              onPress={onCancel}
              disabled={isPending}
              accessibilityRole="button"
              accessibilityLabel="No, keep session"
            >
              <Text style={confirmModalStyles.cancelBtnText}>No, Keep It</Text>
            </Pressable>
            <Pressable
              style={[confirmModalStyles.confirmBtn, isPending && { opacity: 0.6 }]}
              onPress={onConfirm}
              disabled={isPending}
              accessibilityRole="button"
              accessibilityLabel={copy.confirmLabel}
            >
              {isPending ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={confirmModalStyles.confirmBtnText}>{copy.confirmLabel}</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    position:          Platform.OS === 'web' ? POSITION_FIXED : 'absolute',
    // Native has no safe-area-insets wiring elsewhere in this codebase (see
    // StickyActionBar/UpdateAvailableBanner) — a fixed bottom offset large
    // enough to clear the bottom tab bar (60px on iOS) mirrors that approach.
    bottom:            DEFAULT_BOTTOM_OFFSET,
    right:             16,
    // Widened from 300 to fit the Cancel / Missed / Complete three-button
    // row (Epic P) without wrapping or crowding tap targets.
    maxWidth:          340,
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

  /**
   * Drag handle — the only region wired to `panResponder.panHandlers`, so a
   * drag gesture can never intercept a tap meant for the member-name text or
   * the Complete Session button. `cursor: 'grab'` (web-only CSS passthrough,
   * see `POSITION_FIXED` above for why the cast is needed) signals
   * draggability to a mouse user the way native touch affordance can't.
   */
  dragHandle: {
    alignItems:     'center',
    justifyContent: 'center',
    marginTop:      -spacing.xs,
    marginBottom:   -spacing.xs,
    paddingVertical: 4,
    ...(Platform.OS === 'web' ? { cursor: 'grab' } : {}),
  } as unknown as ViewStyle,

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

  /**
   * Row hosting all three session actions (Epic P): Cancel, Missed, Complete.
   * `flexWrap: 'wrap'` is a defensive fallback for a very narrow viewport —
   * the container's own `maxWidth` normally keeps all three on one line.
   */
  actionsRow: {
    flexDirection: 'row',
    gap:           6,
    flexWrap:      'wrap',
  } as ViewStyle,

  completeBtn: {
    flex:              1,
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'center',
    gap:               4,
    paddingVertical:   9,
    paddingHorizontal: spacing.sm,
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

  /** Cancel / Missed — secondary (non-destructive-looking) buttons; the
   *  actual destructive confirmation happens in SessionActionConfirmModal,
   *  so these stay visually neutral rather than red like Complete. */
  secondaryBtn: {
    flex:              1,
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'center',
    gap:               4,
    paddingVertical:   9,
    paddingHorizontal: spacing.sm,
    backgroundColor:   tokens.cardBg,
    borderWidth:       1,
    borderColor:       tokens.cardBorder,
    borderRadius:      radius.md,
  } as ViewStyle,

  secondaryBtnPressed: {
    backgroundColor: '#f3f4f6',
  } as ViewStyle,

  secondaryBtnText: {
    fontSize:   12,
    fontWeight: '700',
    color:      tokens.textSecondary,
  } as TextStyle,

  actionBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
});

// ─── Confirm modal styles ───────────────────────────────────────────────────────

const confirmModalStyles = StyleSheet.create({
  overlay: {
    flex:            1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent:  'center',
    alignItems:      'center',
    padding:         spacing.xl,
  } as ViewStyle,
  dialog: {
    backgroundColor: '#FFFFFF',
    borderRadius:    radius.xl,
    padding:         spacing.xl,
    width:           '100%',
    maxWidth:        400,
    ...(shadows.elevated as object),
  } as ViewStyle,
  title: {
    fontSize:     17,
    fontWeight:   '700',
    color:        tokens.textPrimary,
    marginBottom: spacing.sm,
  } as TextStyle,
  body: {
    fontSize:     14,
    color:        tokens.textSecondary,
    lineHeight:   20,
    marginBottom: spacing.xl,
  } as TextStyle,
  actions: {
    flexDirection: 'row',
    gap:           spacing.sm,
  } as ViewStyle,
  cancelBtn: {
    flex:            1,
    paddingVertical: 12,
    borderRadius:    radius.md,
    borderWidth:     1,
    borderColor:     tokens.cardBorder,
    alignItems:      'center',
    justifyContent:  'center',
    minHeight:       44,
  } as ViewStyle,
  cancelBtnText: {
    fontSize:   14,
    fontWeight: '600',
    color:      tokens.textPrimary,
  } as TextStyle,
  confirmBtn: {
    flex:            1,
    paddingVertical: 12,
    borderRadius:    radius.md,
    backgroundColor: '#DC2626',
    alignItems:      'center',
    justifyContent:  'center',
    minHeight:       44,
  } as ViewStyle,
  confirmBtnText: {
    fontSize:   14,
    fontWeight: '600',
    color:      '#FFFFFF',
  } as TextStyle,
});
