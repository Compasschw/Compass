import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  ClipboardList,
  Calendar,
  CalendarDays,
  DollarSign,
  User,
  Home,
  Search,
  Map,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../../features/auth/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
}

// ─── Nav configs ──────────────────────────────────────────────────────────────

const chwNav: NavItem[] = [
  { label: 'Dashboard', to: '/chw/dashboard', icon: LayoutDashboard },
  { label: 'Requests', to: '/chw/requests', icon: ClipboardList },
  { label: 'Sessions', to: '/chw/sessions', icon: Calendar },
  { label: 'Calendar', to: '/chw/calendar', icon: CalendarDays },
  { label: 'Earnings', to: '/chw/earnings', icon: DollarSign },
  { label: 'Profile', to: '/chw/profile', icon: User },
];

const memberNav: NavItem[] = [
  { label: 'Home', to: '/member/home', icon: Home },
  { label: 'Find CHW', to: '/member/find', icon: Search },
  { label: 'Sessions', to: '/member/sessions', icon: Calendar },
  { label: 'Calendar', to: '/member/calendar', icon: CalendarDays },
  { label: 'Roadmap', to: '/member/roadmap', icon: Map },
  { label: 'Profile', to: '/member/profile', icon: User },
];

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Fixed bottom tab bar shown only on mobile (lg: hidden).
 * Mirrors the Sidebar nav items with icon-only layout.
 */
export function BottomNav() {
  const { userRole } = useAuth();
  const navItems = userRole === 'chw' ? chwNav : memberNav;

  return (
    <nav
      className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-[#E5E7EB] safe-area-inset-bottom"
      aria-label="Mobile navigation"
    >
      <div className="flex items-stretch">
        {navItems.map(({ label, to, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center justify-center py-1.5 gap-0.5 text-[10px] font-medium transition-colors ${
                isActive
                  ? 'text-[#00B050]'
                  : 'text-[#AAAAAA] hover:text-[#555555]'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon size={20} aria-hidden="true" strokeWidth={isActive ? 2.5 : 1.75} />
                <span>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
