/**
 * StatCard — dashboard metric tile with an icon circle, value, label, and optional subtext.
 *
 * Used on CHW and Member dashboards for key stats (earnings, ratings, sessions, etc.).
 */

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  type ViewStyle,
} from 'react-native';
import { colors } from '../../theme/colors';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StatCardProps {
  /** Any ReactNode — typically a lucide-react-native icon. */
  icon: React.ReactNode;
  /** Descriptor shown beneath the value. */
  label: string;
  /** Primary metric to display prominently. */
  value: string | number;
  /** Secondary line displayed in the top-right corner. */
  subtext?: string;
  /** Background colour of the icon circle. Defaults to a tinted primary. */
  iconBg?: string;
  style?: ViewStyle;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Displays a single metric card with icon, value, label, and optional subtext.
 */
export function StatCard({
  icon,
  label,
  value,
  subtext,
  iconBg = 'rgba(44,62,45,0.08)',
  style,
}: StatCardProps): React.JSX.Element {
  return (
    <View style={[styles.card, style]}>
      <View style={styles.topRow}>
        <View style={[styles.iconCircle, { backgroundColor: iconBg }]}>
          {icon}
        </View>
        {subtext !== undefined && (
          <Text style={styles.subtext}>{subtext}</Text>
        )}
      </View>
      <Text style={styles.value}>{String(value)}</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 16,
  } as ViewStyle,
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  } as ViewStyle,
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  subtext: {
    fontSize: 11,
    color: colors.mutedForeground,
    fontWeight: '500',
  },
  value: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: 2,
  },
  label: {
    fontSize: 12,
    color: colors.mutedForeground,
  },
});
