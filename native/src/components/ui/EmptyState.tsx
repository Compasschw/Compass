/**
 * EmptyState — designed empty-state primitive for zero-data screens.
 *
 * Replaces bare-text fallbacks ("No sessions yet", "No conversations here.")
 * with a consistently styled, accessible empty-state block that includes an
 * icon, title, body copy, and an optional primary CTA button.
 *
 * Matches the design spec in `/tmp/compass-polish-mockups/d-empty-states.html`:
 *   - 64×64 emerald-100 circle with a 28px lucide icon (emerald-700, strokeWidth 1.5)
 *   - 16px/600 title, 13.5px/400 body (max 40ch, line-height 1.6)
 *   - Optional primary CTA (13px/600, primary bg, radius 10, padding 9 20)
 *   - All centred; 48px top / 40px bottom padding
 *
 * Use `inverted` on darker section backgrounds (e.g. the emerald hero card on
 * the rewards screen) — swaps surfaces to `emerald100` bg and adjusts text
 * contrast.
 *
 * ```tsx
 * // Without CTA (read-only context — member cannot self-schedule)
 * <EmptyState
 *   icon={Calendar}
 *   title="No sessions yet"
 *   body="Your CHW will schedule your first session."
 * />
 *
 * // With CTA
 * <EmptyState
 *   icon={MessageSquare}
 *   title="No conversations yet"
 *   body="Threads appear when you connect with a member."
 *   cta={{ label: 'Find Members', onPress: () => navigate('FindMembers') }}
 * />
 * ```
 */

import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

import { colors, radius, spacing } from '../../theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EmptyStateCTAProps {
  /** Button label text. */
  label: string;
  /** Called when the CTA button is pressed. */
  onPress: () => void;
}

export interface EmptyStateProps {
  /**
   * Lucide icon component (not an element — the component reference itself).
   * The EmptyState supplies size and color.
   *
   * @example icon={MessageSquare}
   */
  icon: LucideIcon;
  /** Short, human-readable heading. Keep to one line if possible. */
  title: string;
  /** Supporting copy — explains why empty and what to expect. Max ~40 chars/line. */
  body: string;
  /** Optional primary call-to-action button. Omit for read-only empty states. */
  cta?: EmptyStateCTAProps;
  /**
   * Inverted style variant for darker container backgrounds (e.g. emerald hero
   * cards). Swaps the icon circle background to semi-transparent white and
   * lightens body text.
   *
   * @default false
   */
  inverted?: boolean;
  /** Additional styles merged onto the outer container. */
  style?: StyleProp<ViewStyle>;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Designed empty-state block. Drop inside any `Card` or container when the
 * data set is empty.
 */
export function EmptyState({
  icon: Icon,
  title,
  body,
  cta,
  inverted = false,
  style,
}: EmptyStateProps): React.JSX.Element {
  const iconBg    = inverted ? 'rgba(255,255,255,0.25)' : colors.emerald100;
  const iconColor = inverted ? '#ffffff'                 : colors.emerald700;
  const titleColor = inverted ? '#ffffff'                : colors.textPrimary;
  const bodyColor  = inverted ? 'rgba(255,255,255,0.75)' : colors.textMuted;

  return (
    <View
      style={[styles.container, style]}
      accessible
      accessibilityRole="none"
      aria-label={`${title}. ${body}`}
    >
      {/* Icon circle */}
      <View style={[styles.iconCircle, { backgroundColor: iconBg }]}>
        <Icon size={28} color={iconColor} strokeWidth={1.5} />
      </View>

      {/* Title */}
      <Text style={[styles.title, { color: titleColor }]}>{title}</Text>

      {/* Body */}
      <Text style={[styles.body, { color: bodyColor }]}>{body}</Text>

      {/* Optional CTA */}
      {cta !== undefined && (
        <CTAButton label={cta.label} onPress={cta.onPress} />
      )}
    </View>
  );
}

// ─── Internal: minimal primary CTA button ────────────────────────────────────

/**
 * Minimal primary CTA button used exclusively within `EmptyState`.
 * Not exported — callers should not use this directly.
 */
function CTAButton({ label, onPress }: EmptyStateCTAProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
    >
      <Text style={styles.ctaLabel}>{label}</Text>
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    alignItems:     'center',
    justifyContent: 'center',
    paddingTop:     48,
    paddingBottom:  40,
    paddingHorizontal: spacing.lg,
  } as ViewStyle,

  iconCircle: {
    width:           64,
    height:          64,
    borderRadius:    32,
    alignItems:      'center',
    justifyContent:  'center',
    marginBottom:    spacing.lg,
  } as ViewStyle,

  title: {
    fontSize:    16,
    fontWeight:  '600',
    color:       colors.textPrimary,
    textAlign:   'center',
    marginBottom: 6,
  } as TextStyle,

  body: {
    fontSize:    13.5,
    fontWeight:  '400',
    color:       colors.textMuted,
    textAlign:   'center',
    lineHeight:  13.5 * 1.6,
    // 40ch approximated at ~260px on a 390pt screen.
    maxWidth:    260,
    marginBottom: spacing.lg,
  } as TextStyle,

  cta: {
    backgroundColor:   colors.primary,
    borderRadius:      radius.md,
    paddingHorizontal: 20,
    paddingVertical:   9,
    alignItems:        'center',
    justifyContent:    'center',
  } as ViewStyle,

  ctaPressed: {
    backgroundColor: colors.primaryHover,
  } as ViewStyle,

  ctaLabel: {
    fontSize:   13,
    fontWeight: '600',
    color:      '#ffffff',
  } as TextStyle,
});
