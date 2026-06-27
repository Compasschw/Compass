/**
 * UpdateAvailableBanner — a slim fixed banner that prompts the user to reload
 * when useBuildUpdateCheck detects a newer Expo web bundle is deployed.
 *
 * Web-only: returns null on native (`Platform.OS !== 'web'`).
 *
 * UX contract:
 *   - Slides up from the bottom of the viewport when an update is detected.
 *   - "Reload" button calls window.location.reload() — no data is lost in
 *     advance; we only prompt, never auto-reload.
 *   - "×" dismiss hides the banner for the current session until the next
 *     detected change or a manual page reload.
 *   - Respects `prefers-reduced-motion`: skips the slide animation and jumps
 *     directly into view instead.
 *   - zIndex 999 — renders above page content and the sidebar, but below the
 *     app's modal / drawer layer (which uses 1000+).
 *
 * Mounting: render once at the app root (App.tsx) so the check runs
 * universally across all authenticated and unauthenticated screens.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { useBuildUpdateCheck } from '../../hooks/useBuildUpdateCheck';
import { colors } from '../../theme/colors';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * React Native Web supports `position: 'fixed'` at runtime via the underlying
 * CSS mapping, but the TypeScript types only expose 'absolute' | 'relative'.
 * Cast once here so it flows through StyleSheet.create without an inline `as`.
 */
const POSITION_FIXED = 'fixed' as unknown as ViewStyle['position'];

/**
 * Initial translateY offset in pixels. The banner starts this far below its
 * resting position (off the bottom of the viewport) and springs up to 0.
 */
const SLIDE_START_PX = 80;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns true if the user has requested reduced motion via OS / browser
 * settings. Safe to call on web only.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Renders a fixed-position update prompt when a new bundle is detected.
 * Manages the useBuildUpdateCheck hook internally — callers simply mount this
 * once and never interact with it directly.
 */
export function UpdateAvailableBanner(): React.JSX.Element | null {
  const { updateAvailable, reload } = useBuildUpdateCheck();
  const [dismissed, setDismissed] = useState<boolean>(false);

  /**
   * Animated translateY value. Starts at SLIDE_START_PX (off-screen below the
   * banner's resting position) and springs to 0 when an update is detected.
   */
  const translateY = useRef(new Animated.Value(SLIDE_START_PX)).current;

  // Animate in when an update is first detected (and not yet dismissed).
  useEffect(() => {
    if (!updateAvailable || dismissed || Platform.OS !== 'web') return;

    if (prefersReducedMotion()) {
      // Jump to resting position instantly — no visual motion.
      translateY.setValue(0);
    } else {
      Animated.spring(translateY, {
        toValue: 0,
        // useNativeDriver: false is required here because:
        //   1. We are on web — the native compositor path is not used.
        //   2. The element uses position: 'fixed', so the transform is driven
        //      by the React/JS thread through React Native Web's style system.
        useNativeDriver: false,
        tension: 80,
        friction: 10,
      }).start();
    }
  }, [updateAvailable, dismissed, translateY]);

  const handleDismiss = useCallback((): void => {
    setDismissed(true);
  }, []);

  // Web-only guard — renders nothing on iOS / Android.
  if (Platform.OS !== 'web') return null;

  // Don't mount the DOM node at all until an update is confirmed. Once
  // dismissed the user's intent is respected for the rest of the session.
  if (!updateAvailable || dismissed) return null;

  return (
    <Animated.View
      style={[styles.banner, { transform: [{ translateY }] }]}
      // 'alert' role announces the banner immediately to assistive technology.
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.message}>
        A new version of Compass is available.
      </Text>

      <Pressable
        onPress={reload}
        style={({ pressed }) => [
          styles.reloadButton,
          pressed && styles.reloadButtonPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Reload to get the latest version"
      >
        <Text style={styles.reloadText}>Reload</Text>
      </Pressable>

      <Pressable
        onPress={handleDismiss}
        style={styles.dismissButton}
        accessibilityRole="button"
        accessibilityLabel="Dismiss update notification"
        hitSlop={10}
      >
        {/* Decorative — screen readers use accessibilityLabel on the Pressable. */}
        <Text style={styles.dismissText} accessibilityElementsHidden>×</Text>
      </Pressable>
    </Animated.View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  banner: {
    // Fixed to the bottom of the viewport — independent of scroll position.
    position:         POSITION_FIXED,
    bottom:           24,
    left:             16,
    right:            16,
    // Compass primary green background; high-contrast white text passes WCAG AA.
    backgroundColor:  colors.primary,
    borderRadius:     10,
    flexDirection:    'row',
    alignItems:       'center',
    paddingVertical:  12,
    paddingHorizontal: 16,
    gap:              12,
    // 999 — above page content and sidebar (256 z), below modals (1000+).
    zIndex:           999,
    // Subtle elevation via shadow tokens that React Native Web maps to CSS.
    shadowColor:      '#000',
    shadowOffset:     { width: 0, height: 4 },
    shadowOpacity:    0.18,
    shadowRadius:     12,
  } as ViewStyle,

  message: {
    color:      colors.primaryForeground,
    fontSize:   14,
    fontWeight: '500',
    lineHeight: 20,
    flex:       1,
  } as TextStyle,

  reloadButton: {
    backgroundColor:  'rgba(255, 255, 255, 0.18)',
    borderWidth:      1,
    borderColor:      'rgba(255, 255, 255, 0.38)',
    borderRadius:     6,
    paddingVertical:  6,
    paddingHorizontal: 14,
  } as ViewStyle,

  reloadButtonPressed: {
    backgroundColor: 'rgba(255, 255, 255, 0.30)',
  } as ViewStyle,

  reloadText: {
    color:      colors.primaryForeground,
    fontSize:   13,
    fontWeight: '600',
    lineHeight: 18,
  } as TextStyle,

  dismissButton: {
    paddingHorizontal: 4,
    paddingVertical:   2,
  } as ViewStyle,

  dismissText: {
    color:      'rgba(255, 255, 255, 0.65)',
    fontSize:   20,
    lineHeight: 22,
    fontWeight: '400',
  } as TextStyle,
});
