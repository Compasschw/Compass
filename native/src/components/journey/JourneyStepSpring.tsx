/**
 * JourneyStepSpring — animated journey step indicator with completion celebration.
 *
 * Renders a single step in a linear journey track. The step has three visual
 * states: upcoming (gray), current (emerald + pulsing ring), and completed
 * (emerald + check icon).
 *
 * When `completed` transitions from false → true the following choreography plays:
 *   1. Circle pops with an overshoot spring (scale 0 → 1.18 → 0.94 → 1.06 → 1, ~430ms).
 *   2. Check icon fades in halfway through the spring (~215ms delay).
 *   3. A floating "+{points} pts" marigold chip rises ~34px and fades over ~920ms.
 *   4. `onSpringComplete` fires after all animations finish.
 *
 * Use `Animated.sequence` / `Animated.parallel` for choreography.
 * All values use `useNativeDriver: true` where supported.
 *
 * Place inside a `<View style={{ flexDirection: 'row' }}>` alongside sibling
 * steps and connecting lines.
 */

import React, { useEffect, useRef, useCallback } from 'react';
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { Check } from 'lucide-react-native';

import { colors, spacing, radius } from '../../theme/tokens';
import { POINTS_ENABLED } from '../../constants/featureFlags';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface JourneyStepSpringProps {
  /** Whether this step is completed. Animates when flipped from false → true. */
  completed: boolean;
  /** Whether this step is the current in-progress step. */
  current: boolean;
  /** Step name shown below the circle. */
  name: string;
  /** Points awarded when this step completes. */
  points: number;
  /** Called after all completion animations finish. */
  onSpringComplete?: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Circle diameter in points. */
const CIRCLE_SIZE = 32;

/** Distance the "+pts" chip travels upward. */
const CHIP_TRAVEL = -34;

/** Marigold brand colour used for the points chip. */
const MARIGOLD_BG   = '#F2B33D';
const MARIGOLD_TEXT = '#8a5a14';

// ─── Sub-component: pulsing ring for the current step ────────────────────────

function PulseRing(): React.JSX.Element {
  const pulseScale   = useRef(new Animated.Value(1)).current;
  const pulseOpacity = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(pulseScale, {
            toValue:         1.55,
            duration:        1000,
            easing:          Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseScale, {
            toValue:         1,
            duration:        0,
            useNativeDriver: true,
          }),
        ]),
        Animated.sequence([
          Animated.timing(pulseOpacity, {
            toValue:         0,
            duration:        1000,
            easing:          Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseOpacity, {
            toValue:         0.6,
            duration:        0,
            useNativeDriver: true,
          }),
        ]),
      ]),
    );

    loop.start();

    return () => {
      loop.stop();
      pulseScale.stopAnimation();
      pulseOpacity.stopAnimation();
    };
  }, [pulseScale, pulseOpacity]);

  return (
    <Animated.View
      style={[
        styles.pulseRing,
        {
          transform:  [{ scale: pulseScale }],
          opacity:    pulseOpacity,
        },
      ]}
      pointerEvents="none"
    />
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Single step circle in a journey track with spring completion animation.
 *
 * ```tsx
 * <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
 *   <JourneyStepSpring completed={false} current={true}  name="Intake"   points={10} />
 *   <JourneyStepSpring completed={false} current={false} name="Goal Set" points={20} />
 * </View>
 * ```
 */
export function JourneyStepSpring({
  completed,
  current,
  name,
  points,
  onSpringComplete,
}: JourneyStepSpringProps): React.JSX.Element {
  // Track the previous completed value so we only animate the false→true edge.
  const prevCompleted = useRef(completed);

  // Spring scale for the circle pop.
  const circleScale = useRef(new Animated.Value(completed ? 1 : 1)).current;

  // Check icon opacity — fades in partway through the spring.
  const checkOpacity = useRef(new Animated.Value(completed ? 1 : 0)).current;

  // Points chip position and opacity.
  const chipTranslateY = useRef(new Animated.Value(0)).current;
  const chipOpacity    = useRef(new Animated.Value(0)).current;

  const runCompletionAnimation = useCallback(() => {
    // Reset chip starting position so it can replay correctly.
    chipTranslateY.setValue(0);
    chipOpacity.setValue(0);

    // ── 1. Circle spring pop ──────────────────────────────────────────────────
    // Simulates stepSpring keyframes: 0 → 1.18 → 0.94 → 1.06 → 1 (~430ms)
    const circleSpring = Animated.sequence([
      Animated.timing(circleScale, {
        toValue:         1.18,
        duration:        130,
        easing:          Easing.out(Easing.back(2.5)),
        useNativeDriver: true,
      }),
      Animated.timing(circleScale, {
        toValue:         0.94,
        duration:        80,
        easing:          Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(circleScale, {
        toValue:         1.06,
        duration:        70,
        easing:          Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(circleScale, {
        toValue:         1,
        duration:        60,
        easing:          Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    ]);

    // ── 2. Check icon fade-in (starts at ~215ms, midpoint of spring) ─────────
    const checkFadeIn = Animated.sequence([
      Animated.delay(215),
      Animated.timing(checkOpacity, {
        toValue:         1,
        duration:        180,
        easing:          Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    ]);

    // ── 3. Points chip float up and fade (~920ms total) ───────────────────────
    const chipAnimation = Animated.parallel([
      Animated.timing(chipTranslateY, {
        toValue:         CHIP_TRAVEL,
        duration:        920,
        easing:          Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.sequence([
        // Fade in quickly
        Animated.timing(chipOpacity, {
          toValue:         1,
          duration:        160,
          easing:          Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        // Hold briefly
        Animated.delay(480),
        // Fade out
        Animated.timing(chipOpacity, {
          toValue:         0,
          duration:        280,
          easing:          Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    ]);

    // Run circle spring + check fade in parallel; chip floats simultaneously.
    const fullAnimation = Animated.parallel([
      circleSpring,
      checkFadeIn,
      chipAnimation,
    ]);

    fullAnimation.start(({ finished }) => {
      if (finished) {
        onSpringComplete?.();
      }
    });

    return fullAnimation;
  }, [circleScale, checkOpacity, chipTranslateY, chipOpacity, onSpringComplete]);

  useEffect(() => {
    // Only run the animation on the false → true transition.
    if (!prevCompleted.current && completed) {
      const animation = runCompletionAnimation();
      prevCompleted.current = completed;

      return () => {
        animation.stop();
      };
    }

    prevCompleted.current = completed;
    return undefined;
  }, [completed, runCompletionAnimation]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      circleScale.stopAnimation();
      checkOpacity.stopAnimation();
      chipTranslateY.stopAnimation();
      chipOpacity.stopAnimation();
    };
  }, [circleScale, checkOpacity, chipTranslateY, chipOpacity]);

  // ── Derived visual state ────────────────────────────────────────────────────

  const circleBg = completed || current ? colors.primary : colors.gray100;

  const circleStyle: ViewStyle[] = [
    styles.circle,
    { backgroundColor: circleBg },
    completed && styles.circleCompleted,
    current   && !completed && styles.circleCurrent,
  ].filter(Boolean) as ViewStyle[];

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={styles.stepWrapper}>
      {/* Circle + pulse ring container */}
      <View style={styles.circleContainer}>
        {/* Pulsing ring behind the circle for the current step */}
        {current && !completed && <PulseRing />}

        {/* Animated circle */}
        <Animated.View style={[circleStyle, { transform: [{ scale: circleScale }] }]}>
          {completed ? (
            <Animated.View style={{ opacity: checkOpacity }}>
              <Check size={14} color="#ffffff" strokeWidth={2.5} />
            </Animated.View>
          ) : (
            <Text style={[styles.stepNumber, current && styles.stepNumberCurrent]}>
              {/* Render a dot for current, number for upcoming */}
              {current ? '·' : ''}
            </Text>
          )}
        </Animated.View>

        {/* Floating "+{points} pts" chip (gated by POINTS_ENABLED) */}
        {POINTS_ENABLED && (
          <Animated.View
            style={[
              styles.ptsChip,
              {
                opacity:   chipOpacity,
                transform: [{ translateY: chipTranslateY }],
              },
            ]}
            pointerEvents="none"
          >
            <Text style={styles.ptsChipText}>+{points} pts</Text>
          </Animated.View>
        )}
      </View>

      {/* Step name */}
      <Text style={[styles.stepName, completed && styles.stepNameCompleted]} numberOfLines={2}>
        {name}
      </Text>

      {/* Points label (gated by POINTS_ENABLED) */}
      {POINTS_ENABLED && <Text style={styles.pointsLabel}>+{points} pts</Text>}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  stepWrapper: {
    alignItems: 'center',
    flex:       1,
  } as ViewStyle,

  circleContainer: {
    width:           CIRCLE_SIZE + 16, // extra space for pulse ring overflow
    height:          CIRCLE_SIZE + 16,
    alignItems:      'center',
    justifyContent:  'center',
    position:        'relative',
  } as ViewStyle,

  circle: {
    width:           CIRCLE_SIZE,
    height:          CIRCLE_SIZE,
    borderRadius:    CIRCLE_SIZE / 2,
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          2,
  } as ViewStyle,

  circleCompleted: {
    backgroundColor: colors.primary,
  } as ViewStyle,

  circleCurrent: {
    backgroundColor: colors.primary,
    ...Platform.select({
      ios: {
        shadowColor:   colors.primary,
        shadowOffset:  { width: 0, height: 0 },
        shadowOpacity: 0.4,
        shadowRadius:  6,
      },
      android: {
        elevation: 4,
      },
      web: {
        // boxShadow cast as any — StyleSheet doesn't type web-only props
        boxShadow: `0 0 0 4px rgba(22, 163, 74, 0.2)`,
      } as unknown as ViewStyle,
      default: {},
    }),
  } as ViewStyle,

  pulseRing: {
    position:        'absolute',
    width:           CIRCLE_SIZE,
    height:          CIRCLE_SIZE,
    borderRadius:    CIRCLE_SIZE / 2,
    borderWidth:     2,
    borderColor:     colors.primary,
    zIndex:          1,
  } as ViewStyle,

  stepNumber: {
    fontSize:   12,
    fontWeight: '700',
    color:      colors.textMuted,
  } as TextStyle,

  stepNumberCurrent: {
    color: '#ffffff',
  } as TextStyle,

  ptsChip: {
    position:        'absolute',
    top:             0,
    alignSelf:       'center',
    backgroundColor: MARIGOLD_BG,
    borderRadius:    radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical:   3,
    zIndex:          10,
    // Ensure it doesn't capture touches.
  } as ViewStyle,

  ptsChipText: {
    fontSize:   11,
    fontWeight: '700',
    color:      MARIGOLD_TEXT,
    whiteSpace: 'nowrap',
  } as unknown as TextStyle,

  stepName: {
    fontSize:    11,
    fontWeight:  '600',
    color:       colors.textMuted,
    textAlign:   'center',
    marginTop:   spacing.sm,
    lineHeight:  15,
    maxWidth:    72,
  } as TextStyle,

  stepNameCompleted: {
    color: colors.primary,
  } as TextStyle,

  pointsLabel: {
    fontSize:   10,
    fontWeight: '400',
    color:      colors.textMuted,
    marginTop:  3,
    // Tabular numerals for alignment in a step row.
    ...Platform.select({
      web: { fontVariantNumeric: 'tabular-nums' } as unknown as TextStyle,
      default: {},
    }),
  } as unknown as TextStyle,
});
