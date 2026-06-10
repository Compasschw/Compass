/**
 * Pill — semantic colour-coded label chip for statuses, verticals, etc.
 *
 * Six canonical variants (10 → 6 consolidation, Polish Wave 1):
 *
 *   emerald — positive / active / complete
 *   blue    — informational / modality
 *   amber   — attention / in-progress / medium-priority
 *   red     — blocked / refused / high-priority
 *   gray    — neutral / metadata / inactive
 *   purple  — AI-generated content tags (RESERVED — do not use for other semantics)
 *
 * Supports two sizes (`sm` for inline use, `md` for standalone / table use).
 *
 * The optional `withDot` prop renders a small filled circle before the label —
 * used for Status and Risk pills in the Members table (matching members.html).
 * The dot colour is automatically derived from the variant's dot-colour token.
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
  | 'gray';

export type PillSize = 'sm' | 'md';

export interface PillProps {
  variant: PillVariant;
  size?: PillSize;
  /** When true, renders an 8×8 filled dot before the label text. */
  withDot?: boolean;
  children: React.ReactNode;
}

// ─── Token map ────────────────────────────────────────────────────────────────

interface PillTokens {
  bg:   string;
  text: string;
  /** Dot fill colour. Falls back to `text` when not explicitly set. */
  dot:  string;
}

const variantTokens: Record<PillVariant, PillTokens> = {
  emerald: { bg: colors.emerald100, text: colors.emerald700, dot: '#10b981' /* emerald-500 */ },
  red:     { bg: colors.red100,     text: colors.red700,     dot: '#ef4444' /* red-500    */ },
  amber:   { bg: colors.amber100,   text: colors.amber700,   dot: '#f59e0b' /* amber-500  */ },
  blue:    { bg: colors.blue100,    text: colors.blue700,    dot: '#3b82f6' /* blue-500   */ },
  purple:  { bg: colors.purple100,  text: colors.purple700,  dot: '#8b5cf6' /* purple-500 */ },
  gray:    { bg: colors.gray100,    text: colors.gray700,    dot: '#9ca3af' /* gray-400   */ },
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Renders a pill chip with colour-coded background and text.
 *
 * ```tsx
 * <Pill variant="emerald" withDot>Active</Pill>
 * <Pill variant="amber" size="sm">Moderately Engaged</Pill>
 * <Pill variant="red" size="sm">High Risk</Pill>
 * ```
 */
export function Pill({
  variant,
  size = 'md',
  withDot = false,
  children,
}: PillProps): React.JSX.Element {
  const { bg, text, dot } = variantTokens[variant];

  return (
    <View
      style={[
        styles.base,
        size === 'sm' ? styles.sizeSm : styles.sizeMd,
        { backgroundColor: bg },
      ]}
    >
      {withDot && (
        <View style={[styles.dot, { backgroundColor: dot }]} />
      )}
      <Text style={[styles.label, { color: text }]}>
        {children}
      </Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  base: {
    alignSelf:      'flex-start',
    borderRadius:   radius.pill,
    flexDirection:  'row',
    alignItems:     'center',
    gap:            6,
  } as ViewStyle,

  sizeSm: {
    paddingHorizontal: 8,
    paddingVertical:   2,
  } as ViewStyle,

  sizeMd: {
    paddingHorizontal: 10,
    paddingVertical:   3,
  } as ViewStyle,

  dot: {
    width:        8,
    height:       8,
    borderRadius: 999,
    flexShrink:   0,
  } as ViewStyle,

  label: {
    fontSize:   11,
    fontWeight: '600',
    lineHeight: 16,
  } as TextStyle,
});
