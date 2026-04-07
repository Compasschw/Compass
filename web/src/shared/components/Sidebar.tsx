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
  LogOut,
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
 * Left-side navigation bar rendered on desktop (lg+).
 * Hides on mobile — BottomNav takes over at small breakpoints.
 */
export function Sidebar() {
  const { userRole, userName, logout } = useAuth();
  const navItems = userRole === 'chw' ? chwNav : memberNav;
  const roleLabel = userRole === 'chw' ? 'Health Worker' : 'Member';

  return (
    <aside
      className="hidden lg:flex flex-col w-60 shrink-0 bg-white border-r border-[#E5E7EB] min-h-screen"
      aria-label="Main navigation"
    >
      {/* Brand */}
      <div className="px-5 py-5 border-b border-[#E5E7EB]">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-[#00B050] flex items-center justify-center shrink-0">
            <span className="text-white font-bold text-sm">C</span>
          </div>
          <div>
            <p className="text-[#1A1A1A] font-semibold text-sm leading-none">
              CompassCHW
            </p>
            <p className="text-[#AAAAAA] text-xs mt-0.5">{roleLabel}</p>
          </div>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-3 py-4 space-y-1" aria-label="Primary">
        {navItems.map(({ label, to, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-[8px] text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-[#D0F0D0] text-[#00B050]'
                  : 'text-[#555555] hover:bg-[#F8FAFB] hover:text-[#1A1A1A]'
              }`
            }
          >
            <Icon size={18} aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* User footer */}
      <div className="px-3 py-4 border-t border-[#E5E7EB]">
        {userName && (
          <div className="flex items-center gap-2 px-3 py-2 mb-1">
            <div className="w-7 h-7 rounded-full bg-[#0077B6] flex items-center justify-center shrink-0">
              <span className="text-white text-xs font-semibold">
                {userName.charAt(0).toUpperCase()}
              </span>
            </div>
            <p className="text-sm text-[#1A1A1A] font-medium truncate">{userName}</p>
          </div>
        )}
        <button
          onClick={logout}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-[8px] text-sm font-medium text-[#555555] hover:bg-[#F8FAFB] hover:text-[#1A1A1A] transition-colors"
        >
          <LogOut size={18} aria-hidden="true" />
          Log out
        </button>
      </div>
    </aside>
  );
}
