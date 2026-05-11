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
  Route,
  FolderOpen,
  FileText,
  Settings as SettingsIcon,
} from 'lucide-react-native';

import { SidebarProvider, useSidebar } from './SidebarContext';
import { CollapsibleDrawerContent } from './CollapsibleDrawerContent';

import { colors } from '../theme/colors';
import { fonts } from '../theme/typography';
import { MemberHomeScreen } from '../screens/member/MemberHomeScreen';
import { MemberFindScreen } from '../screens/member/MemberFindScreen';
import { MemberFacingCHWProfileScreen } from '../screens/member/MemberFacingCHWProfileScreen';
import { MemberSessionsScreen } from '../screens/member/MemberSessionsScreen';
import { MemberCalendarScreen } from '../screens/member/MemberCalendarScreen';
import { MemberRoadmapScreen } from '../screens/member/MemberRoadmapScreen';
import { MemberProfileScreen } from '../screens/member/MemberProfileScreen';
import { MemberRewardsScreen } from '../screens/member/MemberRewardsScreen';
import { MemberJourneyScreen } from '../screens/member/MemberJourneyScreen';
import { MemberResourcesScreen } from '../screens/member/MemberResourcesScreen';
import { MemberDocumentsScreen } from '../screens/member/MemberDocumentsScreen';
import { MemberSettingsScreen } from '../screens/member/MemberSettingsScreen';

// ─── Navigator param lists ────────────────────────────────────────────────────

export type MemberHomeStackParamList = {
  HomeMain: undefined;
  Rewards: undefined;
};

/**
 * Stack param list for the Find CHW tab.
 * CHWProfile is a stack screen (not a tab) pushed from MemberFindScreen.
 * Registered here so navigation.navigate('CHWProfile', { chwId }) works from
 * any screen inside this stack (Find list, session card, chat header).
 */
export type MemberFindStackParamList = {
  FindMain: undefined;
  CHWProfile: { chwId: string };
};

export type MemberTabParamList = {
  Home: undefined;
  FindCHW: undefined;
  Sessions: undefined;
  Calendar: undefined;
  Roadmap: undefined;
  Profile: undefined;
  // New (Wave 2) sidebar destinations.
  MemberJourney: undefined;
  MemberResources: undefined;
  MemberDocuments: undefined;
  MemberSettings: undefined;
};

const Tab = createBottomTabNavigator<MemberTabParamList>();
const Drawer = createDrawerNavigator<MemberTabParamList>();
const HomeStack = createNativeStackNavigator<MemberHomeStackParamList>();
const FindStack = createNativeStackNavigator<MemberFindStackParamList>();

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

/**
 * Nested stack inside the Find CHW tab.
 *
 * FindMain is the root (MemberFindScreen — the CHW list + map).
 * CHWProfile is a stack screen pushed on top when a member taps "View Profile"
 * on any CHW card. It is NOT a tab — it belongs here so it can be pushed from
 * MemberFindScreen and from future entry points (session card, chat header)
 * inside the same stack without touching the tab bar.
 */
function FindStackNavigator(): React.JSX.Element {
  return (
    <FindStack.Navigator screenOptions={{ headerShown: false }}>
      <FindStack.Screen name="FindMain" component={MemberFindScreen} />
      <FindStack.Screen name="CHWProfile" component={MemberFacingCHWProfileScreen} />
    </FindStack.Navigator>
  );
}

// ─── Screen registry (shared across both variants) ────────────────────────────

interface ScreenSpec {
  name: keyof MemberTabParamList;
  title: string;
  component: React.ComponentType;
  icon: React.ComponentType<{ color: string; size: number }>;
  /**
   * For tabs whose component is a nested stack, this is the root screen
   * inside that stack. Tapping the tab when it's already focused will
   * navigate back to this screen. See CHWTabNavigator for the same fix.
   */
  rootScreen?: string;
}

const SCREENS: ScreenSpec[] = [
  { name: 'Home',            title: 'Home',         component: HomeStackNavigator,    icon: Home,         rootScreen: 'HomeMain' },
  // FindCHW mounts a nested stack so tapping a CHW card pushes CHWProfile
  // without affecting the tab bar. rootScreen resets the stack to FindMain
  // when the user taps the active tab.
  { name: 'FindCHW',         title: 'My CHW',       component: FindStackNavigator,    icon: Search,       rootScreen: 'FindMain' },
  { name: 'MemberJourney',   title: 'My Journey',   component: MemberJourneyScreen,   icon: Route },
  { name: 'Sessions',        title: 'Messages',     component: MemberSessionsScreen,  icon: ClipboardList },
  { name: 'Calendar',        title: 'Appointments', component: MemberCalendarScreen,  icon: CalendarDays },
  { name: 'MemberResources', title: 'Resources',    component: MemberResourcesScreen, icon: FolderOpen },
  { name: 'MemberDocuments', title: 'My Documents', component: MemberDocumentsScreen, icon: FileText },
  { name: 'Roadmap',         title: 'Roadmap',      component: MemberRoadmapScreen,   icon: Map },
  { name: 'Profile',         title: 'Profile',      component: MemberProfileScreen,   icon: UserCircle },
  { name: 'MemberSettings',  title: 'Settings',     component: MemberSettingsScreen,  icon: SettingsIcon },
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
function MemberWebDrawerNavigatorInner(): React.JSX.Element {
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
              marginLeft: -8,
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
 * Each navigator owns its own provider so CHW and Member collapsed states are
 * independent (the user may want one open and one closed between role switches,
 * though in practice they'll never be mounted simultaneously).
 */
function MemberWebDrawerNavigator(): React.JSX.Element {
  return (
    <SidebarProvider>
      <MemberWebDrawerNavigatorInner />
    </SidebarProvider>
  );
}

// ─── Public entry — picks the right shell per platform ────────────────────────

export function MemberTabNavigator(): React.JSX.Element {
  if (Platform.OS === 'web') {
    return <MemberWebDrawerNavigator />;
  }
  return <MemberBottomTabNavigator />;
}
