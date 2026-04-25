/**
 * Admin API client for Compass CHW admin dashboard.
 *
 * Authentication: reads the ADMIN_KEY from sessionStorage (key: `compass_admin_key`).
 * This is a separate shared secret — NOT a user JWT.
 * sessionStorage intentionally clears on browser close (security requirement).
 *
 * On 401 responses: clears the stored key and redirects to /admin/login.
 */

export const ADMIN_KEY_STORAGE = 'compass_admin_key';

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
 * Clears the stored admin key and navigates to the admin login page.
 * Uses window.location so it works outside React's router context.
 */
function handleUnauthorized(): never {
  sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  window.location.replace('/admin/login');
  // Throw so TypeScript knows this path never returns.
  throw new AdminAuthError();
}

/**
 * Typed fetch wrapper for all `/api/v1/admin/*` endpoints.
 *
 * @param path   Path relative to `/api/v1/admin`, e.g. `/stats` or `/chws`.
 * @param params Optional query parameters (serialized as URLSearchParams).
 */
export async function adminFetch<T>(
  path: string,
  params?: Record<string, string | number>,
): Promise<T> {
  const key = getAdminKey();

  let url = `${API_BASE}/admin${path}`;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    );
    url = `${url}?${qs.toString()}`;
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
  });

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

/**
 * Validates an admin key by calling /stats.
 * Returns true on success, false on 401.
 * Throws `AdminApiError` for other non-2xx responses.
 */
export async function validateAdminKey(key: string): Promise<boolean> {
  const url = `${API_BASE}/admin/stats`;
  const response = await fetch(url, {
    method: 'GET',
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
