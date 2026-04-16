/**
 * LoadingSkeleton — animated placeholder blocks shown while data is loading.
 *
 * Uses react-native-reanimated for a smooth, performant pulse animation.
 *
 * Variants:
 *   - rows      : list of card-shaped rows (default)
 *   - card      : single card with title + body lines
 *   - stat-grid : 2×2 grid of stat tiles
 */

import React, { useEffect } from 'react';
import { View, StyleSheet, type ViewStyle } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
  type SharedValue,
} from 'react-native-reanimated';
import { colors } from '../../theme/colors';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LoadingSkeletonProps {
  /** Layout variant. Defaults to "rows". */
  variant?: 'rows' | 'card' | 'stat-grid';
  /** Number of rows to render when variant is "rows". Defaults to 3. */
  rows?: number;
}

// ─── Pulse hook ───────────────────────────────────────────────────────────────

function usePulseOpacity(): SharedValue<number> {
  const opacity = useSharedValue(1);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.4, { duration: 700, easing: Easing.inOut(Easing.ease) }),
        withTiming(1,   { duration: 700, easing: Easing.inOut(Easing.ease) }),
      ),
      -1, // infinite
      false,
    );
    // Cleanup handled automatically by reanimated on unmount.
  }, [opacity]);

  return opacity;
}

// ─── Shared animated wrapper ──────────────────────────────────────────────────

interface PulsingProps {
  opacity: SharedValue<number>;
  style: ViewStyle | ViewStyle[];
  children?: React.ReactNode;
}

function PulsingBlock({ opacity, style, children }: PulsingProps): React.JSX.Element {
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={[style, animatedStyle]}>
      {children}
    </Animated.View>
  );
}

// ─── Row variant ──────────────────────────────────────────────────────────────

interface RowCardProps {
  opacity: SharedValue<number>;
}

function SkeletonRowCard({ opacity }: RowCardProps): React.JSX.Element {
  return (
    <PulsingBlock opacity={opacity} style={styles.rowCard}>
      {/* Avatar + two lines */}
      <View style={styles.rowHeader}>
        <View style={[styles.block, styles.avatar]} />
        <View style={styles.rowHeaderLines}>
          <View style={[styles.block, styles.lineShort]} />
          <View style={[styles.block, styles.lineMedium]} />
        </View>
      </View>
      {/* Body lines */}
      <View style={[styles.block, styles.lineFull]} />
      <View style={[styles.block, styles.lineWide]} />
    </PulsingBlock>
  );
}

// ─── Card variant ─────────────────────────────────────────────────────────────

function SkeletonCard({ opacity }: RowCardProps): React.JSX.Element {
  return (
    <PulsingBlock opacity={opacity} style={styles.rowCard}>
      <View style={[styles.block, styles.lineTall]} />
      <View style={[styles.block, styles.lineMedium]} />
      <View style={[styles.block, styles.lineWide]} />
    </PulsingBlock>
  );
}

// ─── Stat-grid variant ────────────────────────────────────────────────────────

function SkeletonStatGrid({ opacity }: RowCardProps): React.JSX.Element {
  return (
    <View style={styles.statGrid}>
      {[0, 1, 2, 3].map((i) => (
        <PulsingBlock key={i} opacity={opacity} style={styles.statTile}>
          <View style={[styles.block, styles.statLine1]} />
          <View style={[styles.block, styles.statLine2]} />
        </PulsingBlock>
      ))}
    </View>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

/**
 * Shows animated skeleton placeholder blocks while content is loading.
 */
export function LoadingSkeleton({
  variant = 'rows',
  rows = 3,
}: LoadingSkeletonProps): React.JSX.Element {
  const opacity = usePulseOpacity();

  if (variant === 'stat-grid') {
    return <SkeletonStatGrid opacity={opacity} />;
  }

  if (variant === 'card') {
    return <SkeletonCard opacity={opacity} />;
  }

  return (
    <View style={styles.rowsContainer}>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRowCard key={i} opacity={opacity} />
      ))}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const MUTED = '#E5E7EB'; // gray-200 — neutral skeleton fill

const styles = StyleSheet.create({
  rowsContainer: {
    gap: 12,
  } as ViewStyle,
  rowCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 20,
    gap: 10,
  } as ViewStyle,
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 4,
  } as ViewStyle,
  rowHeaderLines: {
    flex: 1,
    gap: 8,
  } as ViewStyle,
  block: {
    backgroundColor: MUTED,
    borderRadius: 6,
  } as ViewStyle,
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
  } as ViewStyle,
  lineShort: {
    height: 12,
    width: '33%',
  } as ViewStyle,
  lineMedium: {
    height: 10,
    width: '50%',
  } as ViewStyle,
  lineFull: {
    height: 10,
    width: '100%',
  } as ViewStyle,
  lineWide: {
    height: 10,
    width: '80%',
  } as ViewStyle,
  lineTall: {
    height: 16,
    width: '75%',
    marginBottom: 6,
  } as ViewStyle,
  // Stat grid
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 24,
  } as ViewStyle,
  statTile: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 16,
    width: '47%',
    gap: 10,
  } as ViewStyle,
  statLine1: {
    height: 10,
    width: '66%',
  } as ViewStyle,
  statLine2: {
    height: 20,
    width: '50%',
  } as ViewStyle,
});
