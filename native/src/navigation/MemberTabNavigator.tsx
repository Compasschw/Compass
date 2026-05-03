/**
 * Member navigator — adaptive shell for Medi-Cal Member users.
 *
 * - Native (iOS/Android): bottom-tab bar (mobile-first ergonomics).
 * - Web: permanent left drawer (desktop ergonomics — mirrors the CHW
 *   sidebar so member-side and provider-side feel consistent).
 *
 * Both variants register the same screens and the same param list, so any
 * `navigation.navigate(...)` call written against `MemberTabParamList`
 * works identically on every platform.
 */

import React from 'react';
import { Platform } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
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
import { MemberRewardsScreen } from '../screens/member/MemberRewardsScreen';

// ─── Navigator param lists ────────────────────────────────────────────────────

export type MemberHomeStackParamList = {
  HomeMain: undefined;
  Rewards: undefined;
};

export type MemberTabParamList = {
  Home: undefined;
  FindCHW: undefined;
  Sessions: undefined;
  Calendar: undefined;
  Roadmap: undefined;
  Profile: undefined;
};

const Tab = createBottomTabNavigator<MemberTabParamList>();
const Drawer = createDrawerNavigator<MemberTabParamList>();
const HomeStack = createNativeStackNavigator<MemberHomeStackParamList>();

/**
 * Nested stack inside the Home tab so we can push MemberRewardsScreen on
 * top (per JT Figma feedback: Redeem Rewards opens its own screen).
 */
function HomeStackNavigator(): React.JSX.Element {
  return (
    <HomeStack.Navigator screenOptions={{ headerShown: false }}>
      <HomeStack.Screen name="HomeMain" component={MemberHomeScreen} />
      <HomeStack.Screen name="Rewards" component={MemberRewardsScreen} />
    </HomeStack.Navigator>
  );
}

// ─── Screen registry (shared across both variants) ────────────────────────────

interface ScreenSpec {
  name: keyof MemberTabParamList;
  title: string;
  component: React.ComponentType;
  icon: React.ComponentType<{ color: string; size: number }>;
}

const SCREENS: ScreenSpec[] = [
  { name: 'Home',     title: 'Home',     component: HomeStackNavigator,    icon: Home },
  { name: 'FindCHW',  title: 'Find CHW', component: MemberFindScreen,      icon: Search },
  { name: 'Sessions', title: 'Sessions', component: MemberSessionsScreen,  icon: ClipboardList },
  { name: 'Calendar', title: 'Calendar', component: MemberCalendarScreen,  icon: CalendarDays },
  { name: 'Roadmap',  title: 'Roadmap',  component: MemberRoadmapScreen,   icon: Map },
  { name: 'Profile',  title: 'Profile',  component: MemberProfileScreen,   icon: UserCircle },
];

// ─── Native variant: bottom tab bar ───────────────────────────────────────────

function MemberBottomTabNavigator(): React.JSX.Element {
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

function MemberWebDrawerNavigator(): React.JSX.Element {
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
          marginLeft: -8,
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

export function MemberTabNavigator(): React.JSX.Element {
  if (Platform.OS === 'web') {
    return <MemberWebDrawerNavigator />;
  }
  return <MemberBottomTabNavigator />;
}
