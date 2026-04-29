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
import { clearTokens, getTokens, setTokens } from '../api/client';
import { loginUser, logoutUser, registerUser } from '../api/auth';
import type { UserRole } from '../data/mock';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthState {
  isAuthenticated: boolean;
  userRole: UserRole | null;
  userName: string | null;
}

interface SignInPayload {
  accessToken: string;
  refreshToken: string;
  role: UserRole;
  name: string;
}

interface AuthContextValue extends AuthState {
  isLoading: boolean;
  /**
   * True after `logout()` runs in this app session — lets the AuthNavigator
   * pick `Login` as its initial route instead of `Landing`, so signed-out
   * users skip the marketing page on the way back. Reset when a new session
   * starts (login / register / signInWithTokens).
   */
  hasJustSignedOut: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (
    email: string,
    password: string,
    name: string,
    role: string,
    phone?: string,
  ) => Promise<void>;
  /** Sign in directly from a JWT pair — used by magic-link verify. */
  signInWithTokens: (payload: SignInPayload) => Promise<void>;
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
  const [hasJustSignedOut, setHasJustSignedOut] = useState(false);

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
    setHasJustSignedOut(false);
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
      setHasJustSignedOut(false);
    },
    [persistAuthState],
  );

  // ── signInWithTokens (magic-link / SSO-style handoff) ──────────────────────
  const signInWithTokens = useCallback(
    async (payload: SignInPayload): Promise<void> => {
      await setTokens(payload.accessToken, payload.refreshToken);
      const newState: AuthState = {
        isAuthenticated: true,
        userRole: payload.role,
        userName: payload.name,
      };
      await persistAuthState(newState);
      setAuthState(newState);
      setHasJustSignedOut(false);
    },
    [persistAuthState],
  );

  // ── logout ─────────────────────────────────────────────────────────────────
  // Sign-out is intentionally bullet-proof: the user-visible auth flip happens
  // FIRST, synchronously. Token clearing + server-side invalidation run in the
  // background as fire-and-forget — a hung backend or slow storage cannot
  // block the UI from returning to the Login screen.
  const logout = useCallback(async (): Promise<void> => {
    // 1. Flip the user-visible state immediately. AppNavigator re-renders to
    //    the AuthStack; AuthNavigator picks Login as initial route because of
    //    the hasJustSignedOut flag.
    setAuthState({ isAuthenticated: false, userRole: null, userName: null });
    setHasJustSignedOut(true);

    // 2. Best-effort cleanup — wrapped so a failure here cannot leave the user
    //    stranded mid-sign-out.
    try {
      const tokens = await getTokens();
      if (tokens?.refresh) {
        // Don't await — if the server is slow/unreachable we don't care.
        void logoutUser(tokens.refresh).catch(() => undefined);
      }
    } catch {
      // getTokens can throw on web if storage is corrupted. Ignore.
    }

    try {
      await Promise.all([
        clearTokens(),
        AsyncStorage.removeItem(AUTH_STATE_KEY),
      ]);
    } catch {
      // If storage clear fails, the in-memory state is already cleared which
      // is what the user sees. Stale storage will be overwritten on next login.
    }
  }, []);

  // ── Context value ──────────────────────────────────────────────────────────
  const value = useMemo<AuthContextValue>(
    () => ({ ...authState, isLoading, hasJustSignedOut, login, register, signInWithTokens, logout }),
    [authState, isLoading, hasJustSignedOut, login, register, signInWithTokens, logout],
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
