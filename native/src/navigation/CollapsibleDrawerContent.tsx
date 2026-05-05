/**
 * CollapsibleDrawerContent — custom drawer content for the web permanent sidebar.
 *
 * Renders the standard `DrawerItemList` (so all routing / active-state logic
 * is unchanged) plus a toggle button at the bottom that collapses the sidebar
 * to a 64px icon-rail or expands it back to 224px.
 *
 * Animation is driven by a CSS transition on the parent `drawerStyle.width`
 * (set by the navigator's `screenOptions`), not Animated/Reanimated, which
 * keeps the implementation web-only and avoids touching the native render path.
 *
 * The component is intentionally stateless — all state lives in SidebarContext
 * so both CHW and Member drawers share the same pattern without prop-drilling.
 */

import React, { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import {
  DrawerContentScrollView,
  DrawerItemList,
  type DrawerContentComponentProps,
} from '@react-navigation/drawer';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react-native';

import { colors } from '../theme/colors';
import { useSidebar } from './SidebarContext';

// ─── Types ────────────────────────────────────────────────────────────────────

type CollapsibleDrawerContentProps = DrawerContentComponentProps;

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Drop-in replacement for the default drawer content. Pass this via the
 * `drawerContent` prop on `Drawer.Navigator`.
 *
 * ```tsx
 * <Drawer.Navigator
 *   drawerContent={(props) => <CollapsibleDrawerContent {...props} />}
 * >
 * ```
 */
export function CollapsibleDrawerContent(
  props: CollapsibleDrawerContentProps,
): React.JSX.Element {
  const { isCollapsed, toggle } = useSidebar();
  // Track hover state separately — Pressable's PressableStateCallbackType
  // only exposes `pressed`; hover is handled via onHoverIn/onHoverOut.
  const [isToggleHovered, setIsToggleHovered] = useState(false);

  return (
    <View style={styles.wrapper}>
      {/* Item list — fills all remaining vertical space */}
      <DrawerContentScrollView
        {...props}
        contentContainerStyle={[
          styles.scrollContent,
          isCollapsed && styles.scrollContentCollapsed,
        ]}
      >
        <DrawerItemList {...props} />
      </DrawerContentScrollView>

      {/* Toggle button — pinned to the bottom of the sidebar */}
      <View style={[styles.toggleRow, isCollapsed && styles.toggleRowCollapsed]}>
        <Pressable
          onPress={toggle}
          onHoverIn={() => setIsToggleHovered(true)}
          onHoverOut={() => setIsToggleHovered(false)}
          style={({ pressed }) => [
            styles.toggleButton,
            (pressed || isToggleHovered) && styles.toggleButtonActive,
          ]}
          accessibilityRole="button"
          accessibilityLabel={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          accessibilityHint={
            isCollapsed
              ? 'Shows navigation labels alongside icons'
              : 'Hides navigation labels, showing only icons'
          }
        >
          {isCollapsed ? (
            <PanelLeftOpen
              color={colors.mutedForeground}
              size={20}
            />
          ) : (
            <PanelLeftClose
              color={colors.mutedForeground}
              size={20}
            />
          )}
        </Pressable>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
  },

  scrollContent: {
    // Extra bottom padding so the last nav item isn't occluded by the toggle row.
    paddingBottom: 56,
  },

  // When collapsed, tighten horizontal padding so icons stay centered at 64px.
  scrollContentCollapsed: {
    paddingHorizontal: 0,
  },

  toggleRow: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 48,
    paddingHorizontal: 16,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },

  // Center the icon button when the rail is at 64px.
  toggleRowCollapsed: {
    justifyContent: 'center',
    paddingHorizontal: 0,
  },

  toggleButton: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },

  toggleButtonActive: {
    backgroundColor: 'rgba(107,143,113,0.10)',
  },
});
