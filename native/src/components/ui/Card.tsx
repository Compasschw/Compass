/**
 * Card — base surface container for the dashboard UI.
 *
 * Renders a white rounded card with a 1px sage border and soft shadow.
 * All other card-style components in the `ui/` design system should
 * compose this rather than re-implement the surface styles.
 */

import React from 'react';
import {
  View,
  StyleSheet,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from 'react-native';

import { colors, radius, shadows } from '../../theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CardProps
  extends Pick<ViewProps, 'accessible' | 'accessibilityLabel' | 'accessibilityHint'> {
  /** Additional styles merged onto the outer View. Accepts an array or a single style. */
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Base card surface. White background, 1px border, 16px radius, shadow.
 *
 * ```tsx
 * <Card style={{ padding: 20 }}>
 *   <Text>Content here</Text>
 * </Card>
 * ```
 */
export function Card({
  style,
  children,
  accessible,
  accessibilityLabel,
  accessibilityHint,
}: CardProps): React.JSX.Element {
  return (
    <View
      style={[styles.card, shadows.card as ViewStyle, style]}
      accessible={accessible}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
    >
      {children}
    </View>
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
});
