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

import React, { useEffect, useRef } from 'react';
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

// ─── Auto-reload tuning ────────────────────────────────────────────────────────

/** Grace period after an update is detected before the first reload attempt. */
const AUTO_RELOAD_GRACE_MS = 1_500;

/** How often we re-attempt the reload while it isn't yet safe. */
const AUTO_RELOAD_POLL_MS = 2_000;

/**
 * Require this much user inactivity (no keypress / pointer / scroll) before
 * auto-reloading, so we only reload during a natural pause — never mid-task.
 */
const AUTO_RELOAD_IDLE_MS = 4_000;

/** sessionStorage key + window guarding against rapid reload loops. */
const AUTO_RELOAD_TS_KEY = 'compass:lastAutoReloadAt';
const AUTO_RELOAD_LOOP_GUARD_MS = 60_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns true if the user has requested reduced motion via OS / browser
 * settings. Safe to call on web only.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * True if the focused element is something the user might be typing into
 * (input / textarea / select / contentEditable). We never auto-reload while
 * one of these is focused, to avoid discarding unsaved input.
 */
function isEditableFocused(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable === true
  );
}

/** True if we auto-reloaded within the loop-guard window (avoids reload loops). */
function reloadedRecently(): boolean {
  try {
    const last = Number(window.sessionStorage?.getItem(AUTO_RELOAD_TS_KEY) ?? 0);
    return last > 0 && Date.now() - last < AUTO_RELOAD_LOOP_GUARD_MS;
  } catch {
    return false;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Renders a fixed-position update prompt when a new bundle is detected.
 * Manages the useBuildUpdateCheck hook internally — callers simply mount this
 * once and never interact with it directly.
 */
export function UpdateAvailableBanner(): React.JSX.Element | null {
  const { updateAvailable, reload } = useBuildUpdateCheck();

  /**
   * Animated translateY value. Starts at SLIDE_START_PX (off-screen below the
   * banner's resting position) and springs to 0 when an update is detected.
   */
  const translateY = useRef(new Animated.Value(SLIDE_START_PX)).current;

  // Animate the "updating…" indicator in when an update is first detected.
  useEffect(() => {
    if (!updateAvailable || Platform.OS !== 'web') return;

    if (prefersReducedMotion()) {
      // Jump to resting position instantly — no visual motion.
      translateY.setValue(0);
    } else {
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: false,
        tension: 80,
        friction: 10,
      }).start();
    }
  }, [updateAvailable, translateY]);

  // Auto-reload to the new bundle, but only during a safe moment: not while the
  // user is typing, only after a short idle pause, or immediately if the tab is
  // backgrounded. A sessionStorage guard prevents reload loops. The manual
  // "Reload now" button remains for anyone who wants it sooner.
  useEffect(() => {
    if (!updateAvailable || Platform.OS !== 'web' || typeof window === 'undefined') return;
    if (reloadedRecently()) return;

    let done = false;
    let lastActivityAt = Date.now();

    const performReload = (): void => {
      if (done) return;
      done = true;
      try {
        window.sessionStorage?.setItem(AUTO_RELOAD_TS_KEY, String(Date.now()));
      } catch {
        // sessionStorage unavailable — reload anyway.
      }
      reload();
    };

    const tryReload = (): void => {
      if (done) return;
      // Safe = not typing AND the user has paused for a beat.
      if (!isEditableFocused() && Date.now() - lastActivityAt >= AUTO_RELOAD_IDLE_MS) {
        performReload();
      }
    };

    const bumpActivity = (): void => {
      lastActivityAt = Date.now();
    };
    const activityEvents = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const;
    activityEvents.forEach((e) =>
      window.addEventListener(e, bumpActivity, { passive: true }),
    );

    // If the user backgrounds the tab (and isn't mid-edit), reload right away —
    // when they return they land on the same URL with the fresh bundle.
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden' && !isEditableFocused()) performReload();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const graceTimer = setTimeout(tryReload, AUTO_RELOAD_GRACE_MS);
    const poll = setInterval(tryReload, AUTO_RELOAD_POLL_MS);

    return () => {
      done = true;
      clearTimeout(graceTimer);
      clearInterval(poll);
      activityEvents.forEach((e) => window.removeEventListener(e, bumpActivity));
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [updateAvailable, reload]);

  // Web-only guard — renders nothing on iOS / Android.
  if (Platform.OS !== 'web') return null;

  // Nothing to show until an update is confirmed.
  if (!updateAvailable) return null;

  return (
    <Animated.View
      style={[styles.banner, { transform: [{ translateY }] }]}
      // 'alert' role announces the banner immediately to assistive technology.
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.message}>
        Updating Compass to the latest version…
      </Text>

      <Pressable
        onPress={reload}
        style={({ pressed }) => [
          styles.reloadButton,
          pressed && styles.reloadButtonPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Reload now to get the latest version"
      >
        <Text style={styles.reloadText}>Reload now</Text>
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
});
