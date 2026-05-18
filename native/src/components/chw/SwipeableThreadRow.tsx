/**
 * SwipeableThreadRow — wraps a thread row with iOS-Mail-style swipe actions.
 *
 * Swipe LEFT (mouse drag on desktop, touch swipe on touch) reveals three
 * action buttons stacked horizontally on the right: Pin (amber), Archive
 * (gray), Delete (red).  Tapping a revealed button fires the corresponding
 * action and snaps the row back closed.  Tapping the row itself (when
 * closed) bubbles through to the wrapped child via ``onPress``.  Tapping
 * the row body while open just snaps it shut.
 *
 * Implementation:
 *   - Uses React Native's PanResponder so the same handler works for mouse
 *     and touch on web + native.  We measure horizontal delta only; small
 *     vertical excursions (scroll intent) cancel the swipe.
 *   - The row body is an absolutely-positioned overlay translated by the
 *     drag amount; the action bar sits behind it at the right edge.
 *   - On release we snap to either ``0`` (closed) or ``-ACTION_BAR_WIDTH``
 *     (fully open) based on whether the drag passed the halfway threshold.
 *
 * Why not a third-party library?  ``react-native-gesture-handler``
 * Swipeable would give nicer physics but it pulls in Reanimated and
 * requires native module installation, which our Expo-managed web app
 * doesn't currently include.  This implementation is ~200 LOC and good
 * enough for inbox swipe.
 */

import React, { useRef, useState, useCallback } from 'react';
import {
  Animated,
  PanResponder,
  StyleSheet,
  TouchableOpacity,
  View,
  Text,
  type GestureResponderEvent,
  type PanResponderGestureState,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { Pin, Archive, Trash2, PinOff } from 'lucide-react-native';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Width of one action button. Three of these = total reveal width. */
const ACTION_BUTTON_WIDTH = 76;
const ACTION_BAR_WIDTH = ACTION_BUTTON_WIDTH * 3;

/** Drag past this fraction of ACTION_BAR_WIDTH to snap open on release. */
const SNAP_OPEN_THRESHOLD = 0.4;

/** Vertical excursion (pixels) that cancels the horizontal swipe — gives
 *  the underlying ScrollView priority when the user actually wants to scroll. */
const VERTICAL_CANCEL_THRESHOLD = 12;

/** Minimum horizontal drag (pixels) before we claim the gesture. Below this
 *  the touch is treated as a tap and bubbles to ``onPress``. */
const HORIZONTAL_CLAIM_THRESHOLD = 8;

// ─── Public API ──────────────────────────────────────────────────────────────

export interface SwipeableThreadRowProps {
  /** The row content (typically a ThreadRow). Rendered on top of the action bar. */
  children: React.ReactNode;
  /** True when the thread is currently pinned — flips Pin → Unpin label/icon. */
  isPinned: boolean;
  /** Fires when the CHW taps the row body and the row is in the closed state.
   *  When the row is open, taps just close the row instead of bubbling. */
  onPress?: () => void;
  /** Pin / unpin action. Receives the new pinned state. */
  onPin: (nextPinned: boolean) => void;
  /** Archive action. */
  onArchive: () => void;
  /** Delete action (soft delete on the backend). */
  onDelete: () => void;
}

export function SwipeableThreadRow({
  children,
  isPinned,
  onPress,
  onPin,
  onArchive,
  onDelete,
}: SwipeableThreadRowProps): React.JSX.Element {
  // Track translation as an Animated value so we can smoothly snap on release.
  const translateX = useRef(new Animated.Value(0)).current;
  // The committed open/closed state (after snap). Used to decide whether a
  // row-body tap should close or bubble through.
  const [isOpen, setIsOpen] = useState(false);
  // We need a ref-mirror of isOpen for the gesture callbacks (which capture
  // by closure and would see a stale value otherwise).
  const isOpenRef = useRef(false);
  const setOpen = useCallback((next: boolean) => {
    isOpenRef.current = next;
    setIsOpen(next);
  }, []);

  // ── Gesture handler ────────────────────────────────────────────────────────
  // PanResponder fires for both mouse and touch on web; for native it's the
  // standard touch responder. We only claim the gesture once the user has
  // moved horizontally past HORIZONTAL_CLAIM_THRESHOLD AND not too far
  // vertically (which would indicate scroll intent).
  const panResponder = useRef(
    PanResponder.create({
      // Don't capture taps — only horizontal drags.
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (
        _e: GestureResponderEvent,
        g: PanResponderGestureState,
      ) => {
        return (
          Math.abs(g.dx) > HORIZONTAL_CLAIM_THRESHOLD &&
          Math.abs(g.dy) < VERTICAL_CANCEL_THRESHOLD
        );
      },
      onPanResponderMove: (_e, g) => {
        // Drag is relative to the current snap position. If the row is open
        // (translateX === -ACTION_BAR_WIDTH), dragging RIGHT closes it.
        const base = isOpenRef.current ? -ACTION_BAR_WIDTH : 0;
        const next = base + g.dx;
        // Clamp so the row can't be dragged past fully-open or past closed.
        const clamped = Math.max(-ACTION_BAR_WIDTH, Math.min(0, next));
        translateX.setValue(clamped);
      },
      onPanResponderRelease: (_e, g) => {
        const base = isOpenRef.current ? -ACTION_BAR_WIDTH : 0;
        const endX = base + g.dx;
        // Snap based on which side of the threshold we end up on.
        const shouldOpen = endX < -ACTION_BAR_WIDTH * SNAP_OPEN_THRESHOLD;
        Animated.spring(translateX, {
          toValue: shouldOpen ? -ACTION_BAR_WIDTH : 0,
          useNativeDriver: true,
          // Tuned so the snap feels crisp without overshoot.
          tension: 120,
          friction: 14,
        }).start();
        setOpen(shouldOpen);
      },
      onPanResponderTerminate: () => {
        // Some other component grabbed the gesture (e.g. parent ScrollView).
        // Reset to last committed state so the row doesn't get stuck mid-drag.
        Animated.spring(translateX, {
          toValue: isOpenRef.current ? -ACTION_BAR_WIDTH : 0,
          useNativeDriver: true,
        }).start();
      },
    }),
  ).current;

  // ── Action handlers ────────────────────────────────────────────────────────
  // Closing the row before firing the action gives the CHW visual feedback
  // that the tap registered, even if the mutation takes a moment.
  const close = useCallback(() => {
    Animated.spring(translateX, {
      toValue: 0,
      useNativeDriver: true,
      tension: 120,
      friction: 14,
    }).start();
    setOpen(false);
  }, [translateX, setOpen]);

  const handlePin = useCallback(() => {
    close();
    onPin(!isPinned);
  }, [close, onPin, isPinned]);

  const handleArchive = useCallback(() => {
    close();
    onArchive();
  }, [close, onArchive]);

  const handleDelete = useCallback(() => {
    close();
    onDelete();
  }, [close, onDelete]);

  const handleBodyPress = useCallback(() => {
    if (isOpen) {
      close();
      return;
    }
    onPress?.();
  }, [isOpen, close, onPress]);

  return (
    <View style={s.outer}>
      {/* Action bar — rendered behind the row body so it's revealed as the
          row slides left. Positioned with right: 0 so the buttons stack
          flush against the right edge. */}
      <View style={s.actionBar} pointerEvents={isOpen ? 'auto' : 'none'}>
        <TouchableOpacity
          style={[s.actionBtn, s.pinBtn]}
          onPress={handlePin}
          accessibilityRole="button"
          accessibilityLabel={isPinned ? 'Unpin conversation' : 'Pin conversation to top'}
        >
          {isPinned ? <PinOff size={18} color="#fff" /> : <Pin size={18} color="#fff" />}
          <Text style={s.actionLabel}>{isPinned ? 'Unpin' : 'Pin'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actionBtn, s.archiveBtn]}
          onPress={handleArchive}
          accessibilityRole="button"
          accessibilityLabel="Archive conversation"
        >
          <Archive size={18} color="#fff" />
          <Text style={s.actionLabel}>Archive</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actionBtn, s.deleteBtn]}
          onPress={handleDelete}
          accessibilityRole="button"
          accessibilityLabel="Delete conversation"
        >
          <Trash2 size={18} color="#fff" />
          <Text style={s.actionLabel}>Delete</Text>
        </TouchableOpacity>
      </View>

      {/* Row body — translated by the gesture. Touchable inside catches taps
          so we can close-on-tap when open OR bubble onPress when closed. */}
      <Animated.View
        style={[s.body, { transform: [{ translateX }] }]}
        {...panResponder.panHandlers}
      >
        <TouchableOpacity
          activeOpacity={0.95}
          onPress={handleBodyPress}
          // Disable the touchable's own press feedback when the row is open —
          // the tap should only close, not also visually "select" the row.
          style={s.bodyTouchable}
        >
          {children}
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  outer: {
    position: 'relative',
    // overflow:hidden prevents the action bar from peeking out beyond the
    // row's left edge during over-drag attempts (clamping handles this too,
    // but defense-in-depth).
    overflow: 'hidden',
  } as ViewStyle,
  actionBar: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    flexDirection: 'row',
    width: ACTION_BAR_WIDTH,
  } as ViewStyle,
  actionBtn: {
    width: ACTION_BUTTON_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  } as ViewStyle,
  actionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,
  pinBtn: {
    backgroundColor: '#F59E0B', // amber-500
  } as ViewStyle,
  archiveBtn: {
    backgroundColor: '#6B7280', // gray-500
  } as ViewStyle,
  deleteBtn: {
    backgroundColor: '#DC2626', // red-600
  } as ViewStyle,
  body: {
    backgroundColor: '#fff',
  } as ViewStyle,
  bodyTouchable: {
    // No styles here — the inner ThreadRow component handles its own padding,
    // border, and selected-state styling. This touchable just provides the
    // tap target.
  } as ViewStyle,
});
