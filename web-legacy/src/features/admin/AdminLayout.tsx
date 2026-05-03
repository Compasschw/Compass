import { type ReactNode } from 'react';
import { NavLink, useNavigate, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  HeartHandshake,
  ClipboardList,
  Calendar,
  FileText,
  LogOut,
  Mail,
  type LucideIcon,
} from 'lucide-react';
import { ADMIN_KEY_STORAGE, ADMIN_2FA_TOKEN_STORAGE } from './adminApi';

// ─── Nav config ───────────────────────────────────────────────────────────────

interface AdminNavItem {
  label: string;
  to: string;
  icon: LucideIcon;
}

const adminNav: AdminNavItem[] = [
  { label: 'Overview', to: '/admin', icon: LayoutDashboard },
  { label: 'CHWs', to: '/admin/chws', icon: HeartHandshake },
  { label: 'Members', to: '/admin/members', icon: Users },
  { label: 'Requests', to: '/admin/requests', icon: ClipboardList },
  { label: 'Sessions', to: '/admin/sessions', icon: Calendar },
  { label: 'Claims', to: '/admin/claims', icon: FileText },
  { label: 'Waitlist', to: '/admin/waitlist', icon: Mail },
];

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function AdminSidebar() {
  const navigate = useNavigate();

  function handleLogout() {
    sessionStorage.removeItem(ADMIN_KEY_STORAGE);
    sessionStorage.removeItem(ADMIN_2FA_TOKEN_STORAGE);
    navigate('/admin/login', { replace: true });
  }

  return (
    <aside
      className="hidden md:flex flex-col w-56 shrink-0 bg-white border-r border-[rgba(44,62,45,0.1)] min-h-screen"
      aria-label="Admin navigation"
    >
      {/* Brand */}
      <div className="px-5 py-5 border-b border-[rgba(44,62,45,0.1)]">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-[#2C3E2D] flex items-center justify-center shrink-0">
            <span className="text-white font-bold text-sm" aria-hidden="true">C</span>
          </div>
          <div>
            <p className="text-[#2C3E2D] font-semibold text-sm leading-none">
              CompassCHW
            </p>
            <p className="text-[#8B9B8D] text-xs mt-0.5">Admin</p>
          </div>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-3 py-4 space-y-1" aria-label="Admin primary">
        {adminNav.map(({ label, to, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/admin'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-[12px] text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-[rgba(107,143,113,0.15)] text-[#6B8F71]'
                  : 'text-[#555555] hover:bg-[#FBF7F0] hover:text-[#2C3E2D]'
              }`
            }
          >
            <Icon size={18} aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Logout */}
      <div className="px-3 py-4 border-t border-[rgba(44,62,45,0.1)]">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-[12px] text-sm font-medium text-[#555555] hover:bg-[#FBF7F0] hover:text-[#2C3E2D] transition-colors"
          aria-label="Log out of admin dashboard"
        >
          <LogOut size={18} aria-hidden="true" />
          Log out
        </button>
      </div>
    </aside>
  );
}

// ─── Mobile top bar ───────────────────────────────────────────────────────────

function AdminMobileNav() {
  const navigate = useNavigate();

  function handleLogout() {
    sessionStorage.removeItem(ADMIN_KEY_STORAGE);
    sessionStorage.removeItem(ADMIN_2FA_TOKEN_STORAGE);
    navigate('/admin/login', { replace: true });
  }

  return (
    <header className="md:hidden bg-white border-b border-[rgba(44,62,45,0.1)] px-4 py-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#2C3E2D] flex items-center justify-center">
            <span className="text-white font-bold text-xs" aria-hidden="true">C</span>
          </div>
          <span className="text-[#2C3E2D] font-semibold text-sm">Admin</span>
        </div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-1.5 text-sm text-[#555555] hover:text-[#2C3E2D] transition-colors"
          aria-label="Log out of admin dashboard"
        >
          <LogOut size={15} aria-hidden="true" />
          Log out
        </button>
      </div>
      <nav
        className="flex gap-1 overflow-x-auto pb-1 scrollbar-hide"
        aria-label="Admin mobile navigation"
      >
        {adminNav.map(({ label, to, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/admin'}
            className={({ isActive }) =>
              `flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] text-xs font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? 'bg-[rgba(107,143,113,0.15)] text-[#6B8F71]'
                  : 'text-[#555555] hover:bg-[#FBF7F0] hover:text-[#2C3E2D]'
              }`
            }
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}

// ─── Layout shell ─────────────────────────────────────────────────────────────

/**
 * Admin layout shell — wraps all admin sub-pages.
 * Desktop: sidebar on left, content on right.
 * Mobile:  horizontal scrollable nav at top.
 *
 * Child routes are rendered via <Outlet />.
 */
export function AdminLayout({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-[#FBF7F0]">
      <AdminSidebar />

      <div className="flex-1 flex flex-col min-w-0">
        <AdminMobileNav />
        <main
          className="flex-1 overflow-y-auto px-4 lg:px-8 py-6"
          id="admin-main-content"
        >
          {children ?? <Outlet />}
        </main>
      </div>
    </div>
  );
}
