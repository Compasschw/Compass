import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import type { UserRole } from '../../data/mock';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuthState {
  isAuthenticated: boolean;
  userRole: UserRole | null;
  userName: string | null;
}

interface AuthContextValue extends AuthState {
  /**
   * Mock login — sets role and name in state without any real network call.
   * In a real implementation this would call an auth API.
   */
  login: (role: UserRole, name: string) => void;
  /** Clears auth state and returns the user to the login screen. */
  logout: () => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Provides mock authentication state to the entire app.
 * No tokens, cookies, or network requests are involved — this is purely
 * in-memory state for the interactive mockup.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    userRole: null,
    userName: null,
  });

  const login = useCallback((role: UserRole, name: string) => {
    setAuthState({
      isAuthenticated: true,
      userRole: role,
      userName: name,
    });
  }, []);

  const logout = useCallback(() => {
    setAuthState({
      isAuthenticated: false,
      userRole: null,
      userName: null,
    });
  }, []);

  return (
    <AuthContext.Provider value={{ ...authState, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Consume authentication state from anywhere in the tree.
 * Throws if used outside of AuthProvider to surface misconfiguration early.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
