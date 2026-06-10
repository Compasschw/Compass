/**
 * PressableCard — tactile press-feedback card surface.
 *
 * Wraps `Card` in a `Pressable` and animates `scale: 0.98` on press-in /
 * `scale: 1` on press-out using `Animated.spring`. The spring is driven by
 * `useNativeDriver: true` so the transform runs on the UI thread (native) or
 * is handled by the CSS `transform` property (web).
 *
 * Use instead of a bare `Card` whenever the element is tappable — lists,
 * dashboard stat cards, session rows, journey step cards, etc.
 *
 * When `onPress` is **not** supplied the component renders a static card with
 * no press indicator and no accessibility role of "button".
 */

import React, { useRef, useEffect, useCallback } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  type AccessibilityRole,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { colors, radius, shadows } from '../../theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PressableCardProps {
  /** Called when the card is pressed. If omitted, the card is non-interactive. */
  onPress?: () => void;
  /** Prevents interaction and dims the card when true. */
  disabled?: boolean;
  /** Additional styles merged onto the animated wrapper. */
  style?: StyleProp<ViewStyle>;
  /** Accessibility label read by screen readers. */
  accessibilityLabel?: string;
  /**
   * Accessibility role. Defaults to "button" when `onPress` is provided;
   * omitted otherwise so the element is not announced as interactive.
   */
  accessibilityRole?: AccessibilityRole;
  children: React.ReactNode;
}

// ─── Spring constants ─────────────────────────────────────────────────────────

/** Equivalent to a snappy spring: fast damping, feels responsive without bounce. */
const SPRING_PRESS_IN: Animated.SpringAnimationConfig = {
  toValue:          0.98,
  useNativeDriver:  true,
  stiffness:        300,
  damping:          20,
  mass:             1,
};

const SPRING_PRESS_OUT: Animated.SpringAnimationConfig = {
  toValue:          1,
  useNativeDriver:  true,
  stiffness:        300,
  damping:          20,
  mass:             1,
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Tactile card surface. Animates `scale: 0.98` on press-in, springs back on
 * press-out. If `onPress` is omitted the card is a static surface identical
 * to `Card`.
 *
 * ```tsx
 * <PressableCard onPress={() => navigate('Detail')} accessibilityLabel="Open session detail">
 *   <SessionRow session={s} />
 * </PressableCard>
 * ```
 */
export function PressableCard({
  onPress,
  disabled = false,
  style,
  accessibilityLabel,
  accessibilityRole,
  children,
}: PressableCardProps): React.JSX.Element {
  const scale = useRef(new Animated.Value(1)).current;

  // Clean up any in-flight animation on unmount.
  useEffect(() => {
    return () => {
      scale.stopAnimation();
    };
  }, [scale]);

  const handlePressIn = useCallback(() => {
    Animated.spring(scale, SPRING_PRESS_IN).start();
  }, [scale]);

  const handlePressOut = useCallback(() => {
    Animated.spring(scale, SPRING_PRESS_OUT).start();
  }, [scale]);

  const animatedStyle: ViewStyle = {
    transform: [{ scale }],
  };

  // Non-interactive: render an ordinary animated view styled as a card.
  if (!onPress) {
    return (
      <Animated.View style={[styles.card, shadows.card as ViewStyle, style, animatedStyle]}>
        {children}
      </Animated.View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
      accessibilityRole={accessibilityRole ?? 'button'}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
    >
      <Animated.View
        style={[
          styles.card,
          shadows.card as ViewStyle,
          style,
          animatedStyle,
          disabled && styles.disabled,
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.cardBg,
    borderWidth:     1,
    borderColor:     colors.cardBorder,
    borderRadius:    radius.xl,
  } as ViewStyle,

  disabled: {
    opacity: 0.5,
  } as ViewStyle,
});
