/**
 * Bottom-tab navigator for CHW (Community Health Worker) users.
 *
 * Tabs: Dashboard, Requests, Sessions, Calendar, Earnings, Profile
 */

import React from 'react';
import { Platform } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
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

// Nested stack inside the Dashboard tab so we can push CHWIntakeScreen on top
// of the main dashboard (full-screen flow, hides tab bar).
type DashboardStackParamList = {
  Dashboard: undefined;
  Intake: undefined;
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
const DashboardStack = createNativeStackNavigator<DashboardStackParamList>();
const EarningsStack = createNativeStackNavigator<EarningsStackParamList>();
const SessionsStack = createNativeStackNavigator<CHWSessionsStackParamList>();

function DashboardStackNavigator(): React.JSX.Element {
  return (
    <DashboardStack.Navigator screenOptions={{ headerShown: false }}>
      <DashboardStack.Screen name="Dashboard" component={CHWDashboardScreen} />
      <DashboardStack.Screen name="Intake" component={CHWIntakeScreen} />
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

// ─── Navigator ────────────────────────────────────────────────────────────────

export function CHWTabNavigator(): React.JSX.Element {
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
          // iOS shadow on the tab bar
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
      <Tab.Screen
        name="DashboardStack"
        component={DashboardStackNavigator}
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color, size }) => (
            <LayoutDashboard color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="Requests"
        component={CHWRequestsScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Inbox color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="SessionsStack"
        component={SessionsStackNavigator}
        options={{
          title: 'Sessions',
          tabBarIcon: ({ color, size }) => (
            <ClipboardList color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="Calendar"
        component={CHWCalendarScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <CalendarDays color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="EarningsStack"
        component={EarningsStackNavigator}
        options={{
          title: 'Earnings',
          tabBarIcon: ({ color, size }) => (
            <DollarSign color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="Profile"
        component={CHWProfileScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <UserCircle color={color} size={size} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}
