/**
 * AuthContext — authentication state for the entire app.
 *
 * Persists role/name/isAuthenticated in AsyncStorage (non-sensitive).
 * Tokens are managed via expo-secure-store inside the API client.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearTokens, getTokens } from '../api/client';
import { loginUser, logoutUser, registerUser } from '../api/auth';
import type { UserRole } from '../data/mock';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthState {
  isAuthenticated: boolean;
  userRole: UserRole | null;
  userName: string | null;
}

interface AuthContextValue extends AuthState {
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (
    email: string,
    password: string,
    name: string,
    role: string,
    phone?: string,
  ) => Promise<void>;
  /** Bypass API — set auth state directly from mock data (for demos). */
  loginMock: (role: UserRole, name: string) => Promise<void>;
  logout: () => Promise<void>;
}

// ─── Storage keys ─────────────────────────────────────────────────────────────

const AUTH_STATE_KEY = 'compass_auth_state';

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    userRole: null,
    userName: null,
  });
  const [isLoading, setIsLoading] = useState(true);

  // ── Hydrate from storage on mount ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const hydrate = async (): Promise<void> => {
      try {
        // Check both async storage (user metadata) and secure store (tokens).
        const [rawState, tokens] = await Promise.all([
          AsyncStorage.getItem(AUTH_STATE_KEY),
          getTokens(),
        ]);

        // Only restore session if both metadata and tokens are present.
        if (rawState && tokens?.access) {
          const stored = JSON.parse(rawState) as AuthState;
          if (!cancelled) {
            setAuthState({ ...stored, isAuthenticated: true });
          }
        }
      } catch {
        // Corrupted storage — start with a clean unauthenticated state.
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void hydrate();
    return () => { cancelled = true; };
  }, []);

  // ── Persist helper ─────────────────────────────────────────────────────────
  const persistAuthState = useCallback(async (state: AuthState): Promise<void> => {
    await AsyncStorage.setItem(AUTH_STATE_KEY, JSON.stringify(state));
  }, []);

  // ── login ──────────────────────────────────────────────────────────────────
  const login = useCallback(async (email: string, password: string): Promise<void> => {
    const response = await loginUser(email, password);

    const newState: AuthState = {
      isAuthenticated: true,
      userRole: response.role as UserRole,
      userName: response.name,
    };

    await persistAuthState(newState);
    setAuthState(newState);
  }, [persistAuthState]);

  // ── register ───────────────────────────────────────────────────────────────
  const register = useCallback(
    async (
      email: string,
      password: string,
      name: string,
      role: string,
      phone?: string,
    ): Promise<void> => {
      const response = await registerUser(email, password, name, role, phone);

      const newState: AuthState = {
        isAuthenticated: true,
        userRole: response.role as UserRole,
        userName: response.name,
      };

      await persistAuthState(newState);
      setAuthState(newState);
    },
    [persistAuthState],
  );

  // ── loginMock (demo/offline fallback) ───────────────────────────────────────
  const loginMock = useCallback(async (role: UserRole, name: string): Promise<void> => {
    const newState: AuthState = {
      isAuthenticated: true,
      userRole: role,
      userName: name,
    };
    await persistAuthState(newState);
    setAuthState(newState);
  }, [persistAuthState]);

  // ── logout ─────────────────────────────────────────────────────────────────
  const logout = useCallback(async (): Promise<void> => {
    try {
      const tokens = await getTokens();
      if (tokens?.refresh) {
        // Best-effort server-side invalidation — don't block on failure.
        await logoutUser(tokens.refresh).catch(() => undefined);
      }
    } finally {
      await Promise.all([
        clearTokens(),
        AsyncStorage.removeItem(AUTH_STATE_KEY),
      ]);

      setAuthState({ isAuthenticated: false, userRole: null, userName: null });
    }
  }, []);

  // ── Context value ──────────────────────────────────────────────────────────
  const value = useMemo<AuthContextValue>(
    () => ({ ...authState, isLoading, login, register, loginMock, logout }),
    [authState, isLoading, login, register, loginMock, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Access auth state and actions from any component inside AuthProvider.
 * Throws if used outside the provider tree.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>.');
  }
  return ctx;
}
