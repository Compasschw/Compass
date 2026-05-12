/**
 * DashboardSidebar — dark-sage permanent left sidebar for web-only dashboard views.
 *
 * Returns null on iOS/Android — the native app uses the existing drawer
 * navigator. On web, renders a full-height fixed sidebar with:
 *   - Brand block (compasschw + role tagline)
 *   - Navigation items with active highlight and badge support
 *   - Optional "Switch to X view" link
 *   - User avatar block at the bottom
 *
 * Design tokens: dark sage `#134e36` → `#0f3d2a` gradient, sidebar text
 * `#a7d4be`, active item white background + `#0f3d2a` text.
 *
 * Navigation is performed by calling `useNavigation()` from
 * `@react-navigation/native` — this component MUST be rendered inside a
 * navigation context on web.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Platform,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NavigationProp, ParamListBase } from '@react-navigation/native';

// Lucide icons used by sidebar items
import {
  LayoutDashboard,
  Users,
  UserRound,
  Route,
  MessageSquare,
  Calendar,
  FolderOpen,
  FileText,
  DollarSign,
  BarChart3,
  Building2,
  Settings,
  Home,
  Gift,
  ArrowRightLeft,
} from 'lucide-react-native';

import { colors as tokens } from '../../theme/tokens';
import { chwSidebarItems, memberSidebarItems } from './sidebarItems';
import type { CHWSidebarItem, MemberSidebarItem } from './sidebarItems';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserBlock {
  /** 1–2 character initials for the avatar circle. */
  initials: string;
  /** Full display name. */
  name: string;
  /** Role label shown below the name. */
  role: string;
}

export interface DashboardSidebarProps {
  /** Navigation items array — pass `chwSidebarItems` or `memberSidebarItems`. */
  items: typeof chwSidebarItems | typeof memberSidebarItems;
  /**
   * Role of the currently signed-in user. Drives the brand tagline below
   * the wordmark ("Medi-Cal Member" vs. "Member"). Inferred from the items
   * array if not passed (chwSidebarItems → 'chw'; memberSidebarItems → 'member').
   */
  role?: 'chw' | 'member';
  /** Key of the currently active screen. */
  activeKey: string;
  /**
   * Badge values keyed by `badgeKey` from sidebar item definitions.
   * e.g. `{ unreadMessages: 3, wellnessPoints: 120 }`
   */
  badges?: Record<string, string | number>;
  /** User identity displayed in the bottom avatar block. */
  userBlock: UserBlock;
  /** Label for the optional cross-role switch link, e.g. "Switch to Member view". */
  switchViewLabel?: string;
  /** Route name to navigate when the switch link is pressed. */
  switchViewRoute?: string;
}

// ─── Icon resolver ────────────────────────────────────────────────────────────

/**
 * Maps the string icon names used in sidebarItems to lucide-react-native
 * components. Any unmapped name falls back to a settings icon.
 */
function resolveIcon(
  iconName: string,
  color: string,
  size: number,
): React.ReactNode {
  const props = { color, size, strokeWidth: 1.75 };

  switch (iconName) {
    case 'layout-dashboard': return <LayoutDashboard {...props} />;
    case 'users':            return <Users           {...props} />;
    case 'user-round':       return <UserRound       {...props} />;
    case 'route':            return <Route           {...props} />;
    case 'message-square':   return <MessageSquare   {...props} />;
    case 'calendar':         return <Calendar        {...props} />;
    case 'folder-open':      return <FolderOpen      {...props} />;
    case 'file-text':        return <FileText        {...props} />;
    case 'dollar-sign':      return <DollarSign      {...props} />;
    case 'bar-chart-3':      return <BarChart3       {...props} />;
    case 'building-2':       return <Building2       {...props} />;
    case 'home':             return <Home            {...props} />;
    case 'gift':             return <Gift            {...props} />;
    case 'settings':
    default:                 return <Settings        {...props} />;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Web-only permanent sidebar. Returns `null` on native platforms.
 */
export function DashboardSidebar({
  items,
  role,
  activeKey,
  badges = {},
  userBlock,
  switchViewLabel,
  switchViewRoute,
}: DashboardSidebarProps): React.JSX.Element | null {
  // Guard: sidebar renders on web only.
  if (Platform.OS !== 'web') {
    return null;
  }

  return (
    <SidebarContent
      items={items}
      role={role}
      activeKey={activeKey}
      badges={badges}
      userBlock={userBlock}
      switchViewLabel={switchViewLabel}
      switchViewRoute={switchViewRoute}
    />
  );
}

// ─── Inner component (always rendered inside navigation context on web) ────────

function SidebarContent({
  items,
  role,
  activeKey,
  badges,
  userBlock,
  switchViewLabel,
  switchViewRoute,
}: DashboardSidebarProps): React.JSX.Element {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();

  // Detect role from explicit prop first, then by reference equality with the
  // shared item arrays. Reference equality is reliable here because every
  // call site passes one of the two `as const` exports — not a derived array.
  const detectedRole: 'chw' | 'member' =
    role ?? (items === chwSidebarItems ? 'chw' : 'member');
  const roleTagline = detectedRole === 'chw' ? 'CHW Portal' : 'Member Portal';

  return (
    <View style={styles.sidebar}>
      {/* Brand block */}
      <View style={styles.brandBlock}>
        <Text style={styles.brandName}>compasschw</Text>
        <Text style={styles.brandTagline}>{roleTagline}</Text>
      </View>

      {/* Nav items */}
      <ScrollView
        style={styles.navScroll}
        contentContainerStyle={styles.navContent}
        showsVerticalScrollIndicator={false}
      >
        {(items as readonly (CHWSidebarItem | MemberSidebarItem)[]).map((item) => {
          const isActive = item.key === activeKey;
          const badgeValue =
            'badgeKey' in item && item.badgeKey !== undefined
              ? badges?.[item.badgeKey as string]
              : undefined;

          return (
            <NavItem
              key={item.key}
              label={item.label}
              iconName={item.icon}
              route={item.route}
              isActive={isActive}
              badgeValue={badgeValue}
              onPress={() => navigation.navigate(item.route)}
            />
          );
        })}

        {/* Switch-view link */}
        {switchViewLabel !== undefined && switchViewRoute !== undefined && (
          <SwitchViewLink
            label={switchViewLabel}
            onPress={() => {
              if (switchViewRoute !== undefined) {
                navigation.navigate(switchViewRoute);
              }
            }}
          />
        )}
      </ScrollView>

      {/* User avatar block */}
      <UserAvatarBlock userBlock={userBlock} />
    </View>
  );
}

// ─── Nav item ─────────────────────────────────────────────────────────────────

interface NavItemProps {
  label: string;
  iconName: string;
  route: string;
  isActive: boolean;
  badgeValue?: string | number;
  onPress: () => void;
}

function NavItem({
  label,
  iconName,
  isActive,
  badgeValue,
  onPress,
}: NavItemProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);

  const iconColor = isActive
    ? tokens.sidebarActiveText
    : tokens.sidebarText;

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole="menuitem"
      accessibilityLabel={label}
      accessibilityState={{ selected: isActive }}
      style={({ pressed }) => [
        styles.navItem,
        isActive && styles.navItemActive,
        !isActive && (hovered || pressed) && styles.navItemHover,
      ]}
    >
      {/* Icon */}
      <View style={styles.navIcon}>
        {resolveIcon(iconName, iconColor, 18)}
      </View>

      {/* Label */}
      <Text
        style={[
          styles.navLabel,
          isActive && styles.navLabelActive,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>

      {/* Badge */}
      {badgeValue !== undefined && String(badgeValue) !== '0' && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{String(badgeValue)}</Text>
        </View>
      )}
    </Pressable>
  );
}

// ─── Switch-view link ─────────────────────────────────────────────────────────

interface SwitchViewLinkProps {
  label: string;
  onPress: () => void;
}

function SwitchViewLink({
  label,
  onPress,
}: SwitchViewLinkProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole="link"
      accessibilityLabel={label}
      style={[styles.switchLink, hovered && styles.switchLinkHover]}
    >
      <ArrowRightLeft color={tokens.sidebarText} size={14} strokeWidth={1.75} />
      <Text style={styles.switchLinkLabel}>{label}</Text>
    </Pressable>
  );
}

// ─── User avatar block ────────────────────────────────────────────────────────

interface UserAvatarBlockProps {
  userBlock: UserBlock;
}

function UserAvatarBlock({ userBlock }: UserAvatarBlockProps): React.JSX.Element {
  return (
    <View style={styles.userBlock}>
      <View style={styles.avatar}>
        <Text style={styles.avatarInitials}>{userBlock.initials}</Text>
      </View>
      <View style={styles.userMeta}>
        <Text style={styles.userName} numberOfLines={1}>
          {userBlock.name}
        </Text>
        <Text style={styles.userRole} numberOfLines={1}>
          {userBlock.role}
        </Text>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const SIDEBAR_WIDTH = 240;

const styles = StyleSheet.create({
  sidebar: {
    width:           SIDEBAR_WIDTH,
    // Dark sage gradient approximated with solid start colour on RN; web will
    // apply the gradient via inline style override if needed.
    backgroundColor: tokens.sidebarBg,
    flexDirection:   'column',
    height:          '100%' as unknown as number,
    // Web: fixed left panel
    ...(Platform.OS === 'web'
      ? {
          position: 'fixed' as 'absolute',
          left:     0,
          top:      0,
          bottom:   0,
        }
      : {}),
  } as ViewStyle,

  // ── Brand ──

  brandBlock: {
    paddingHorizontal: 20,
    paddingTop:        28,
    paddingBottom:     20,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(167,212,190,0.15)',
  } as ViewStyle,

  brandName: {
    fontSize:      16,
    fontWeight:    '800',
    color:         '#ffffff',
    letterSpacing: -0.3,
    lineHeight:    20,
  } as TextStyle,

  brandTagline: {
    fontSize:   11,
    fontWeight: '500',
    color:      tokens.sidebarText,
    marginTop:  2,
    lineHeight: 14,
  } as TextStyle,

  // ── Nav scroll ──

  navScroll: {
    flex: 1,
  } as ViewStyle,

  navContent: {
    paddingHorizontal: 12,
    paddingVertical:   12,
    gap:               2,
  } as ViewStyle,

  // ── Nav item ──

  navItem: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            10,
    paddingVertical:  9,
    paddingHorizontal: 10,
    borderRadius:   10,
  } as ViewStyle,

  navItemActive: {
    backgroundColor: '#ffffff',
  } as ViewStyle,

  navItemHover: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  } as ViewStyle,

  navIcon: {
    width:          20,
    alignItems:     'center',
    justifyContent: 'center',
  } as ViewStyle,

  navLabel: {
    flex:       1,
    fontSize:   13,
    fontWeight: '500',
    color:      tokens.sidebarText,
    lineHeight: 18,
  } as TextStyle,

  navLabelActive: {
    fontWeight: '700',
    color:      tokens.sidebarActiveText,
  } as TextStyle,

  badge: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius:    999,
    paddingHorizontal: 6,
    paddingVertical:   1,
    minWidth:          18,
    alignItems:        'center',
  } as ViewStyle,

  badgeText: {
    fontSize:   10,
    fontWeight: '700',
    color:      '#ffffff',
    lineHeight: 14,
  } as TextStyle,

  // ── Switch-view link ──

  switchLink: {
    flexDirection:    'row',
    alignItems:       'center',
    gap:              8,
    paddingVertical:  8,
    paddingHorizontal: 10,
    borderRadius:     10,
    marginTop:        8,
  } as ViewStyle,

  switchLinkHover: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  } as ViewStyle,

  switchLinkLabel: {
    fontSize:   12,
    fontWeight: '500',
    color:      tokens.sidebarText,
    lineHeight: 16,
  } as TextStyle,

  // ── User block ──

  userBlock: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               10,
    paddingHorizontal: 16,
    paddingVertical:   16,
    borderTopWidth:    1,
    borderTopColor:    'rgba(167,212,190,0.15)',
  } as ViewStyle,

  avatar: {
    width:           36,
    height:          36,
    borderRadius:    18,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems:      'center',
    justifyContent:  'center',
  } as ViewStyle,

  avatarInitials: {
    fontSize:   13,
    fontWeight: '700',
    color:      '#ffffff',
    lineHeight: 18,
  } as TextStyle,

  userMeta: {
    flex: 1,
    gap:  1,
  } as ViewStyle,

  userName: {
    fontSize:   13,
    fontWeight: '600',
    color:      '#ffffff',
    lineHeight: 18,
  } as TextStyle,

  userRole: {
    fontSize:   11,
    fontWeight: '400',
    color:      tokens.sidebarText,
    lineHeight: 14,
  } as TextStyle,
});
