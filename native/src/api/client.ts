/**
 * HTTP client for CompassCHW API.
 *
 * Handles JWT auth with automatic token refresh on 401.
 * Persists tokens via expo-secure-store on iOS / Android (Keychain / Keystore)
 * and via window.localStorage on web (SecureStore's web shim doesn't expose
 * the getter/setter we need in Expo SDK 54).
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const API_BASE =
  process.env.EXPO_PUBLIC_API_URL || 'https://api.joincompasschw.com/api/v1';

const TOKENS_KEY = 'compass_tokens';

// ─── Cross-platform storage shim ─────────────────────────────────────────────
//
// SecureStore is only implemented for iOS + Android; its web "shim" in SDK 54
// throws `setValueWithKeyAsync is not a function`. We route web to
// localStorage, and native to SecureStore, behind a uniform async interface.

const storage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') return null;
      return window.localStorage.getItem(key);
    }
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') return;
      window.localStorage.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async del(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') return;
      window.localStorage.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

// ─── Session-expiry callback ──────────────────────────────────────────────────
//
// Allows AuthContext to register a callback so that when a token refresh fails
// (refresh token expired or revoked), the auth state flips to unauthenticated
// in the same render cycle rather than silently leaving the user stuck on
// authenticated screens with every subsequent query returning 401.
//
// Lifecycle:
//   AuthContext mounts → calls setSessionExpiredHandler(() => logout())
//   Token refresh fails inside `api()` → _onSessionExpired?.() fires → logout()
//     runs → setAuthState({ isAuthenticated: false }) → AppNavigator switches
//     to LoginStack.
//   AuthContext unmounts (app fully torn down) → setSessionExpiredHandler(null)

let _onSessionExpired: (() => void) | null = null;

/**
 * Register (or clear) the callback that `api()` fires when a token refresh
 * fails definitively. Pass `null` on cleanup.
 *
 * This is intentionally a module-level setter rather than a React context hook
 * so that the API client (which lives outside the React tree) can call it
 * without being tangled into the component hierarchy.
 */
export function setSessionExpiredHandler(cb: (() => void) | null): void {
  _onSessionExpired = cb;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StoredTokens {
  access: string;
  refresh: string;
}

export interface ApiOptions extends RequestInit {
  /** Skip attaching the Authorization header (e.g. login, register). */
  skipAuth?: boolean;
}

// ─── Error class ──────────────────────────────────────────────────────────────

export class ApiError extends Error {
  public readonly status: number;
  /** Human-readable message extracted from the response `detail` field. */
  public readonly detail: string;
  /**
   * Raw `detail` payload when the server returned a structured object rather
   * than a plain string. Callers that need machine-readable codes (e.g. the
   * ANOTHER_SESSION_IN_PROGRESS 409) should inspect this field.
   *
   * Example shape for a structured 409:
   *   { code: "ANOTHER_SESSION_IN_PROGRESS", message: "...", active_session_id: "uuid" }
   */
  public readonly rawDetail: Record<string, unknown> | null;

  constructor(
    status: number,
    detail: string,
    rawDetail: Record<string, unknown> | null = null,
  ) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.rawDetail = rawDetail;
  }
}

// ─── Token management ─────────────────────────────────────────────────────────

/**
 * Retrieve stored access/refresh tokens from secure storage.
 * Returns null when no tokens are persisted.
 */
export async function getTokens(): Promise<StoredTokens | null> {
  const raw = await storage.get(TOKENS_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    // Corrupted entry — treat as missing.
    return null;
  }
}

/**
 * Persist access and refresh tokens to secure storage.
 */
export async function setTokens(access: string, refresh: string): Promise<void> {
  await storage.set(TOKENS_KEY, JSON.stringify({ access, refresh }));
}

/**
 * Remove tokens from secure storage (logout / session expiry).
 */
export async function clearTokens(): Promise<void> {
  await storage.del(TOKENS_KEY);
}

// ─── Refresh logic ────────────────────────────────────────────────────────────

// Shared in-flight refresh promise. When several requests hit a 401 in the same
// tick (common on a screen with multiple/polling queries), they all await this
// one refresh instead of each POSTing /auth/refresh. Without this, a server that
// rotates refresh tokens on use invalidates the first token as the second call
// presents it, tearing down an otherwise-valid new session.
let inFlightRefresh: Promise<string> | null = null;

/**
 * Attempt a silent token refresh, de-duplicated across concurrent callers.
 * Returns the new access token on success. Throws `ApiError` with the refresh
 * endpoint's status (401/403 = truly expired; 5xx = server issue) or a
 * network `ApiError(0, ...)` — callers use the status to decide whether to log
 * the user out.
 */
async function refreshAccessToken(refreshToken: string): Promise<string> {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async (): Promise<string> => {
    try {
      let response: Response;
      try {
        response = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
      } catch {
        // Network failure (offline / DNS / CORS) — not an auth decision.
        throw new ApiError(0, 'Network error during token refresh.');
      }

      if (!response.ok) {
        // Preserve the real status so the caller can distinguish a genuinely
        // expired session (401/403) from a transient server error (5xx).
        throw new ApiError(response.status, 'Token refresh failed.');
      }

      const data = (await response.json()) as {
        access_token: string;
        refresh_token?: string;
      };

      // Persist updated tokens; keep existing refresh token if the server
      // doesn't issue a new one (some implementations rotate, others don't).
      const tokens = await getTokens();
      await setTokens(data.access_token, data.refresh_token ?? tokens?.refresh ?? '');

      return data.access_token;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

// ─── Core request function ────────────────────────────────────────────────────

/**
 * Make an authenticated request to the CompassCHW API.
 *
 * Automatically injects the Bearer token, and transparently retries once
 * after refreshing the access token on a 401 response.
 *
 * @throws {ApiError} for non-2xx responses (including after a failed refresh).
 */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { skipAuth = false, headers: callerHeaders = {}, ...restOptions } = options;

  const buildHeaders = (accessToken?: string): HeadersInit => ({
    'Content-Type': 'application/json',
    ...callerHeaders,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  });

  const executeRequest = async (accessToken?: string): Promise<Response> =>
    fetch(`${API_BASE}${path}`, {
      ...restOptions,
      headers: buildHeaders(accessToken),
    });

  // ── First attempt ──────────────────────────────────────────────────────────
  let tokens: StoredTokens | null = null;

  if (!skipAuth) {
    tokens = await getTokens();
  }

  let response = await executeRequest(tokens?.access);

  // ── Auto-refresh on 401 ───────────────────────────────────────────────────
  if (response.status === 401 && !skipAuth && tokens?.refresh) {
    let newAccessToken: string;

    try {
      newAccessToken = await refreshAccessToken(tokens.refresh);
    } catch (refreshError) {
      // Only tear down the session when the refresh endpoint explicitly rejects
      // the token (401/403). A network failure or 5xx means the refresh couldn't
      // complete — NOT that the session is invalid — so we surface the error but
      // keep the tokens, avoiding a spurious mid-shift logout on a spotty
      // connection or a transient backend blip.
      const isExpired =
        refreshError instanceof ApiError &&
        (refreshError.status === 401 || refreshError.status === 403);

      if (isExpired) {
        // Tokens are cleared first so that any subsequent code (including the
        // _onSessionExpired callback) cannot accidentally reuse them.
        await clearTokens();
        // Notify AuthContext so it can flip isAuthenticated → false and drive
        // the navigator to the LoginStack.
        _onSessionExpired?.();
        throw new ApiError(401, 'Session expired. Please log in again.');
      }

      // Transient failure — keep the session, fail just this request.
      throw refreshError instanceof ApiError
        ? refreshError
        : new ApiError(0, 'Network error. Please try again.');
    }

    response = await executeRequest(newAccessToken);
  }

  // ── Error handling ─────────────────────────────────────────────────────────
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    let rawDetail: Record<string, unknown> | null = null;

    try {
      // FastAPI's `detail` can be a string (HTTPException(detail="...")) or
      // a dict (HTTPException(detail={"message": "...", ...})). The dict
      // shape is used by endpoints that want to return structured error
      // payloads — e.g. `/chw/intake/submit` returns
      // `{message, missing_fields}`. Normalise both into a readable string
      // for ApiError so toasts / banners stay legible regardless of source.
      // The raw object is also preserved in `rawDetail` so callers that need
      // machine-readable codes (e.g. ANOTHER_SESSION_IN_PROGRESS) can inspect
      // it without re-parsing the message string.
      const errorBody = (await response.json()) as {
        detail?:
          | string
          | { message?: string; [k: string]: unknown }
          | Array<{ msg?: string; [k: string]: unknown }>;
      };
      const raw = errorBody.detail;
      if (typeof raw === 'string') {
        detail = raw;
      } else if (Array.isArray(raw)) {
        // FastAPI/Pydantic validation errors (422s) return `detail` as a list
        // of `{loc, msg, type}` objects rather than a string or dict — without
        // this branch it fell through to the generic-object case below and
        // rendered as a raw JSON blob in the error banner. Surface the first
        // item's message, stripping Pydantic's "Value error, " prefix so a
        // custom validator (e.g. password complexity) reads as plain English.
        const firstMsg = raw[0]?.msg;
        detail =
          typeof firstMsg === 'string'
            ? firstMsg.replace(/^Value error,\s*/, '')
            : JSON.stringify(raw);
      } else if (raw && typeof raw === 'object') {
        rawDetail = raw as Record<string, unknown>;
        detail = typeof raw.message === 'string' ? raw.message : JSON.stringify(raw);
      }
    } catch {
      // Body was not JSON — fall back to the status string.
    }

    throw new ApiError(response.status, detail, rawDetail);
  }

  // 204 No Content — return empty object cast to T.
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}
