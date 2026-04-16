/**
 * Auth API endpoints.
 *
 * login, register, and logout against /auth/* routes.
 * Tokens are persisted by the caller via setTokens().
 */

import { api, setTokens } from './client';

// ─── Response types ───────────────────────────────────────────────────────────

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  /** 'chw' | 'member' */
  role: string;
  name: string;
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

/**
 * Authenticate with email and password.
 * Persists tokens to secure storage as a side-effect.
 */
export async function loginUser(
  email: string,
  password: string,
): Promise<AuthResponse> {
  const response = await api<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    skipAuth: true,
  });

  await setTokens(response.access_token, response.refresh_token);

  return response;
}

/**
 * Register a new user account.
 * Persists tokens to secure storage as a side-effect.
 */
export async function registerUser(
  email: string,
  password: string,
  name: string,
  role: string,
  phone?: string,
): Promise<AuthResponse> {
  const body: Record<string, string> = { email, password, name, role };
  if (phone) body.phone = phone;

  const response = await api<AuthResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(body),
    skipAuth: true,
  });

  await setTokens(response.access_token, response.refresh_token);

  return response;
}

/**
 * Invalidate the current session server-side.
 * Tokens should be cleared from storage by the caller (AuthContext.logout).
 */
export async function logoutUser(refreshToken: string): Promise<void> {
  await api<void>('/auth/logout', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}
