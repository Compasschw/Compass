/**
 * PressableMember — wrap any view that names/depicts a member in a Pressable
 * that navigates to the CHW Member Profile screen.
 *
 * Centralises the navigation call so that tapping a member's avatar or name
 * anywhere in the CHW app behaves consistently. Today the Member Profile is
 * a stack screen nested under SessionsStack (registered in
 * `navigation/CHWTabNavigator.tsx`), so we always use the cross-stack form
 * which resolves correctly whether the caller is inside or outside that stack.
 *
 * Visual chrome: keeps `children` visually unchanged. On web we add a
 * cursor-pointer hint and a subtle hover background so the affordance reads
 * as "this is interactive". On native there's no visible chrome change —
 * the press feedback is the standard tap-flash from RN's Pressable.
 *
 * Accessibility: announces as a link with the member's display name so
 * VoiceOver / TalkBack reads "Open Maria Johnson's profile, link".
 *
 * Usage:
 * ```tsx
 * <PressableMember memberId={m.id} displayName={m.displayName}>
 *   <Avatar displayName={m.displayName} initials={m.avatarInitials} size={36} />
 * </PressableMember>
 *
 * <PressableMember memberId={m.id} displayName={m.displayName}>
 *   <Text style={s.name}>{m.displayName}</Text>
 * </PressableMember>
 * ```
 */

import React, { useCallback, useState } from 'react';
import { Platform, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { useNavigation } from '@react-navigation/native';

export interface PressableMemberProps {
  /** Backend UUID of the member whose profile should open. */
  memberId: string;
  /** Display name used to compose the accessibility label. */
  displayName: string;
  /** Optional override for the wrapper's container style. */
  style?: ViewStyle | ViewStyle[];
  /**
   * When ``false`` the component renders ``children`` without any Pressable
   * wrapper. Use to gracefully degrade rows that should only be interactive
   * when the memberId is known (e.g. ``isReady && memberId``).
   */
  enabled?: boolean;
  children: React.ReactNode;
}

export function PressableMember({
  memberId,
  displayName,
  style,
  enabled = true,
  children,
}: PressableMemberProps): React.JSX.Element {
  const navigation = useNavigation<any>();
  const [hovered, setHovered] = useState(false);

  const handlePress = useCallback(() => {
    // Cross-stack navigate so this works whether the caller is rendered
    // inside SessionsStack (e.g. CHWSessionsScreen) or any other tab stack.
    navigation.navigate('SessionsStack', {
      screen: 'MemberProfile',
      params: { memberId },
    });
  }, [navigation, memberId]);

  if (!enabled || !memberId) {
    return <View style={style}>{children}</View>;
  }

  return (
    <Pressable
      onPress={handlePress}
      // RN-Web honours these to render a hover state — RN-native ignores them
      // (so the casts are required even though the props exist on the web type).
      onHoverIn={Platform.OS === 'web' ? () => setHovered(true) : undefined}
      onHoverOut={Platform.OS === 'web' ? () => setHovered(false) : undefined}
      accessibilityRole="link"
      accessibilityLabel={`Open ${displayName}'s profile`}
      style={[
        s.wrapper,
        Platform.OS === 'web' ? (s.cursor as ViewStyle) : null,
        hovered ? s.hovered : null,
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  wrapper: {
    // Default: no extra spacing or border so the wrapper doesn't disturb the
    // surrounding layout. Callers pass `style` to override when needed.
  },
  cursor: {
    // RN-Web converts this to CSS `cursor: pointer`. Native ignores it.
    // (`cursor: 'pointer'` is a valid RN `CursorValue`, so no suppression needed.)
    cursor: 'pointer',
  },
  hovered: {
    // Subtle slate-50 tint on hover so the affordance reads on desktop.
    backgroundColor: 'rgba(15, 23, 42, 0.04)',
    borderRadius: 6,
  },
});
