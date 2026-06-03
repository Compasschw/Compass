/**
 * CHW navigator — adaptive shell for Community Health Worker users.
 *
 * - Native (iOS/Android): bottom-tab bar (mobile-first ergonomics).
 * - Web: permanent left drawer (desktop ergonomics — admin/CHWs spend
 *   working sessions in front of a wide screen, side-by-side with notes,
 *   transcripts, calendars, etc.).
 *
 * Both variants register the same screens and the same param list, so any
 * `navigation.navigate(...)` call written against `CHWTabParamList` works
 * identically on every platform.
 */

import React from 'react';
import { Platform } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import {
  LayoutDashboard,
  Inbox,
  CalendarDays,
  ClipboardList,
  DollarSign,
  Map,
  UserCircle,
  Route,
  FolderOpen,
  FileText,
  BarChart3,
  Building2,
  Users,
} from 'lucide-react-native';

import { SidebarProvider, useSidebar } from './SidebarContext';
import { CollapsibleDrawerContent } from './CollapsibleDrawerContent';
import { withErrorBoundary } from '../components/shared/ErrorBoundary';

import { colors } from '../theme/colors';
import { fonts } from '../theme/typography';
import { CHWDashboardScreen } from '../screens/chw/CHWDashboardScreen';
import { CHWMemberProfileScreen } from '../screens/chw/CHWMemberProfileScreen';
import { CHWRequestsScreen } from '../screens/chw/CHWRequestsScreen';
import { CHWSessionsScreen } from '../screens/chw/CHWSessionsScreen';
import { CHWMessagesScreen } from '../screens/chw/CHWMessagesScreen';
import { CHWSessionReviewScreen } from '../screens/chw/CHWSessionReviewScreen';
import { CHWCalendarScreen } from '../screens/chw/CHWCalendarScreen';
import { CHWEarningsScreen } from '../screens/chw/CHWEarningsScreen';
import { CHWIntakeScreen } from '../screens/chw/CHWIntakeScreen';
import { CHWReviewsScreen } from '../screens/chw/CHWReviewsScreen';
import { CHWMapScreen } from '../screens/chw/CHWMapScreen';
import { CHWProfileScreen } from '../screens/chw/CHWProfileScreen';
import { PaymentsScreen } from '../screens/chw/PaymentsScreen';
import { CHWJourneysScreen } from '../screens/chw/CHWJourneysScreen';
import { CHWResourcesScreen } from '../screens/chw/CHWResourcesScreen';
import { CHWDocumentsScreen } from '../screens/chw/CHWDocumentsScreen';
import { CHWReportsScreen } from '../screens/chw/CHWReportsScreen';
import { CHWCommunityPartnersScreen } from '../screens/chw/CHWCommunityPartnersScreen';
import { CHWMembersScreen } from '../screens/chw/CHWMembersScreen';

// ─── Navigator param lists ────────────────────────────────────────────────────

export type CHWTabParamList = {
  DashboardStack: undefined;
  /** Members roster — replaced the old "Requests" label in the sidebar. */
  CHWMembers: undefined;
  /** Inbox / open service requests — new dedicated route. */
  Requests: undefined;
  SessionsStack: undefined;
  Calendar: undefined;
  EarningsStack: undefined;
  Map: undefined;
  Profile: undefined;
  // New (Wave 2) sidebar destinations.
  CHWJourneys: undefined;
  CHWResources: undefined;
  CHWDocuments: undefined;
  CHWReports: undefined;
  CHWCommunityPartners: undefined;
  // Screens inside nested stacks — exposed here so deep links can address
  // them via the CHWTabParamList type without navigating through the stack
  // manually.
  Dashboard: undefined;
  Intake: undefined;
  Payments: undefined;
};

// Nested stack inside the Dashboard tab so we can push CHWIntakeScreen and
// CHWReviewsScreen on top of the main dashboard (full-screen flow, hides tab bar).
type DashboardStackParamList = {
  Dashboard: undefined;
  Intake: undefined;
  Reviews: undefined;
};

// Nested stack inside the Earnings tab so we can push PaymentsScreen on top
// of the main earnings dashboard without leaving the tab bar.
type EarningsStackParamList = {
  Earnings: undefined;
  Payments: undefined;
};

/**
 * Sessions stack — 3-pane Messages inbox (root) + legacy session list +
 * full-screen post-session review + member profile.
 *
 * Root on web: CHWMessagesScreen (new 3-pane inbox).
 * Root on native: CHWSessionsScreen (existing session-detail list).
 *
 * Both roots are registered in the stack so CHWSessionReviewScreen and
 * CHWMemberProfileScreen can push on top from either surface without leaving
 * the tab context.
 */
export type CHWSessionsStackParamList = {
  /**
   * New 3-pane Messages inbox — web root.
   *
   * Optional params let other screens (e.g. CHWMemberProfileScreen) deep-link
   * into a specific member's thread, and optionally auto-trigger a call as
   * soon as the thread loads.  Both are nullable so existing
   * ``navigation.navigate('Messages')`` calls without params keep working.
   *
   * - ``memberId``: pre-select the thread whose member matches this UUID.
   * - ``autoCall``: when ``true`` (and a thread was matched), kick off the
   *   masked-number call sequence immediately after the thread mounts.
   */
  Messages: { memberId?: string; autoCall?: boolean } | undefined;
  /** Legacy per-session list — native root; reachable from web via push. */
  Sessions: undefined;
  /**
   * Post-session follow-up review. `memberId` is optional — when present the
   * member name in the header renders as a tappable link to MemberProfile.
   */
  SessionReview: { sessionId: string; memberName: string; memberId?: string };
  /** HIPAA-gated member profile — requires an active CHW relationship. */
  MemberProfile: { memberId: string };
};

const Tab = createBottomTabNavigator<CHWTabParamList>();
const Drawer = createDrawerNavigator<CHWTabParamList>();
const DashboardStack = createNativeStackNavigator<DashboardStackParamList>();
const EarningsStack = createNativeStackNavigator<EarningsStackParamList>();
const SessionsStack = createNativeStackNavigator<CHWSessionsStackParamList>();

function DashboardStackNavigator(): React.JSX.Element {
  return (
    <DashboardStack.Navigator screenOptions={{ headerShown: false }}>
      <DashboardStack.Screen name="Dashboard" component={withErrorBoundary(CHWDashboardScreen)} />
      <DashboardStack.Screen name="Intake" component={withErrorBoundary(CHWIntakeScreen)} />
      <DashboardStack.Screen name="Reviews" component={withErrorBoundary(CHWReviewsScreen)} />
    </DashboardStack.Navigator>
  );
}

function EarningsStackNavigator(): React.JSX.Element {
  return (
    <EarningsStack.Navigator screenOptions={{ headerShown: false }}>
      <EarningsStack.Screen name="Earnings" component={withErrorBoundary(CHWEarningsScreen)} />
      <EarningsStack.Screen name="Payments" component={withErrorBoundary(PaymentsScreen)} />
    </EarningsStack.Navigator>
  );
}

/**
 * SessionsStackNavigator — Platform-adaptive root:
 *   - Web:    CHWMessagesScreen (new 3-pane inbox) as the tab landing page.
 *   - Native: CHWSessionsScreen (existing session-detail list) unchanged.
 *
 * Both platforms register all screen routes so navigation.navigate(...)
 * calls work regardless of which root is mounted.
 */
function SessionsStackNavigator(): React.JSX.Element {
  if (Platform.OS === 'web') {
    return (
      <SessionsStack.Navigator screenOptions={{ headerShown: false }}>
        <SessionsStack.Screen name="Messages" component={withErrorBoundary(CHWMessagesScreen)} />
        <SessionsStack.Screen name="Sessions" component={withErrorBoundary(CHWSessionsScreen)} />
        <SessionsStack.Screen name="SessionReview" component={withErrorBoundary(CHWSessionReviewScreen)} />
        <SessionsStack.Screen name="MemberProfile" component={withErrorBoundary(CHWMemberProfileScreen)} />
      </SessionsStack.Navigator>
    );
  }
  return (
    <SessionsStack.Navigator screenOptions={{ headerShown: false }}>
      <SessionsStack.Screen name="Sessions" component={withErrorBoundary(CHWSessionsScreen)} />
      <SessionsStack.Screen name="Messages" component={withErrorBoundary(CHWMessagesScreen)} />
      <SessionsStack.Screen name="SessionReview" component={withErrorBoundary(CHWSessionReviewScreen)} />
      <SessionsStack.Screen name="MemberProfile" component={withErrorBoundary(CHWMemberProfileScreen)} />
    </SessionsStack.Navigator>
  );
}

// ─── Screen registry (shared across both variants) ────────────────────────────

interface ScreenSpec {
  name: keyof CHWTabParamList;
  title: string;
  component: React.ComponentType;
  icon: React.ComponentType<{ color: string; size: number }>;
  /**
   * For tabs whose component is a nested stack, this is the root screen
   * inside that stack. Tapping the tab when it's already focused will
   * navigate back to this screen instead of being a no-op (the default
   * React Navigation behavior).
   *
   * Without this, a CHW deep on `DashboardStack > Reviews` who taps the
   * "Dashboard" item in the drawer sees nothing happen — the drawer item
   * IS the focused tab, so React Navigation skips re-navigating.
   */
  rootScreen?: string;
}

const SCREENS: ScreenSpec[] = [
  { name: 'DashboardStack',       title: 'Dashboard',          component: DashboardStackNavigator,    icon: LayoutDashboard, rootScreen: 'Dashboard' },
  { name: 'CHWMembers',           title: 'Members',            component: CHWMembersScreen,           icon: Users },
  { name: 'Requests',             title: 'Inbox',              component: CHWRequestsScreen,          icon: Inbox },
  { name: 'CHWJourneys',          title: 'Journeys',           component: CHWJourneysScreen,          icon: Route },
  { name: 'SessionsStack',        title: 'Messages',           component: SessionsStackNavigator,     icon: ClipboardList,   rootScreen: Platform.OS === 'web' ? 'Messages' : 'Sessions' },
  { name: 'Calendar',             title: 'Appointments',       component: CHWCalendarScreen,          icon: CalendarDays },
  { name: 'CHWResources',         title: 'Resources',          component: CHWResourcesScreen,         icon: FolderOpen },
  { name: 'CHWDocuments',         title: 'Documents',          component: CHWDocumentsScreen,         icon: FileText },
  { name: 'EarningsStack',        title: 'Earnings',           component: EarningsStackNavigator,     icon: DollarSign,      rootScreen: 'Earnings' },
  { name: 'CHWReports',           title: 'Reports',            component: CHWReportsScreen,           icon: BarChart3 },
  { name: 'CHWCommunityPartners', title: 'Community Partners', component: CHWCommunityPartnersScreen, icon: Building2 },
  { name: 'Map',                  title: 'Map',                component: CHWMapScreen,               icon: Map },
  { name: 'Profile',              title: 'Settings',           component: CHWProfileScreen,           icon: UserCircle },
];

// ─── Native variant: bottom tab bar ───────────────────────────────────────────

function CHWBottomTabNavigator(): React.JSX.Element {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: Platform.OS === 'ios' ? 60 : undefined,
          ...Platform.select({
            ios: {
              shadowColor: colors.primary,
              shadowOffset: { width: 0, height: -4 },
              shadowOpacity: 0.06,
              shadowRadius: 12,
            },
            android: { elevation: 8 },
          }),
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontFamily: fonts.bodySemibold,
        },
      }}
    >
      {SCREENS.map(({ name, title, component, icon: Icon, rootScreen }) => (
        <Tab.Screen
          key={name}
          name={name}
          component={withErrorBoundary(component)}
          options={{
            title,
            tabBarIcon: ({ color, size }) => <Icon color={color} size={size} />,
          }}
          listeners={rootScreen ? ({ navigation }) => ({
            tabPress: (e) => {
              // If this tab is already focused and the user taps it again,
              // pop back to the stack's root instead of being a no-op.
              const state = navigation.getState();
              const isFocused = state.routes[state.index]?.name === name;
              if (isFocused) {
                e.preventDefault();
                (navigation as any).navigate(name, { screen: rootScreen });
              }
            },
          }) : undefined}
        />
      ))}
    </Tab.Navigator>
  );
}

// ─── Web variant: permanent left drawer (collapsible) ─────────────────────────

/**
 * Inner drawer navigator that reads collapsed state from SidebarContext.
 * Must be rendered inside `SidebarProvider`.
 */
function CHWWebDrawerNavigatorInner(): React.JSX.Element {
  const { isCollapsed, drawerWidth } = useSidebar();

  return (
    <Drawer.Navigator
      // Drawer chrome is hidden on web (width 0, no content) — every screen is
      // wrapped in <AppShell> which renders the new DashboardSidebar instead.
      // The drawer is still present so React Navigation can register screens
      // and resolve route names from the sidebar's `navigation.navigate(...)`
      // calls. Removing it would break navigation.
      drawerContent={() => null}
      screenOptions={{
        headerShown: false,
        drawerType: 'permanent',
        drawerStyle: {
          width: 0,
          borderRightWidth: 0,
          // Web-only CSS transition so the width animates smoothly on collapse.
          ...(Platform.OS === 'web' && {
            overflow: 'hidden',
          }),
        },
        drawerActiveTintColor: colors.primary,
        drawerInactiveTintColor: colors.mutedForeground,
        drawerActiveBackgroundColor: 'rgba(107,143,113,0.12)',
        // Hide labels when collapsed so only icons show in the rail.
        drawerLabelStyle: isCollapsed
          ? { display: 'none' }
          : {
              fontSize: 14,
              fontFamily: fonts.bodySemibold,
              marginLeft: -8, // tighten icon-to-label spacing
            },
        drawerItemStyle: {
          borderRadius: 10,
          // When collapsed, center the icon by removing horizontal margin.
          marginHorizontal: isCollapsed ? 4 : 8,
          marginVertical: 2,
          // Constrain to icon size so the item doesn't overflow the rail.
          ...(isCollapsed && { width: 48, alignSelf: 'center' }),
        },
      }}
    >
      {SCREENS.map(({ name, title, component, icon: Icon, rootScreen }) => (
        <Drawer.Screen
          key={name}
          name={name}
          component={withErrorBoundary(component)}
          options={{
            title,
            drawerIcon: ({ color, size }) => <Icon color={color} size={size} />,
          }}
          listeners={rootScreen ? ({ navigation }) => ({
            drawerItemPress: (e) => {
              // Same fix as the bottom-tab variant: when the user is deep
              // in a nested stack (e.g. DashboardStack > Reviews) and taps
              // the parent tab in the drawer, navigate back to the stack
              // root instead of doing nothing.
              const state = navigation.getState();
              const isFocused = state.routes[state.index]?.name === name;
              if (isFocused) {
                e.preventDefault();
                (navigation as any).navigate(name, { screen: rootScreen });
              }
            },
          }) : undefined}
        />
      ))}
    </Drawer.Navigator>
  );
}

/**
 * Public wrapper that provides the sidebar context before mounting the drawer.
 * Keeping the provider here (rather than at the app root) means the CHW and
 * Member drawers each own their own collapsed state independently.
 */
function CHWWebDrawerNavigator(): React.JSX.Element {
  return (
    <SidebarProvider>
      <CHWWebDrawerNavigatorInner />
    </SidebarProvider>
  );
}

// ─── Public entry — picks the right shell per platform ────────────────────────

export function CHWTabNavigator(): React.JSX.Element {
  if (Platform.OS === 'web') {
    return <CHWWebDrawerNavigator />;
  }
  return <CHWBottomTabNavigator />;
}
