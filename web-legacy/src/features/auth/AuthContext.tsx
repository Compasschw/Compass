import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { clearTokens, getRefreshToken } from '../../api/client';
import { logoutUser } from '../../api/auth';
import type { UserRole } from '../../data/mock';

// --- Types ---

interface AuthState {
  isAuthenticated: boolean;
  userRole: UserRole | null;
  userName: string | null;
}

interface AuthContextValue extends AuthState {
  login: (role: UserRole, name: string) => void;
  logout: () => void;
}

// --- Persistent storage (survives tab close) ---

const STORAGE_KEY = 'compass_auth';

function loadSession(): AuthState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored) as AuthState;
  } catch { /* ignore */ }
  return { isAuthenticated: false, userRole: null, userName: null };
}

function saveSession(state: AuthState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// --- Context ---

const AuthContext = createContext<AuthContextValue | null>(null);

// --- Provider ---

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [authState, setAuthState] = useState<AuthState>(loadSession);

  const login = useCallback((role: UserRole, name: string) => {
    const state: AuthState = { isAuthenticated: true, userRole: role, userName: name };
    setAuthState(state);
    saveSession(state);
  }, []);

  const logout = useCallback(async () => {
    try {
      const refreshToken = getRefreshToken();
      if (refreshToken) {
        await logoutUser(refreshToken);
      }
    } catch {
      // Best-effort server logout — clear local state regardless
    }
    clearTokens();
    const state: AuthState = { isAuthenticated: false, userRole: null, userName: null };
    setAuthState(state);
    clearSession();
  }, []);

  return (
    <AuthContext.Provider value={{ ...authState, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// --- Hook ---

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
