/**
 * RightRail — fixed-width right column container for dashboard layouts.
 *
 * Renders a vertical stack with a default 280px width and 16px gap between
 * children. Screens compose this alongside a main content area in a
 * horizontal flex row to produce the standard two-column dashboard layout.
 */

import React from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { spacing } from '../../theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RightRailProps {
  /**
   * Fixed pixel width of the rail column.
   * @default 280
   */
  width?: number;
  /** Additional styles forwarded to the outer View. */
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Right-side fixed-width column for supplementary content.
 *
 * ```tsx
 * <View style={{ flexDirection: 'row', gap: 16 }}>
 *   <View style={{ flex: 1 }}><MainContent /></View>
 *   <RightRail>
 *     <UpcomingCard />
 *     <AlertsCard />
 *   </RightRail>
 * </View>
 * ```
 */
export function RightRail({
  width = 280,
  style,
  children,
}: RightRailProps): React.JSX.Element {
  return (
    <View style={[styles.rail, { width }, style]}>
      {children}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  rail: {
    gap: spacing.lg,
  } as ViewStyle,
});
