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
  UserCircle,
} from 'lucide-react-native';

import { SidebarProvider, useSidebar } from './SidebarContext';
import { CollapsibleDrawerContent } from './CollapsibleDrawerContent';

import { colors } from '../theme/colors';
import { fonts } from '../theme/typography';
import { CHWDashboardScreen } from '../screens/chw/CHWDashboardScreen';
import { CHWRequestsScreen } from '../screens/chw/CHWRequestsScreen';
import { CHWSessionsScreen } from '../screens/chw/CHWSessionsScreen';
import { CHWSessionReviewScreen } from '../screens/chw/CHWSessionReviewScreen';
import { CHWCalendarScreen } from '../screens/chw/CHWCalendarScreen';
import { CHWEarningsScreen } from '../screens/chw/CHWEarningsScreen';
import { CHWIntakeScreen } from '../screens/chw/CHWIntakeScreen';
import { CHWReviewsScreen } from '../screens/chw/CHWReviewsScreen';
import { CHWProfileScreen } from '../screens/chw/CHWProfileScreen';
import { PaymentsScreen } from '../screens/chw/PaymentsScreen';

// ─── Navigator param lists ────────────────────────────────────────────────────

export type CHWTabParamList = {
  DashboardStack: undefined;
  Requests: undefined;
  SessionsStack: undefined;
  Calendar: undefined;
  EarningsStack: undefined;
  Profile: undefined;
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
 * Sessions stack — Sessions list + full-screen post-session review.
 * Exported so CHWSessionReviewScreen can type its navigation prop.
 */
export type CHWSessionsStackParamList = {
  Sessions: undefined;
  SessionReview: { sessionId: string; memberName: string };
};

const Tab = createBottomTabNavigator<CHWTabParamList>();
const Drawer = createDrawerNavigator<CHWTabParamList>();
const DashboardStack = createNativeStackNavigator<DashboardStackParamList>();
const EarningsStack = createNativeStackNavigator<EarningsStackParamList>();
const SessionsStack = createNativeStackNavigator<CHWSessionsStackParamList>();

function DashboardStackNavigator(): React.JSX.Element {
  return (
    <DashboardStack.Navigator screenOptions={{ headerShown: false }}>
      <DashboardStack.Screen name="Dashboard" component={CHWDashboardScreen} />
      <DashboardStack.Screen name="Intake" component={CHWIntakeScreen} />
      <DashboardStack.Screen name="Reviews" component={CHWReviewsScreen} />
    </DashboardStack.Navigator>
  );
}

function EarningsStackNavigator(): React.JSX.Element {
  return (
    <EarningsStack.Navigator screenOptions={{ headerShown: false }}>
      <EarningsStack.Screen name="Earnings" component={CHWEarningsScreen} />
      <EarningsStack.Screen name="Payments" component={PaymentsScreen} />
    </EarningsStack.Navigator>
  );
}

function SessionsStackNavigator(): React.JSX.Element {
  return (
    <SessionsStack.Navigator screenOptions={{ headerShown: false }}>
      <SessionsStack.Screen name="Sessions" component={CHWSessionsScreen} />
      <SessionsStack.Screen name="SessionReview" component={CHWSessionReviewScreen} />
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
  { name: 'DashboardStack', title: 'Dashboard', component: DashboardStackNavigator, icon: LayoutDashboard, rootScreen: 'Dashboard' },
  { name: 'Requests',       title: 'Requests',  component: CHWRequestsScreen,       icon: Inbox },
  { name: 'SessionsStack',  title: 'Sessions',  component: SessionsStackNavigator,  icon: ClipboardList, rootScreen: 'Sessions' },
  { name: 'Calendar',       title: 'Calendar',  component: CHWCalendarScreen,       icon: CalendarDays },
  { name: 'EarningsStack',  title: 'Earnings',  component: EarningsStackNavigator,  icon: DollarSign,    rootScreen: 'Earnings' },
  { name: 'Profile',        title: 'Profile',   component: CHWProfileScreen,        icon: UserCircle },
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
          component={component}
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
                navigation.navigate(name as never, { screen: rootScreen } as never);
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
      drawerContent={(props) => <CollapsibleDrawerContent {...props} />}
      screenOptions={{
        headerShown: false,
        drawerType: 'permanent',
        drawerStyle: {
          width: drawerWidth,
          backgroundColor: colors.card,
          borderRightColor: colors.border,
          borderRightWidth: 1,
          // Web-only CSS transition so the width animates smoothly on collapse.
          ...(Platform.OS === 'web' && {
            transitionProperty: 'width',
            transitionDuration: '200ms',
            transitionTimingFunction: 'ease-in-out',
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
          component={component}
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
                navigation.navigate(name as never, { screen: rootScreen } as never);
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
