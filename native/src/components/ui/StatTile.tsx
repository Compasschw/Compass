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
  View,
  Text,
  StyleSheet,
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
  /** Optional change indicator, e.g. "+8 this week". */
  delta?: string;
  /**
   * Colour of the delta text. Defaults to emerald-700 (positive / neutral).
   * Pass `colors.red700` for negative deltas.
   */
  deltaColor?: string;
  /** Additional styles forwarded to the outer Card. */
  style?: ViewStyle;
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
  style,
}: StatTileProps): React.JSX.Element {
  return (
    <Card style={[styles.card, style]}>
      {/* Icon badge */}
      <View style={[styles.iconBadge, { backgroundColor: iconBg }]}>
        {icon}
      </View>

      {/* Value */}
      <Text style={styles.value}>{String(value)}</Text>

      {/* Label */}
      <Text style={styles.label}>{label}</Text>

      {/* Delta */}
      {delta !== undefined && delta.length > 0 && (
        <Text style={[styles.delta, { color: deltaColor }]}>{delta}</Text>
      )}
    </Card>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    padding: spacing.lg,
    gap:     spacing.xs,
  } as ViewStyle,

  iconBadge: {
    width:          40,
    height:         40,
    borderRadius:   radius.md,
    alignItems:     'center',
    justifyContent: 'center',
    marginBottom:   spacing.sm,
  } as ViewStyle,

  value: {
    fontSize:   22,
    fontWeight: '700',
    color:      colors.textPrimary,
    lineHeight: 28,
  } as TextStyle,

  label: {
    fontSize:   12,
    fontWeight: '500',
    color:      colors.textSecondary,
    lineHeight: 16,
  } as TextStyle,

  delta: {
    fontSize:   11,
    fontWeight: '600',
    lineHeight: 14,
    marginTop:  2,
  } as TextStyle,
});
