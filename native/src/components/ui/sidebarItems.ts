/**
 * sidebarItems — static navigation configuration for CHW and Member roles.
 *
 * Each item maps a unique key to a display label, a lucide-react-native icon
 * name, and a React Navigation route name. The optional `badgeKey` references
 * a key in the `badges` record passed to DashboardSidebar, allowing live
 * notification counts (unread messages, wellness points, etc.) to decorate
 * nav items without coupling this config to any store.
 *
 * Intentionally `as const` so TypeScript infers the literal union types for
 * `key`, `icon`, and `route` — callers can use `SidebarItem['route']` as a
 * type-safe route name.
 */

// ─── CHW navigation ───────────────────────────────────────────────────────────

export const chwSidebarItems = [
  { key: 'dashboard',    label: 'Dashboard',          icon: 'layout-dashboard', route: 'CHWDashboard'         },
  { key: 'members',      label: 'Members',            icon: 'users',            route: 'CHWMembers'           },
  { key: 'memberProfile',label: 'Member Profile',     icon: 'user-round',       route: 'CHWMemberProfile'     },
  { key: 'journeys',     label: 'Journeys',           icon: 'route',            route: 'CHWJourneys'          },
  { key: 'messages',     label: 'Messages',           icon: 'message-square',   route: 'CHWMessages',          badgeKey: 'unreadMessages' },
  { key: 'appointments', label: 'Appointments',       icon: 'calendar',         route: 'CHWAppointments'      },
  { key: 'resources',    label: 'Resources',          icon: 'folder-open',      route: 'CHWResources'         },
  { key: 'documents',    label: 'Documents',          icon: 'file-text',        route: 'CHWDocuments'         },
  { key: 'earnings',     label: 'Earnings',           icon: 'dollar-sign',      route: 'CHWEarnings'          },
  { key: 'reports',      label: 'Reports',            icon: 'bar-chart-3',      route: 'CHWReports'           },
  { key: 'partners',     label: 'Community Partners', icon: 'building-2',       route: 'CHWCommunityPartners' },
  { key: 'settings',     label: 'Settings',           icon: 'settings',         route: 'CHWSettings'          },
] as const;

// ─── Member navigation ────────────────────────────────────────────────────────

export const memberSidebarItems = [
  { key: 'home',         label: 'Home',          icon: 'home',           route: 'MemberHome'         },
  { key: 'myChw',        label: 'My CHW',        icon: 'user-round',     route: 'MemberMyCHW'        },
  { key: 'journey',      label: 'My Journey',    icon: 'route',          route: 'MemberJourney'      },
  { key: 'messages',     label: 'Messages',      icon: 'message-square', route: 'MemberMessages',     badgeKey: 'unreadMessages' },
  { key: 'appointments', label: 'Appointments',  icon: 'calendar',       route: 'MemberAppointments' },
  { key: 'resources',    label: 'Resources',     icon: 'folder-open',    route: 'MemberResources'    },
  { key: 'rewards',      label: 'Rewards',       icon: 'gift',           route: 'MemberRewards',      badgeKey: 'wellnessPoints' },
  { key: 'documents',    label: 'My Documents',  icon: 'file-text',      route: 'MemberDocuments'    },
  { key: 'settings',     label: 'Settings',      icon: 'settings',       route: 'MemberSettings'     },
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Union of all CHW sidebar items — useful for type-safe `activeKey` props. */
export type CHWSidebarItem = (typeof chwSidebarItems)[number];

/** Union of all Member sidebar items. */
export type MemberSidebarItem = (typeof memberSidebarItems)[number];

/**
 * Single sidebar item — use this for props that accept items from either role.
 * Note: TypeScript infers a union, so `item.key` is narrowed correctly when
 * you use type guards on `route`.
 */
export type SidebarItem = (typeof chwSidebarItems)[number];
