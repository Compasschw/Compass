/**
 * AppShell — top-level layout wrapper for every dashboard screen.
 *
 * On web: renders a horizontal row with the DashboardSidebar on the left
 * and the screen content in a scrollable main column offset by the sidebar
 * width (240px). The page background is the sage-tinted off-white from
 * the design tokens.
 *
 * On native iOS/Android: renders children directly with no additional chrome
 * — the existing drawer navigator provides the navigation surface.
 *
 * Usage:
 * ```tsx
 * export function CHWDashboardScreen() {
 *   const { user } = useAuth();
 *   return (
 *     <AppShell
 *       role="chw"
 *       activeKey="dashboard"
 *       badges={{ unreadMessages: 3 }}
 *       userBlock={{ initials: 'JT', name: 'John Thomas', role: 'CHW' }}
 *     >
 *       <PageHeader title="Dashboard" />
 *       ...
 *     </AppShell>
 *   );
 * }
 * ```
 */

import React from 'react';
import {
  View,
  ScrollView,
  Platform,
  StyleSheet,
  type ViewStyle,
} from 'react-native';

import { DashboardSidebar } from './DashboardSidebar';
import { chwSidebarItems, memberSidebarItems } from './sidebarItems';
import type { UserBlock } from './DashboardSidebar';
import { colors as tokens, spacing } from '../../theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AppShellRole = 'chw' | 'member';

export interface AppShellProps {
  /** Determines which sidebar item set and role tagline to display. */
  role: AppShellRole;
  /** Key of the currently active screen — forwarded to DashboardSidebar. */
  activeKey: string;
  /**
   * Badge values keyed by `badgeKey` from sidebarItems.
   * e.g. `{ unreadMessages: 3, wellnessPoints: 120 }`
   */
  badges?: Record<string, string | number>;
  /** User identity for the sidebar avatar block. */
  userBlock: UserBlock;
  /**
   * Label for the optional "Switch to X view" link in the sidebar.
   * Omit to hide the link.
   */
  switchViewLabel?: string;
  /** Route name to navigate when the switch link is pressed. */
  switchViewRoute?: string;
  /**
   * Skip the outer ScrollView wrapper around `children`. Use when the screen
   * owns its own scroll surface (e.g. has a FlatList or 3-pane internal layout)
   * so we don't end up with nested scroll areas.
   */
  disableMainScroll?: boolean;
  /** Screen content. */
  children: React.ReactNode;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Match DashboardSidebar's width (mock spec is w-64 = 16rem = 256px).
const SIDEBAR_WIDTH = 256;

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Layout shell. Sidebar + scrollable main column on web; passthrough on native.
 */
export function AppShell({
  role,
  activeKey,
  badges,
  userBlock,
  switchViewLabel,
  switchViewRoute,
  disableMainScroll = false,
  children,
}: AppShellProps): React.JSX.Element {
  const items = role === 'chw' ? chwSidebarItems : memberSidebarItems;

  // Native: no shell — the navigator provides chrome.
  if (Platform.OS !== 'web') {
    return <>{children}</>;
  }

  return (
    <View style={styles.root}>
      {/* Left sidebar — web only */}
      <DashboardSidebar
        items={items}
        activeKey={activeKey}
        badges={badges}
        userBlock={userBlock}
        switchViewLabel={switchViewLabel}
        switchViewRoute={switchViewRoute}
      />

      {/* Main content column. Either a vertical scroll wrapper (default —
       *  good for static screens) or an unpadded passthrough View (for
       *  screens whose internal layout owns scrolling AND padding, e.g.
       *  the 3-pane Messages inbox or any FlatList-based roster). */}
      {disableMainScroll ? (
        <View style={[styles.main, styles.mainNoPad]}>{children}</View>
      ) : (
        <ScrollView
          style={styles.main}
          contentContainerStyle={styles.mainContent}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex:            1,
    flexDirection:   'row',
    backgroundColor: tokens.pageBg,
    minHeight:       '100vh' as unknown as number,
  } as ViewStyle,

  main: {
    flex:      1,
    marginLeft: SIDEBAR_WIDTH,
  } as ViewStyle,

  mainContent: {
    padding:  spacing.xxxl,
    flexGrow: 1,
  } as ViewStyle,

  // Used when disableMainScroll=true. Edge-to-edge — the screen's own
  // internal layout (e.g. 3-pane, FlatList header) is responsible for
  // any padding it wants.
  mainNoPad: {
    flexGrow: 1,
    minHeight: '100vh' as unknown as number,
  } as ViewStyle,
});
