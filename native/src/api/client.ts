/**
 * HTTP client for CompassCHW API.
 *
 * Handles JWT auth with automatic token refresh on 401.
 * Uses expo-secure-store for token persistence — no web APIs.
 */

import * as SecureStore from 'expo-secure-store';

const API_BASE =
  process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000/api/v1';

const TOKENS_KEY = 'compass_tokens';

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
  public readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

// ─── Token management ─────────────────────────────────────────────────────────

/**
 * Retrieve stored access/refresh tokens from secure storage.
 * Returns null when no tokens are persisted.
 */
export async function getTokens(): Promise<StoredTokens | null> {
  const raw = await SecureStore.getItemAsync(TOKENS_KEY);
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
  await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify({ access, refresh }));
}

/**
 * Remove tokens from secure storage (logout / session expiry).
 */
export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKENS_KEY);
}

// ─── Refresh logic ────────────────────────────────────────────────────────────

/**
 * Attempt a silent token refresh.
 * Returns the new access token on success, throws ApiError on failure.
 */
async function refreshAccessToken(refreshToken: string): Promise<string> {
  const response = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!response.ok) {
    throw new ApiError(response.status, 'Token refresh failed — session expired.');
  }

  const data = (await response.json()) as { access_token: string; refresh_token?: string };

  // Persist updated tokens; keep existing refresh token if the server doesn't
  // issue a new one (some implementations rotate, others don't).
  const tokens = await getTokens();
  await setTokens(data.access_token, data.refresh_token ?? tokens?.refresh ?? '');

  return data.access_token;
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
    } catch {
      await clearTokens();
      throw new ApiError(401, 'Session expired. Please log in again.');
    }

    response = await executeRequest(newAccessToken);
  }

  // ── Error handling ─────────────────────────────────────────────────────────
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;

    try {
      const errorBody = (await response.json()) as { detail?: string };
      detail = errorBody.detail ?? detail;
    } catch {
      // Body was not JSON — fall back to the status string.
    }

    throw new ApiError(response.status, detail);
  }

  // 204 No Content — return empty object cast to T.
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}
