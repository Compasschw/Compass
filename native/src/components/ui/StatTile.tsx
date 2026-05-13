/**
 * StatTile — KPI tile for dashboard metric grids.
 *
 * Renders an icon circle, a metric value, a descriptor label, and an optional
 * delta string (e.g. "+12% this month") in a customisable colour. Matches the
 * stat-card pattern in the HTML mockup: white card, icon badge top-left,
 * large value, small label, coloured delta bottom-left.
 */

import React from 'react';
import {
  Pressable,
  View,
  Text,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';

import { Card } from './Card';
import { colors, spacing, radius } from '../../theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StatTileProps {
  /**
   * Icon element — pass a lucide-react-native icon pre-configured with
   * `color` and `size`. The tile supplies the background circle.
   */
  icon: React.ReactNode;
  /**
   * Background colour of the icon circle. Defaults to a soft emerald tint.
   */
  iconBg?: string;
  /** Short descriptor, e.g. "Active Members". */
  label: string;
  /** Primary metric displayed prominently, e.g. "142" or "$4,820". */
  value: string | number;
  /** Optional change indicator, e.g. "+8 this week". Renders as a pill in the top-right corner. */
  delta?: string;
  /**
   * Text colour of the delta pill. Defaults to emerald-700 (positive / neutral).
   * Pass `colors.red700` for negative deltas.
   */
  deltaColor?: string;
  /**
   * Background colour of the delta pill. Defaults to emerald-50 tint.
   * Pass a matching `*-50` colour for negative/warning deltas.
   */
  deltaBg?: string;
  /** Additional styles forwarded to the outer Card. */
  style?: StyleProp<ViewStyle>;
  /**
   * Optional press handler. When supplied, the tile becomes a tappable surface
   * (Pressable wrapper). Used to restore the pre-revamp pattern where stat
   * cards on Dashboard/Home navigated to their details screen.
   */
  onPress?: () => void;
  /** Optional accessibility label override (defaults to the visible label). */
  accessibilityLabel?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Single KPI card for dashboard stat grids.
 *
 * ```tsx
 * <StatTile
 *   icon={<Users color={colors.emerald700} size={18} />}
 *   iconBg={colors.emerald100}
 *   label="Active Members"
 *   value={142}
 *   delta="+8 this week"
 * />
 * ```
 */
export function StatTile({
  icon,
  iconBg = colors.emerald100,
  label,
  value,
  delta,
  deltaColor = colors.emerald700,
  deltaBg = '#ecfdf5',
  style,
  onPress,
  accessibilityLabel,
}: StatTileProps): React.JSX.Element {
  const body = (
    <>
      {/* Top row: icon badge + delta pill */}
      <View style={styles.topRow}>
        <View style={[styles.iconBadge, { backgroundColor: iconBg }]}>
          {icon}
        </View>

        {delta !== undefined && delta.length > 0 && (
          <View style={[styles.deltaPill, { backgroundColor: deltaBg }]}>
            <Text style={[styles.delta, { color: deltaColor }]}>{delta}</Text>
          </View>
        )}
      </View>

      {/* Value */}
      <Text style={styles.value}>{String(value)}</Text>

      {/* Label */}
      <Text style={styles.label}>{label}</Text>
    </>
  );

  // When onPress is supplied, wrap in Pressable so the whole card becomes a
  // tap target. This restores the pre-revamp pattern (CHWDashboard /
  // MemberHome stat cards navigated on tap).
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? `${label}, ${String(value)}`}
        style={({ pressed }) => [pressed && styles.pressed]}
      >
        <Card style={[styles.card, style]}>
          {body}
        </Card>
      </Pressable>
    );
  }

  return <Card style={[styles.card, style]}>{body}</Card>;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    padding: spacing.xl,
    gap:     spacing.xs,
  } as ViewStyle,

  // Top row: icon badge on the left, delta pill pinned to the right
  topRow: {
    flexDirection:  'row',
    alignItems:     'flex-start',
    justifyContent: 'space-between',
    marginBottom:   spacing.sm,
  } as ViewStyle,

  iconBadge: {
    width:          40,
    height:         40,
    // rounded-xl = 12px
    borderRadius:   radius.lg,
    alignItems:     'center',
    justifyContent: 'center',
  } as ViewStyle,

  deltaPill: {
    borderRadius:      radius.pill,
    paddingHorizontal: 8,
    paddingVertical:   3,
    alignSelf:         'flex-start',
  } as ViewStyle,

  value: {
    // mockup: text-3xl font-extrabold = 30px / 800 weight
    fontSize:   30,
    fontWeight: '800',
    color:      colors.textPrimary,
    lineHeight: 36,
  } as TextStyle,

  label: {
    // mockup: text-sm text-gray-500 mt-1 = 14px / 400 / #6b7280
    fontSize:   14,
    fontWeight: '400',
    color:      colors.textSecondary,
    lineHeight: 20,
    marginTop:  4,
  } as TextStyle,

  delta: {
    fontSize:   11,
    fontWeight: '600',
    lineHeight: 14,
  } as TextStyle,

  pressed: {
    opacity: 0.7,
  } as ViewStyle,
});
