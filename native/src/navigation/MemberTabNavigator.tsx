/**
 * Bottom-tab navigator for Member users.
 *
 * Tabs: Home, Find CHW, Sessions, Calendar, Roadmap, Profile
 */

import React from 'react';
import { Platform } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  Home,
  Search,
  ClipboardList,
  CalendarDays,
  Map,
  UserCircle,
} from 'lucide-react-native';

import { colors } from '../theme/colors';
import { fonts } from '../theme/typography';
import { MemberHomeScreen } from '../screens/member/MemberHomeScreen';
import { MemberFindScreen } from '../screens/member/MemberFindScreen';
import { MemberSessionsScreen } from '../screens/member/MemberSessionsScreen';
import { MemberCalendarScreen } from '../screens/member/MemberCalendarScreen';
import { MemberRoadmapScreen } from '../screens/member/MemberRoadmapScreen';
import { MemberProfileScreen } from '../screens/member/MemberProfileScreen';

// ─── Navigator param list ─────────────────────────────────────────────────────

export type MemberTabParamList = {
  Home: undefined;
  FindCHW: undefined;
  Sessions: undefined;
  Calendar: undefined;
  Roadmap: undefined;
  Profile: undefined;
};

const Tab = createBottomTabNavigator<MemberTabParamList>();

// ─── Navigator ────────────────────────────────────────────────────────────────

export function MemberTabNavigator(): React.JSX.Element {
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
        name="Home"
        component={MemberHomeScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Home color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="FindCHW"
        component={MemberFindScreen}
        options={{
          title: 'Find CHW',
          tabBarIcon: ({ color, size }) => (
            <Search color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="Sessions"
        component={MemberSessionsScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <ClipboardList color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="Calendar"
        component={MemberCalendarScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <CalendarDays color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="Roadmap"
        component={MemberRoadmapScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Map color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="Profile"
        component={MemberProfileScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <UserCircle color={color} size={size} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}
