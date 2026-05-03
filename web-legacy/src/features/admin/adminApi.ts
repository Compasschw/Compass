/**
 * Admin API client for Compass CHW admin dashboard.
 *
 * Authentication is two-factor:
 *   Step 1 — ADMIN_KEY  : stored in sessionStorage under ADMIN_KEY_STORAGE.
 *   Step 2 — 2FA token  : short-lived JWT (15 min) returned by /2fa/verify,
 *                         stored in sessionStorage under ADMIN_2FA_TOKEN_STORAGE.
 *
 * Both keys are sessionStorage — cleared automatically when the browser closes.
 *
 * All protected endpoints require:
 *   Authorization: Bearer <ADMIN_KEY>
 *   X-Admin-2FA-Token: <2fa_token>
 *
 * On 401 responses: clears both keys and redirects to /admin/login.
 */

export const ADMIN_KEY_STORAGE = 'compass_admin_key';
export const ADMIN_2FA_TOKEN_STORAGE = 'compass_admin_2fa_token';

// Match the existing api/client.ts env var name and fallback logic.
const API_BASE = import.meta.env.VITE_API_URL
  ? (import.meta.env.VITE_API_URL as string)
  : import.meta.env.PROD
  ? '/_proxy/api/v1'
  : 'http://localhost:8000/api/v1';

/** Sentinel error thrown when the admin key is absent — callers redirect to login. */
export class AdminAuthError extends Error {
  constructor() {
    super('Admin key not found. Please log in.');
    this.name = 'AdminAuthError';
  }
}

/** General non-2xx API error. */
export class AdminApiError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Reads the admin key from sessionStorage.
 * Throws `AdminAuthError` if missing.
 */
function getAdminKey(): string {
  const key = sessionStorage.getItem(ADMIN_KEY_STORAGE);
  if (!key) throw new AdminAuthError();
  return key;
}

/**
 * Clears both the admin key and the 2FA token and navigates to the login page.
 * Uses window.location so it works outside React's router context.
 */
function handleUnauthorized(): never {
  sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  sessionStorage.removeItem(ADMIN_2FA_TOKEN_STORAGE);
  window.location.replace('/admin/login');
  // Throw so TypeScript knows this path never returns.
  throw new AdminAuthError();
}

/**
 * Reads the 2FA JWT from sessionStorage.
 * Returns null (not throws) when absent — callers decide whether to redirect.
 */
function get2FAToken(): string | null {
  return sessionStorage.getItem(ADMIN_2FA_TOKEN_STORAGE);
}

/**
 * Typed fetch wrapper for all `/api/v1/admin/*` endpoints.
 *
 * Injects both the admin key (Authorization header) and the 2FA JWT
 * (X-Admin-2FA-Token header) on every request.
 *
 * @param path   Path relative to `/api/v1/admin`, e.g. `/stats` or `/chws`.
 * @param params Optional query parameters (serialized as URLSearchParams).
 */
export async function adminFetch<T>(
  path: string,
  params?: Record<string, string | number>,
): Promise<T> {
  const key = getAdminKey();
  const twoFaToken = get2FAToken();

  let url = `${API_BASE}/admin${path}`;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    );
    url = `${url}?${qs.toString()}`;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  };
  if (twoFaToken) {
    headers['X-Admin-2FA-Token'] = twoFaToken;
  }

  const response = await fetch(url, { method: 'GET', headers });

  if (response.status === 401) {
    handleUnauthorized();
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = (body as { detail?: string }).detail ?? response.statusText;
    throw new AdminApiError(response.status, detail, body);
  }

  return response.json() as Promise<T>;
}

// ─── 2FA API calls ────────────────────────────────────────────────────────────

export interface TotpSetupResponse {
  otpauth_uri: string;
  /** Plain-text base32 secret — only present when already_verified is false */
  secret: string;
  issuer: string;
  already_verified: boolean;
}

export interface TotpVerifyResponse {
  two_fa_token: string;
}

/**
 * Calls ``POST /api/v1/admin/2fa/setup`` using the stored ADMIN_KEY.
 * Returns the OTP auth URI for QR code rendering and the plain-text secret
 * for manual entry. The secret field is blank once the setup has been verified.
 */
export async function fetchTotpSetup(): Promise<TotpSetupResponse> {
  const key = getAdminKey();
  const response = await fetch(`${API_BASE}/admin/2fa/setup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
  });
  if (response.status === 401) handleUnauthorized();
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = (body as { detail?: string }).detail ?? response.statusText;
    throw new AdminApiError(response.status, detail, body);
  }
  return response.json() as Promise<TotpSetupResponse>;
}

/**
 * Calls ``POST /api/v1/admin/2fa/verify`` with the 6-digit TOTP code.
 *
 * Returns the short-lived 2FA JWT on success.
 * Throws ``AdminApiError(401)`` on bad code.
 * Throws ``AdminApiError(428)`` with detail ``"setup_required"`` if setup
 * has never been completed — callers should redirect to the setup flow.
 */
export async function verifyTotpCode(code: string): Promise<TotpVerifyResponse> {
  const key = getAdminKey();
  const response = await fetch(`${API_BASE}/admin/2fa/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ token: code }),
  });
  if (response.status === 401) {
    const body = await response.json().catch(() => ({}));
    const detail = (body as { detail?: string }).detail ?? 'Invalid or expired TOTP code.';
    throw new AdminApiError(401, detail, body);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = (body as { detail?: string }).detail ?? response.statusText;
    throw new AdminApiError(response.status, detail, body);
  }
  return response.json() as Promise<TotpVerifyResponse>;
}

/**
 * Validates an admin key by calling /admin/2fa/setup.
 *
 * We probe /2fa/setup rather than /stats because /stats now requires BOTH
 * the admin key AND a valid 2FA token (require_2fa_token dependency). At
 * login time we don't have the 2FA token yet, so /stats would 401 even
 * with a valid admin key, surfacing as a misleading "Invalid admin key"
 * error to the operator.
 *
 * /2fa/setup requires only the admin key (it's exempt from the 2FA gate
 * because it bootstraps the 2FA flow itself), and it's idempotent: the
 * second+ call just returns the existing provisioning URI.
 *
 * Returns true on success, false on 401.
 * Throws `AdminApiError` for other non-2xx responses.
 */
export async function validateAdminKey(key: string): Promise<boolean> {
  const url = `${API_BASE}/admin/2fa/setup`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
  });

  if (response.status === 401) return false;
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = (body as { detail?: string }).detail ?? response.statusText;
    throw new AdminApiError(response.status, detail, body);
  }
  return true;
}
