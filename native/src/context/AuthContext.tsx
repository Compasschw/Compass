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
import { useQueryClient } from '@tanstack/react-query';
import { clearTokens, getTokens, setTokens, setSessionExpiredHandler } from '../api/client';
import { loginUser, logoutUser, oauthApple, oauthGoogle, registerUser } from '../api/auth';
import { getAppleIdToken, getGoogleIdToken } from '../services/oauth';
import type { UserRole } from '../data/mock';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthState {
  isAuthenticated: boolean;
  userRole: UserRole | null;
  userName: string | null;
  /**
   * True for brand-new member accounts created via OAuth (Google or Apple)
   * whose Pear Suite-required profile fields (DOB, gender, insurance, CIN,
   * ZIP) are still absent.  The navigator gates on this flag to render
   * CompleteProfileScreen instead of MemberTabNavigator until the member
   * finishes onboarding.  Persisted in AsyncStorage alongside the rest of
   * auth state so it survives app reloads.
   */
  needsOnboarding: boolean;
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
    memberExtras?: import('../api/auth').MemberSignupExtras,
  ) => Promise<void>;
  /** Sign in directly from a JWT pair — used by magic-link verify. */
  signInWithTokens: (payload: SignInPayload) => Promise<void>;
  /**
   * Trigger the Google Identity Services popup (web only), exchange the ID
   * token for a Compass JWT pair, and persist the session.  Sets
   * `needsOnboarding` if the account is brand-new and the member profile
   * fields are absent.
   *
   * On native (iOS/Android) this is a no-op — guard with `Platform.OS`.
   *
   * @throws {OAuthError | ApiError} so the UI can surface provider-specific
   *   messages (cancel vs. network vs. server error).
   */
  signInWithGoogle: () => Promise<void>;
  /**
   * Trigger the Sign in with Apple JS popup (web only), exchange the ID
   * token for a Compass JWT pair, and persist the session.  Same semantics
   * as `signInWithGoogle`.
   *
   * @throws {OAuthError | ApiError}
   */
  signInWithApple: () => Promise<void>;
  /**
   * Called by CompleteProfileScreen after the member finishes entering their
   * Pear-required fields.  Clears `needsOnboarding` in-memory and in storage
   * so the navigator stops gating on the onboarding screen.
   */
  clearNeedsOnboarding: () => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Clear auth state after the user deletes their own account.
   * Identical token/cache cleanup to ``logout()`` but resets the
   * ``hasJustSignedOut`` hint so the next render lands on the marketing
   * Landing screen (not the Login screen, which would imply they can
   * still sign back in — they can't, the account is anonymised).
   */
  clearAfterDeletion: () => Promise<void>;
}

// ─── Storage keys ─────────────────────────────────────────────────────────────

const AUTH_STATE_KEY = 'compass_auth_state';

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const queryClient = useQueryClient();

  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    userRole: null,
    userName: null,
    needsOnboarding: false,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [hasJustSignedOut, setHasJustSignedOut] = useState(false);

  // ── Hydrate from storage on mount ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    // ── DEV-ONLY auth bypass for visual review without a backend ──
    // Activated by setting EXPO_PUBLIC_DEV_BYPASS_AUTH=chw or =member when
    // starting the dev server. NEVER active in EAS production builds because
    // EXPO_PUBLIC_* env vars are baked at build time and prod builds do not
    // set this flag. Use only for local UI walkthroughs.
    const bypass = process.env.EXPO_PUBLIC_DEV_BYPASS_AUTH;
    if (bypass === 'chw' || bypass === 'member') {
      const role = bypass as 'chw' | 'member';
      setAuthState({
        isAuthenticated: true,
        userRole: role,
        userName: role === 'chw' ? 'Maria Sanchez (Demo)' : 'Ana Garcia (Demo)',
        needsOnboarding: false,
      });
      setIsLoading(false);
      return () => { cancelled = true; };
    }

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

  // ── Session-expiry bridge ──────────────────────────────────────────────────
  //
  // Register a callback with the API client so that when a token refresh fails
  // (refresh token revoked / expired), the client can drive the auth state flip
  // directly. Without this bridge the client can only call clearTokens() and
  // throw — leaving isAuthenticated = true and every subsequent query 401-ing
  // forever (Audit Finding #4, CRITICAL).
  //
  // The dependency array is intentionally empty: we register once on mount and
  // deregister on unmount. `logout` is stable (useCallback with no changing
  // deps that affect the session-expiry path), so capturing it at registration
  // time is safe. If logout's identity changes we'd re-register anyway via the
  // effect below — but structuring the effect with [logout] as a dep would
  // cause an unnecessary deregister/re-register on every render where logout
  // gets a new reference, so we accept the stable-capture pattern here.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      // This fires from inside the API client's async refresh path. It runs
      // outside React's batch, so each setter schedules its own render — that
      // is fine; both converge synchronously before the next paint.
      setAuthState({ isAuthenticated: false, userRole: null, userName: null, needsOnboarding: false });
      setHasJustSignedOut(true);

      // Drop all cached PHI immediately — same as the full logout path.
      queryClient.clear();

      // Best-effort storage cleanup (fire-and-forget; failure is non-fatal
      // because the in-memory state flip is what drives the navigator).
      void Promise.all([
        clearTokens(),
        AsyncStorage.removeItem(AUTH_STATE_KEY),
      ]).catch(() => undefined);
    });

    return () => {
      setSessionExpiredHandler(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient]);

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
      // Email/password login never triggers onboarding — that path is
      // OAuth-only for brand-new social sign-ups.
      needsOnboarding: false,
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
      memberExtras?: import('../api/auth').MemberSignupExtras,
    ): Promise<void> => {
      const response = await registerUser(email, password, name, role, phone, memberExtras);

      const newState: AuthState = {
        isAuthenticated: true,
        userRole: response.role as UserRole,
        userName: response.name,
        // Self-service registration collects all required Pear fields inline
        // on RegisterScreen, so onboarding is always complete here.
        needsOnboarding: false,
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
        // Magic-link callers don't surface needsOnboarding — they go through
        // a different path and accounts are always pre-provisioned.
        needsOnboarding: false,
      };
      await persistAuthState(newState);
      setAuthState(newState);
      setHasJustSignedOut(false);
    },
    [persistAuthState],
  );

  // ── signInWithGoogle ───────────────────────────────────────────────────────
  const signInWithGoogle = useCallback(async (): Promise<void> => {
    // getGoogleIdToken throws OAuthError on cancel/failure — let it propagate
    // to the UI so the caller can show the right message.
    const idToken = await getGoogleIdToken();
    const response = await oauthGoogle(idToken);

    await setTokens(response.access_token, response.refresh_token);

    const newState: AuthState = {
      isAuthenticated: true,
      userRole: response.role as UserRole,
      userName: response.name,
      needsOnboarding: response.needs_onboarding,
    };

    await persistAuthState(newState);
    setAuthState(newState);
    setHasJustSignedOut(false);
  }, [persistAuthState]);

  // ── signInWithApple ────────────────────────────────────────────────────────
  const signInWithApple = useCallback(async (): Promise<void> => {
    // getAppleIdToken throws OAuthError on cancel/failure — let it propagate.
    const idToken = await getAppleIdToken();
    const response = await oauthApple(idToken);

    await setTokens(response.access_token, response.refresh_token);

    const newState: AuthState = {
      isAuthenticated: true,
      userRole: response.role as UserRole,
      userName: response.name,
      needsOnboarding: response.needs_onboarding,
    };

    await persistAuthState(newState);
    setAuthState(newState);
    setHasJustSignedOut(false);
  }, [persistAuthState]);

  // ── clearNeedsOnboarding ───────────────────────────────────────────────────
  // Called by CompleteProfileScreen after a successful completeMemberOnboarding
  // API call.  Only flips the flag — does not affect tokens or other state.
  const clearNeedsOnboarding = useCallback(async (): Promise<void> => {
    const newState: AuthState = { ...authState, needsOnboarding: false };
    await persistAuthState(newState);
    setAuthState(newState);
  }, [authState, persistAuthState]);

  // ── logout ─────────────────────────────────────────────────────────────────
  // Sign-out is intentionally bullet-proof: the user-visible auth flip happens
  // FIRST, synchronously. Token clearing + server-side invalidation run in the
  // background as fire-and-forget — a hung backend or slow storage cannot
  // block the UI from returning to the Login screen.
  const logout = useCallback(async (): Promise<void> => {
    // 1. Flip the user-visible state immediately. AppNavigator re-renders to
    //    the AuthStack; AuthNavigator picks Login as initial route because of
    //    the hasJustSignedOut flag.
    setAuthState({ isAuthenticated: false, userRole: null, userName: null, needsOnboarding: false });
    setHasJustSignedOut(true);

    // 2. Purge ALL React Query cache entries for the departing user.
    //    Without this, a member logging in on the same device sees the prior
    //    CHW's cached PHI for a beat (or vice-versa) — HIPAA minimum-necessary
    //    violation. Synchronous, must complete before any new query mounts.
    //    (Audit Finding #8, HIGH/CRITICAL — cross-role cache pollution.)
    queryClient.clear();

    // 3. Best-effort cleanup — wrapped so a failure here cannot leave the user
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
  }, [queryClient]);

  // ── clearAfterDeletion ─────────────────────────────────────────────────────
  // Same teardown as logout() but explicitly resets hasJustSignedOut so the
  // auth navigator picks Landing (not Login) as the initial route.  The
  // deleted account can't log back in (is_active=false on the backend) so
  // surfacing the Login screen would be confusing — Landing makes it clear
  // the session is over.
  const clearAfterDeletion = useCallback(async (): Promise<void> => {
    setAuthState({ isAuthenticated: false, userRole: null, userName: null, needsOnboarding: false });
    setHasJustSignedOut(false);
    queryClient.clear();
    try {
      await Promise.all([
        clearTokens(),
        AsyncStorage.removeItem(AUTH_STATE_KEY),
      ]);
    } catch {
      // Storage clear failure: in-memory state is already cleared, the user
      // is on the Landing screen, stale storage will be overwritten on next
      // login attempt.
    }
  }, [queryClient]);

  // ── Context value ──────────────────────────────────────────────────────────
  const value = useMemo<AuthContextValue>(
    () => ({
      ...authState,
      isLoading,
      hasJustSignedOut,
      login,
      register,
      signInWithTokens,
      signInWithGoogle,
      signInWithApple,
      clearNeedsOnboarding,
      logout,
      clearAfterDeletion,
    }),
    [
      authState,
      isLoading,
      hasJustSignedOut,
      login,
      register,
      signInWithTokens,
      signInWithGoogle,
      signInWithApple,
      clearNeedsOnboarding,
      logout,
      clearAfterDeletion,
    ],
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
