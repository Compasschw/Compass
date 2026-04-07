import { LayoutDashboard, ClipboardList, Calendar, DollarSign, User, Home, Search, Map } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type TabRole = 'chw' | 'member';

interface TabItem {
  id: string;
  label: string;
  Icon: LucideIcon;
  path: string;
}

interface IOSTabBarProps {
  role: TabRole;
  /** Current active tab path */
  activePath: string;
  onNavigate: (path: string) => void;
}

// ─── Tab Definitions ──────────────────────────────────────────────────────────

const CHW_TABS: TabItem[] = [
  { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard, path: '/chw/dashboard' },
  { id: 'requests', label: 'Requests', Icon: ClipboardList, path: '/chw/requests' },
  { id: 'sessions', label: 'Sessions', Icon: Calendar, path: '/chw/sessions' },
  { id: 'earnings', label: 'Earnings', Icon: DollarSign, path: '/chw/earnings' },
  { id: 'profile', label: 'Profile', Icon: User, path: '/chw/profile' },
];

const MEMBER_TABS: TabItem[] = [
  { id: 'home', label: 'Home', Icon: Home, path: '/member/home' },
  { id: 'find-chw', label: 'Find CHW', Icon: Search, path: '/member/find-chw' },
  { id: 'sessions', label: 'Sessions', Icon: Calendar, path: '/member/sessions' },
  { id: 'roadmap', label: 'Roadmap', Icon: Map, path: '/member/roadmap' },
  { id: 'profile', label: 'Profile', Icon: User, path: '/member/profile' },
];

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * iOS-style bottom tab bar with blurred background.
 * Active tab uses compass-green (#00B050), inactive uses iOS tertiary label gray.
 * Minimum 44pt touch target per iOS HIG.
 */
export function IOSTabBar({ role, activePath, onNavigate }: IOSTabBarProps) {
  const tabs = role === 'chw' ? CHW_TABS : MEMBER_TABS;

  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        zIndex: 40,
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        backgroundColor: 'rgba(249,249,249,0.94)',
        borderTop: '0.5px solid rgba(60,60,67,0.29)',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          height: '83px',
          paddingBottom: '24px', /* home indicator area */
        }}
      >
        {tabs.map((tab) => {
          const isActive = activePath === tab.path || activePath.startsWith(tab.path);
          return (
            <button
              key={tab.id}
              onClick={() => onNavigate(tab.path)}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '3px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '8px 4px 0',
                minHeight: '44px',
                color: isActive ? '#00B050' : '#8E8E93',
                fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <tab.Icon
                size={24}
                strokeWidth={isActive ? 2 : 1.5}
                color={isActive ? '#00B050' : '#8E8E93'}
              />
              <span
                style={{
                  fontSize: '10px',
                  fontWeight: isActive ? 600 : 400,
                  letterSpacing: '0.1px',
                  color: isActive ? '#00B050' : '#8E8E93',
                  lineHeight: 1,
                }}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
