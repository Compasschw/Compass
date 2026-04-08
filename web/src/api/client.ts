const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000/api/v1";

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

function getAccessToken(): string | null {
  try {
    const auth = sessionStorage.getItem("compass_auth_tokens");
    if (auth) {
      const parsed = JSON.parse(auth);
      return parsed.access_token || null;
    }
  } catch {}
  return null;
}

export function setTokens(access_token: string, refresh_token: string) {
  sessionStorage.setItem("compass_auth_tokens", JSON.stringify({ access_token, refresh_token }));
}

export function clearTokens() {
  sessionStorage.removeItem("compass_auth_tokens");
}

export function getRefreshToken(): string | null {
  try {
    const auth = sessionStorage.getItem("compass_auth_tokens");
    if (auth) return JSON.parse(auth).refresh_token || null;
  } catch {}
  return null;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { skipAuth, ...fetchOptions } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(fetchOptions.headers as Record<string, string> || {}),
  };

  if (!skipAuth) {
    const token = getAccessToken();
    if (token) headers["Authorization"] = "Bearer " + token;
  }

  const res = await fetch(API_BASE + path, { ...fetchOptions, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.detail || res.statusText, body);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}
