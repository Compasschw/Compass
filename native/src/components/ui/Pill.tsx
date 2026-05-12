/**
 * Pill — semantic colour-coded label chip for statuses, verticals, etc.
 *
 * Supports the full set of colour variants defined in the design system tokens
 * (`emerald | red | amber | blue | purple | orange | pink | gray`) and two
 * sizes (`sm` for inline use, `md` for standalone / table use).
 */

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';

import { colors, radius } from '../../theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PillVariant =
  | 'emerald'
  | 'red'
  | 'amber'
  | 'blue'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'gray';

export type PillSize = 'sm' | 'md';

export interface PillProps {
  variant: PillVariant;
  size?: PillSize;
  children: React.ReactNode;
}

// ─── Token map ────────────────────────────────────────────────────────────────

interface PillTokens {
  bg:   string;
  text: string;
}

const variantTokens: Record<PillVariant, PillTokens> = {
  emerald: { bg: colors.emerald100, text: colors.emerald700 },
  red:     { bg: colors.red100,     text: colors.red700     },
  amber:   { bg: colors.amber100,   text: colors.amber700   },
  blue:    { bg: colors.blue100,    text: colors.blue700    },
  purple:  { bg: colors.purple100,  text: colors.purple700  },
  orange:  { bg: colors.orange100,  text: colors.orange700  },
  pink:    { bg: colors.pink100,    text: colors.pink700    },
  gray:    { bg: colors.gray100,    text: colors.gray700    },
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Renders a pill chip with colour-coded background and text.
 *
 * ```tsx
 * <Pill variant="emerald">Active</Pill>
 * <Pill variant="red" size="sm">Overdue</Pill>
 * ```
 */
export function Pill({
  variant,
  size = 'md',
  children,
}: PillProps): React.JSX.Element {
  const { bg, text } = variantTokens[variant];

  return (
    <View
      style={[
        styles.base,
        size === 'sm' ? styles.sizeSm : styles.sizeMd,
        { backgroundColor: bg },
      ]}
    >
      <Text style={[styles.label, { color: text }]}>
        {children}
      </Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  base: {
    alignSelf:    'flex-start',
    borderRadius: radius.pill,
  } as ViewStyle,

  sizeSm: {
    paddingHorizontal: 8,
    paddingVertical:   2,
  } as ViewStyle,

  sizeMd: {
    paddingHorizontal: 10,
    paddingVertical:   3,
  } as ViewStyle,

  label: {
    fontSize:   11,
    fontWeight: '600',
    lineHeight: 16,
  } as TextStyle,
});
