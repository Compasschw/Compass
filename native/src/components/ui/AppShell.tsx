/**
 * AppShell — top-level layout wrapper for every dashboard screen.
 *
 * On web: renders a horizontal row with the DashboardSidebar on the left
 * and the screen content in a scrollable main column offset by the sidebar
 * width (256px). The sidebar is collapsible — state persists in localStorage
 * under the key `compass:sidebar:collapsed`. When collapsed, a thin edge flap
 * (24px wide) anchored at the left viewport edge lets the user re-expand it.
 *
 * Keyboard shortcut: pressing `[` on web toggles the collapsed state.
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

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  Platform,
  StyleSheet,
  type ViewStyle,
} from 'react-native';
import { ChevronRight } from 'lucide-react-native';

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

/** Match DashboardSidebar's width (mock spec is w-64 = 16rem = 256px). */
const SIDEBAR_WIDTH = 256;

/** localStorage key for persisting sidebar collapsed state. */
const STORAGE_KEY = 'compass:sidebar:collapsed';

/** Width of the persistent edge flap shown when the sidebar is collapsed. */
const FLAP_WIDTH = 28;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads the initial collapsed state from localStorage.
 * Falls back to `false` (expanded) if the key is absent or localStorage
 * is unavailable (SSR, sandboxed iframe, etc.).
 */
function readPersistedCollapsed(): boolean {
  try {
    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem(STORAGE_KEY);
    return raw === 'true';
  } catch {
    return false;
  }
}

/**
 * Writes the collapsed state to localStorage, swallowing any errors that
 * arise in environments where localStorage is unavailable.
 */
function writePersistedCollapsed(collapsed: boolean): void {
  try {
    (globalThis as { localStorage?: Storage }).localStorage?.setItem(STORAGE_KEY, String(collapsed));
  } catch {
    // Non-fatal — sidebar still works, just won't persist across refresh.
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Layout shell. Sidebar + scrollable main column on web; passthrough on native.
 *
 * The `[` key toggles sidebar collapse on web.
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
    <AppShellWeb
      items={items}
      activeKey={activeKey}
      badges={badges}
      userBlock={userBlock}
      switchViewLabel={switchViewLabel}
      switchViewRoute={switchViewRoute}
      disableMainScroll={disableMainScroll}
    >
      {children}
    </AppShellWeb>
  );
}

// ─── Web-specific shell (hooks-safe — never conditionally rendered) ────────────

interface AppShellWebProps extends Omit<AppShellProps, 'role'> {
  items: typeof chwSidebarItems | typeof memberSidebarItems;
}

/**
 * The web layout shell, extracted so that hooks are never called conditionally
 * (the Platform.OS guard above returns before we reach this component on native).
 */
function AppShellWeb({
  items,
  activeKey,
  badges,
  userBlock,
  switchViewLabel,
  switchViewRoute,
  disableMainScroll = false,
  children,
}: AppShellWebProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<boolean>(readPersistedCollapsed);
  const [flapHovered, setFlapHovered] = useState(false);

  const toggleCollapsed = useCallback((): void => {
    setCollapsed((prev) => {
      const next = !prev;
      writePersistedCollapsed(next);
      return next;
    });
  }, []);

  // Keyboard shortcut: `[` toggles the sidebar on web.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // Ignore when focus is inside a text input so `[` can still be typed.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) {
        return;
      }
      if (e.key === '[') {
        toggleCollapsed();
      }
    };
    (globalThis as { document?: { addEventListener: (t: string, h: EventListenerOrEventListenerObject) => void; removeEventListener: (t: string, h: EventListenerOrEventListenerObject) => void } }).document?.addEventListener('keydown', handler);
    return () => {
      (globalThis as { document?: { addEventListener: (t: string, h: EventListenerOrEventListenerObject) => void; removeEventListener: (t: string, h: EventListenerOrEventListenerObject) => void } }).document?.removeEventListener('keydown', handler);
    };
  }, [toggleCollapsed]);

  return (
    <View style={styles.root}>
      {/* Left sidebar — animated, web only */}
      <DashboardSidebar
        items={items}
        activeKey={activeKey}
        badges={badges}
        userBlock={userBlock}
        switchViewLabel={switchViewLabel}
        switchViewRoute={switchViewRoute}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
      />

      {/* Edge flap — only visible when sidebar is collapsed. Fixed to left
       *  viewport edge; tapping it re-expands the sidebar. */}
      {collapsed && (
        <Pressable
          onPress={toggleCollapsed}
          onHoverIn={() => setFlapHovered(true)}
          onHoverOut={() => setFlapHovered(false)}
          accessibilityRole="button"
          accessibilityLabel="Expand sidebar"
          style={[
            styles.edgeFlap,
            flapHovered && styles.edgeFlapHover,
          ]}
        >
          <ChevronRight color={tokens.emerald100} size={16} strokeWidth={2} />
        </Pressable>
      )}

      {/* Main content column. Either a vertical scroll wrapper (default —
       *  good for static screens) or an unpadded passthrough View (for
       *  screens whose internal layout owns scrolling AND padding, e.g.
       *  the 3-pane Messages inbox or any FlatList-based roster). */}
      {disableMainScroll ? (
        <View
          style={[
            styles.main,
            styles.mainNoPad,
            collapsed ? styles.mainCollapsed : styles.mainExpanded,
          ]}
        >
          {children}
        </View>
      ) : (
        <ScrollView
          style={[
            styles.main,
            collapsed ? styles.mainCollapsed : styles.mainExpanded,
          ]}
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
    flex: 1,
  } as ViewStyle,

  /** When sidebar is expanded, content is offset by the full sidebar width. */
  mainExpanded: {
    marginLeft: SIDEBAR_WIDTH,
  } as ViewStyle,

  /** When sidebar is collapsed, content starts at the left edge (no offset
   *  needed — the sidebar is translated off-screen, not removed from layout,
   *  but AppShell drives margin so content fills the gap). */
  mainCollapsed: {
    marginLeft: 0,
  } as ViewStyle,

  mainContent: {
    padding:  spacing.xxxl,
    flexGrow: 1,
  } as ViewStyle,

  // Used when disableMainScroll=true. Edge-to-edge — the screen's own
  // internal layout (e.g. 3-pane, FlatList header) is responsible for
  // any padding it wants.
  mainNoPad: {
    flexGrow:  1,
    minHeight: '100vh' as unknown as number,
  } as ViewStyle,

  // ── Edge flap ──

  /**
   * Thin vertical tab anchored at the left viewport edge. Shown only when
   * the sidebar is collapsed. z-index 100 keeps it above all content.
   */
  edgeFlap: {
    position:        'fixed' as unknown as 'absolute',
    left:            0,
    top:             0,
    bottom:          0,
    width:           FLAP_WIDTH,
    backgroundColor: tokens.emerald700,
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          100,
    cursor:          'pointer' as unknown as undefined,
  } as ViewStyle,

  edgeFlapHover: {
    // Slightly lighter emerald on hover — same approach as nav item hover.
    backgroundColor: '#05906a',
  } as ViewStyle,
});
