/**
 * PageHeader — top-of-screen title block used on every dashboard page.
 *
 * Renders a bold 24px title, optional smaller subtitle in secondary grey,
 * and an optional right-side slot for action buttons, filters, or CTAs.
 */

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';

import { colors, spacing } from '../../theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PageHeaderProps {
  /** Primary heading text. Rendered at 24px / 700 weight. */
  title: string;
  /** Optional secondary descriptor below the title. */
  subtitle?: string;
  /** Optional right-aligned slot — action buttons, date pickers, etc. */
  right?: React.ReactNode;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Top-of-page title row.
 *
 * ```tsx
 * <PageHeader
 *   title="Dashboard"
 *   subtitle="Week of May 5 – 11, 2026"
 *   right={<Button>Add Member</Button>}
 * />
 * ```
 */
export function PageHeader({
  title,
  subtitle,
  right,
}: PageHeaderProps): React.JSX.Element {
  return (
    <View style={styles.container}>
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
    marginBottom:   spacing.xxl,
  } as ViewStyle,

  textBlock: {
    flex: 1,
    gap:  4,
  } as ViewStyle,

  title: {
    fontSize:   24,
    fontWeight: '700',
    color:      colors.textPrimary,
    lineHeight: 30,
  } as TextStyle,

  subtitle: {
    fontSize:   14,
    fontWeight: '400',
    color:      colors.textSecondary,
    lineHeight: 20,
    marginTop:  4,
  } as TextStyle,

  rightSlot: {
    flexDirection: 'row',
    alignItems:    'flex-end',
    gap:           spacing.sm,
    marginLeft:    spacing.lg,
  } as ViewStyle,
});
