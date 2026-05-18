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
 * Optional member-only signup payload. All fields are individually optional
 * at the API layer (only Full Name / DOB / Sex are gated client-side).
 * Snake-case keys because /auth/register accepts the wire shape directly.
 */
export interface MemberSignupExtras {
  /** ISO 8601 date (YYYY-MM-DD) — Pear Suite's expected dob format. */
  date_of_birth?: string;
  /** Pear sex enum: "Male" | "Female" | "Other". */
  gender?: 'Male' | 'Female' | 'Other';
  address_line1?: string;
  address_line2?: string;
  city?: string;
  /** US state 2-letter code (CA, NY, ...). */
  state?: string;
  /** 5-digit ZIP. ZIP+4 lookup deferred. */
  zip_code?: string;
  /** Curated 6-carrier dropdown value. */
  insurance_company?: string;
  /** Medi-Cal CIN — PHI, encrypted at rest on the backend. */
  medi_cal_id?: string;
}

/**
 * Register a new user account.
 * Persists tokens to secure storage as a side-effect.
 *
 * ``memberExtras`` is only meaningful when ``role === "member"``; passed
 * fields are written onto the new MemberProfile row at registration time
 * and a background Pear-sync task fires after the response is returned.
 * The signup is NOT blocked on Pear succeeding.
 */
export async function registerUser(
  email: string,
  password: string,
  name: string,
  role: string,
  phone?: string,
  memberExtras?: MemberSignupExtras,
): Promise<AuthResponse> {
  const body: Record<string, unknown> = { email, password, name, role };
  if (phone) body.phone = phone;
  if (memberExtras) {
    for (const [key, value] of Object.entries(memberExtras)) {
      if (value !== undefined && value !== '') {
        body[key] = value;
      }
    }
  }

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
