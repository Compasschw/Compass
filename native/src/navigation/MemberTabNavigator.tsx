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
import type { NavigatorScreenParams } from '@react-navigation/native';
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
  Gift,
  Settings as SettingsIcon,
} from 'lucide-react-native';

import { SidebarProvider, useSidebar } from './SidebarContext';
import { CollapsibleDrawerContent } from './CollapsibleDrawerContent';
import { withErrorBoundary } from '../components/shared/ErrorBoundary';

import { colors } from '../theme/colors';
import { fonts } from '../theme/typography';
import { MemberHomeScreen } from '../screens/member/MemberHomeScreen';
import { MemberFindScreen } from '../screens/member/MemberFindScreen';
import { MyCHWScreen } from '../screens/member/MyCHWScreen';
import { MemberFacingCHWProfileScreen } from '../screens/member/MemberFacingCHWProfileScreen';
import { MemberSessionsScreen } from '../screens/member/MemberSessionsScreen';
import { MemberMessagesScreen } from '../screens/member/MemberMessagesScreen';
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
  // Explicit "find a different / new CHW" entry point. FindMain auto-renders
  // the existing CHW's profile when the member has any sessions, so members
  // can't reach the find/match flow once assigned. This route bypasses that
  // gate (used by the Reassign button on MemberFacingCHWProfileScreen + the
  // Appointments "Find a CHW" CTAs).
  FindList: undefined;
};

export type MemberTabParamList = {
  Home: undefined;
  /**
   * Nested Find CHW stack. `NavigatorScreenParams` lets callers deep-link to a
   * specific screen inside the stack (e.g. `navigate('FindCHW', { screen:
   * 'FindList' })`); plain `navigate('FindCHW')` continues to work unchanged.
   */
  FindCHW: NavigatorScreenParams<MemberFindStackParamList> | undefined;
  /**
   * Optional route params supported by MemberMessagesScreen (T20).
   * - `chwId`: when provided the thread for that CHW is pre-selected.
   * - `autoCall`: when true + chwId is set, the masked-number call sequence
   *   fires on mount (mirrors the CHW-side T15 autoCall contract).
   * Both params are optional so callers that navigate without params continue
   * to work exactly as before.
   */
  Sessions: { chwId?: string; autoCall?: boolean } | undefined;
  Calendar: undefined;
  Roadmap: undefined;
  Profile: undefined;
  // New (Wave 2) sidebar destinations.
  /**
   * Optional `focusJourneyId` — when present MemberJourneyScreen scrolls /
   * highlights that specific journey on mount. Supplied by MemberHomeScreen
   * journey cards so tapping a card deep-links directly to that journey.
   */
  MemberJourney: { focusJourneyId?: string } | undefined;
  MemberResources: undefined;
  MemberRewards: undefined;
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
      <HomeStack.Screen name="HomeMain" component={withErrorBoundary(MemberHomeScreen)} />
      <HomeStack.Screen name="Rewards" component={withErrorBoundary(MemberRewardsScreen)} />
    </HomeStack.Navigator>
  );
}

/**
 * Nested stack inside the Find CHW tab.
 *
 * FindMain is the root (MyCHWScreen — renders the assigned CHW's profile if
 * the member has had a session, else falls back to MemberFindScreen for the
 * find/match flow). CHWProfile is a stack screen pushed on top when a member
 * taps "View Profile" on a different CHW card from inside the find list.
 * Registering both here keeps `navigation.navigate('CHWProfile', { chwId })`
 * working from any deep entry point inside the stack (find list, session
 * card, chat header) without touching the tab bar.
 */
function FindStackNavigator(): React.JSX.Element {
  return (
    <FindStack.Navigator screenOptions={{ headerShown: false }}>
      <FindStack.Screen name="FindMain" component={withErrorBoundary(MyCHWScreen)} />
      <FindStack.Screen name="CHWProfile" component={withErrorBoundary(MemberFacingCHWProfileScreen)} />
      <FindStack.Screen name="FindList" component={withErrorBoundary(MemberFindScreen)} />
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
  {
    name: 'Sessions',
    title: 'Messages',
    // Web: new single-thread MemberMessagesScreen; Native: existing sessions list.
    component: Platform.OS === 'web' ? MemberMessagesScreen : MemberSessionsScreen,
    icon: ClipboardList,
  },
  { name: 'Calendar',        title: 'Appointments', component: MemberCalendarScreen,  icon: CalendarDays },
  { name: 'MemberResources', title: 'Resources',    component: MemberResourcesScreen, icon: FolderOpen },
  { name: 'MemberRewards',   title: 'Rewards',      component: MemberRewardsScreen,   icon: Gift },
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
          component={withErrorBoundary(component)}
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
      // Drawer chrome is hidden on web — every screen wraps in <AppShell>
      // which owns the visible sidebar. The drawer is still present so route
      // registration works for navigation.navigate(...) calls.
      drawerContent={() => null}
      screenOptions={{
        headerShown: false,
        drawerType: 'permanent',
        drawerStyle: {
          width: 0,
          borderRightWidth: 0,
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
          component={withErrorBoundary(component)}
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
