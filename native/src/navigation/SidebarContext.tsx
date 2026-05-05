/**
 * SidebarContext — shared collapsed/expanded state for the web permanent drawer.
 *
 * Persists the user's preference across page reloads via localStorage
 * (key: `compass.sidebar.collapsed`). The context is no-op on native
 * (iOS/Android) — the bottom-tab variant never mounts this provider in a
 * meaningful path, but the types are still safe to use.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Platform } from 'react-native';

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'compass.sidebar.collapsed';

/** Width of the fully-expanded sidebar (px). */
export const SIDEBAR_EXPANDED_WIDTH = 224;

/** Width of the icon-only rail when collapsed (px). */
export const SIDEBAR_COLLAPSED_WIDTH = 64;

/** CSS transition duration for the width animation (ms). */
export const SIDEBAR_TRANSITION_MS = 200;

// ─── Types ────────────────────────────────────────────────────────────────────

interface SidebarContextValue {
  /** Whether the sidebar is currently collapsed to icon-rail mode. */
  isCollapsed: boolean;
  /** Toggle collapsed ↔ expanded and persist the new state. */
  toggle: () => void;
  /** Current drawer width — use this as `drawerStyle.width`. */
  drawerWidth: number;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const SidebarContext = createContext<SidebarContextValue>({
  isCollapsed: false,
  toggle: () => undefined,
  drawerWidth: SIDEBAR_EXPANDED_WIDTH,
});

// ─── Persistence helpers ──────────────────────────────────────────────────────

/**
 * Read the persisted collapsed preference from localStorage.
 * Returns `false` (expanded) on native or when localStorage is unavailable.
 */
function readPersistedCollapsed(): boolean {
  if (Platform.OS !== 'web') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    // localStorage blocked (private browsing policy, etc.) — degrade gracefully.
    return false;
  }
}

/**
 * Write the collapsed preference to localStorage.
 * No-ops on native or when localStorage is unavailable.
 */
function writePersistedCollapsed(collapsed: boolean): void {
  if (Platform.OS !== 'web') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(collapsed));
  } catch {
    // Intentionally swallowed — preference loss is acceptable over a crash.
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

interface SidebarProviderProps {
  children: React.ReactNode;
}

/**
 * Wrap the web drawer navigator with this provider so the
 * `CollapsibleDrawerContent` and `screenOptions` can read and mutate
 * `isCollapsed` from one shared source of truth.
 */
export function SidebarProvider({ children }: SidebarProviderProps): React.JSX.Element {
  const [isCollapsed, setIsCollapsed] = useState<boolean>(readPersistedCollapsed);

  // On web, sync state → localStorage whenever it changes.
  useEffect(() => {
    writePersistedCollapsed(isCollapsed);
  }, [isCollapsed]);

  const toggle = useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  const drawerWidth = isCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH;

  const value = useMemo<SidebarContextValue>(
    () => ({ isCollapsed, toggle, drawerWidth }),
    [isCollapsed, toggle, drawerWidth],
  );

  return (
    <SidebarContext.Provider value={value}>
      {children}
    </SidebarContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Consume the sidebar context. Must be called inside a `SidebarProvider`.
 *
 * @throws If used outside a `SidebarProvider` in a development build.
 */
export function useSidebar(): SidebarContextValue {
  return useContext(SidebarContext);
}
