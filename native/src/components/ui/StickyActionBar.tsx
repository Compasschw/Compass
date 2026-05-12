/**
 * StickyActionBar — bottom-pinned action row for detail screens.
 *
 * Renders a white card fixed to the bottom of the screen with a horizontal
 * row of icon + label action buttons and an optional primary CTA button on
 * the left. Designed for CHW session detail and member profile screens.
 *
 * On web the bar is `position: fixed; bottom: 0`. On native it is an
 * absolutely positioned View that sits above the safe-area inset — callers
 * should ensure the scroll container has matching `paddingBottom`.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Platform,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';

import { colors, spacing, radius, shadows } from '../../theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActionItem {
  /** lucide-react-native icon element. */
  icon: React.ReactNode;
  /** Label displayed below the icon. */
  label: string;
  onPress: () => void;
  /** Disabled state. Defaults to false. */
  disabled?: boolean;
}

export interface PrimaryAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

export interface StickyActionBarProps {
  /** Optional left-most primary CTA button. */
  primary?: PrimaryAction;
  /** Array of icon-button actions rendered in a horizontal row. */
  actions: ActionItem[];
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Bottom-pinned action bar. Compose inside a screen's root View.
 *
 * ```tsx
 * <StickyActionBar
 *   primary={{ label: 'Start Session', onPress: handleStart }}
 *   actions={[
 *     { icon: <Phone size={18} />, label: 'Call',    onPress: handleCall    },
 *     { icon: <Mail  size={18} />, label: 'Message', onPress: handleMessage },
 *   ]}
 * />
 * ```
 */
export function StickyActionBar({
  primary,
  actions,
}: StickyActionBarProps): React.JSX.Element {
  return (
    <View style={[styles.bar, shadows.card as ViewStyle]}>
      {/* Primary CTA */}
      {primary !== undefined && (
        <PrimaryButton
          label={primary.label}
          onPress={primary.onPress}
          disabled={primary.disabled ?? false}
        />
      )}

      {/* Divider when both sections are present */}
      {primary !== undefined && actions.length > 0 && (
        <View style={styles.divider} />
      )}

      {/* Action icon row */}
      {actions.map((action) => (
        <ActionButton key={action.label} item={action} />
      ))}
    </View>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface PrimaryButtonProps {
  label: string;
  onPress: () => void;
  disabled: boolean;
}

function PrimaryButton({
  label,
  onPress,
  disabled,
}: PrimaryButtonProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.primaryBtn,
        (hovered || pressed) && !disabled && styles.primaryBtnHover,
        disabled && styles.primaryBtnDisabled,
      ]}
    >
      <Text style={styles.primaryBtnLabel}>{label}</Text>
    </Pressable>
  );
}

interface ActionButtonProps {
  item: ActionItem;
}

function ActionButton({ item }: ActionButtonProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      onPress={item.disabled ? undefined : item.onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole="button"
      accessibilityLabel={item.label}
      accessibilityState={{ disabled: item.disabled ?? false }}
      style={({ pressed }) => [
        styles.actionBtn,
        (hovered || pressed) && !item.disabled && styles.actionBtnHover,
        item.disabled && styles.actionBtnDisabled,
      ]}
    >
      {item.icon}
      <Text style={styles.actionBtnLabel}>{item.label}</Text>
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const isWeb = Platform.OS === 'web';

const styles = StyleSheet.create({
  bar: {
    position:        isWeb ? 'fixed' as 'absolute' : 'absolute',
    bottom:          0,
    left:            0,
    right:           0,
    flexDirection:   'row',
    alignItems:      'center',
    gap:             spacing.sm,
    backgroundColor: colors.cardBg,
    borderTopWidth:  1,
    borderTopColor:  colors.cardBorder,
    paddingHorizontal: spacing.xl,
    paddingVertical:   spacing.md,
  } as ViewStyle,

  divider: {
    width:           1,
    height:          32,
    backgroundColor: colors.cardBorder,
    marginHorizontal: spacing.xs,
  } as ViewStyle,

  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius:    radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical:   10,
  } as ViewStyle,

  primaryBtnHover: {
    backgroundColor: colors.primaryHover,
  } as ViewStyle,

  primaryBtnDisabled: {
    opacity: 0.45,
  } as ViewStyle,

  primaryBtnLabel: {
    color:      '#ffffff',
    fontSize:   14,
    fontWeight: '600',
    lineHeight: 20,
  } as TextStyle,

  actionBtn: {
    alignItems:     'center',
    justifyContent: 'center',
    gap:            4,
    paddingHorizontal: spacing.md,
    paddingVertical:   spacing.xs,
    borderRadius:      radius.md,
  } as ViewStyle,

  actionBtnHover: {
    backgroundColor: colors.gray100,
  } as ViewStyle,

  actionBtnDisabled: {
    opacity: 0.4,
  } as ViewStyle,

  actionBtnLabel: {
    fontSize:   10,
    fontWeight: '600',
    color:      colors.textSecondary,
    lineHeight: 14,
  } as TextStyle,
});
