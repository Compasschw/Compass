/**
 * SectionHeader — in-screen section delimiter used between content groups.
 *
 * Renders a bold section title with an optional subtitle line and an optional
 * right-side action slot (e.g. a "View all" link). Matches the inline
 * `cardTitle` + `viewAllLink` pattern repeated across CHW screens and
 * consolidates it into a single reusable primitive.
 *
 * Usage:
 * ```tsx
 * <SectionHeader title="Today's Schedule" />
 *
 * <SectionHeader
 *   title="Recent activity"
 *   right={
 *     <TouchableOpacity onPress={onViewAll} accessibilityRole="link">
 *       <Text style={{ color: colors.primary, fontWeight: '600', fontSize: 13 }}>
 *         Open feed →
 *       </Text>
 *     </TouchableOpacity>
 *   }
 * />
 *
 * <SectionHeader title="Bank & payout setup" subtitle="Connected via Stripe Express" />
 * ```
 */

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';

import { colors, spacing } from '../../theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SectionHeaderProps {
  /** Primary section label. Rendered at 16px / 600 weight. */
  title: string;
  /** Optional secondary descriptor below the title. Rendered at 12px / 400. */
  subtitle?: string;
  /** Optional right-aligned slot — "View all" links, filter toggles, etc. */
  right?: React.ReactNode;
  /** Bottom margin below the header row. Defaults to `spacing.lg` (16). */
  marginBottom?: number;
  /** Additional styles forwarded to the outer container View. */
  style?: StyleProp<ViewStyle>;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Section delimiter inside a Card or scroll region.
 *
 * This consolidates the recurring inline `cardTitle` / `cardHeaderRow` /
 * `viewAllLink` pattern found across CHW screens into a shared primitive.
 * Wave 3 Member screens should use this wherever a section title appears
 * inside a card body.
 */
export function SectionHeader({
  title,
  subtitle,
  right,
  marginBottom = spacing.lg,
  style,
}: SectionHeaderProps): React.JSX.Element {
  return (
    <View style={[styles.container, { marginBottom }, style]}>
      <View style={styles.textBlock}>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        {subtitle !== undefined && subtitle.length > 0 && (
          <Text style={styles.subtitle}>{subtitle}</Text>
        )}
      </View>

      {right !== undefined && (
        <View style={styles.rightSlot}>{right}</View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
  } as ViewStyle,

  textBlock: {
    flex: 1,
    gap:  2,
  } as ViewStyle,

  title: {
    fontSize:   16,
    fontWeight: '600',
    color:      colors.textPrimary,
    lineHeight: 22,
  } as TextStyle,

  subtitle: {
    fontSize:   12,
    fontWeight: '400',
    color:      colors.textSecondary,
    lineHeight: 16,
    marginTop:  2,
  } as TextStyle,

  rightSlot: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.sm,
    marginLeft:    spacing.md,
  } as ViewStyle,
});
