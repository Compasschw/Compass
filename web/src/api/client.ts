const API_BASE = import.meta.env.VITE_API_URL || (
  import.meta.env.PROD
    ? "/api/v1"
    : "http://localhost:8000/api/v1"
);

const TOKEN_KEY = "compass_auth_tokens";

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
}

export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

function getAccessToken(): string | null {
  try {
    const auth = localStorage.getItem(TOKEN_KEY);
    if (auth) {
      const parsed = JSON.parse(auth);
      return parsed.access_token || null;
    }
  } catch {}
  return null;
}

export function getRefreshToken(): string | null {
  try {
    const auth = localStorage.getItem(TOKEN_KEY);
    if (auth) return JSON.parse(auth).refresh_token || null;
  } catch {}
  return null;
}

export function setTokens(access_token: string, refresh_token: string) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({ access_token, refresh_token }));
}

export function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;

  try {
    const res = await fetch(API_BASE + "/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) {
      clearTokens();
      return null;
    }
    const data = await res.json();
    setTokens(data.access_token, data.refresh_token);
    return data.access_token;
  } catch {
    clearTokens();
    return null;
  }
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

  let res = await fetch(API_BASE + path, { ...fetchOptions, headers });

  // Token expired — try refresh once
  if (res.status === 401 && !skipAuth) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers["Authorization"] = "Bearer " + newToken;
      res = await fetch(API_BASE + path, { ...fetchOptions, headers });
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.detail || res.statusText, body);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}
