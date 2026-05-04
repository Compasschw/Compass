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
import { PayoutDetailScreen } from '../screens/chw/PayoutDetailScreen';

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

// Nested stack inside the Earnings tab so we can push PaymentsScreen and
// per-session PayoutDetailScreen on top of the main earnings dashboard
// without leaving the tab bar. Exported so PayoutDetailScreen can type its
// navigation prop against the canonical param list.
export type EarningsStackParamList = {
  Earnings: undefined;
  Payments: undefined;
  PayoutDetail: { sessionId: string };
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
      <EarningsStack.Screen name="PayoutDetail" component={PayoutDetailScreen} />
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
}

const SCREENS: ScreenSpec[] = [
  { name: 'DashboardStack', title: 'Dashboard', component: DashboardStackNavigator, icon: LayoutDashboard },
  { name: 'Requests',       title: 'Requests',  component: CHWRequestsScreen,       icon: Inbox },
  { name: 'SessionsStack',  title: 'Sessions',  component: SessionsStackNavigator,  icon: ClipboardList },
  { name: 'Calendar',       title: 'Calendar',  component: CHWCalendarScreen,       icon: CalendarDays },
  { name: 'EarningsStack',  title: 'Earnings',  component: EarningsStackNavigator,  icon: DollarSign },
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
      {SCREENS.map(({ name, title, component, icon: Icon }) => (
        <Tab.Screen
          key={name}
          name={name}
          component={component}
          options={{
            title,
            tabBarIcon: ({ color, size }) => <Icon color={color} size={size} />,
          }}
        />
      ))}
    </Tab.Navigator>
  );
}

// ─── Web variant: permanent left drawer ───────────────────────────────────────

function CHWWebDrawerNavigator(): React.JSX.Element {
  return (
    <Drawer.Navigator
      screenOptions={{
        headerShown: false,
        drawerType: 'permanent',
        drawerStyle: {
          width: 224,
          backgroundColor: colors.card,
          borderRightColor: colors.border,
          borderRightWidth: 1,
        },
        drawerActiveTintColor: colors.primary,
        drawerInactiveTintColor: colors.mutedForeground,
        drawerActiveBackgroundColor: 'rgba(107,143,113,0.12)',
        drawerLabelStyle: {
          fontSize: 14,
          fontFamily: fonts.bodySemibold,
          marginLeft: -8, // tighten icon-to-label spacing
        },
        drawerItemStyle: {
          borderRadius: 10,
          marginHorizontal: 8,
          marginVertical: 2,
        },
      }}
    >
      {SCREENS.map(({ name, title, component, icon: Icon }) => (
        <Drawer.Screen
          key={name}
          name={name}
          component={component}
          options={{
            title,
            drawerIcon: ({ color, size }) => <Icon color={color} size={size} />,
          }}
        />
      ))}
    </Drawer.Navigator>
  );
}

// ─── Public entry — picks the right shell per platform ────────────────────────

export function CHWTabNavigator(): React.JSX.Element {
  if (Platform.OS === 'web') {
    return <CHWWebDrawerNavigator />;
  }
  return <CHWBottomTabNavigator />;
}
