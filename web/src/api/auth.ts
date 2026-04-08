import { api, setTokens, clearTokens } from "./client";

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  role: string;
  name: string;
}

export async function registerUser(email: string, password: string, name: string, role: string, phone?: string): Promise<TokenResponse> {
  const res = await api<TokenResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name, role, phone }),
    skipAuth: true,
  });
  setTokens(res.access_token, res.refresh_token);
  return res;
}

export async function loginUser(email: string, password: string): Promise<TokenResponse> {
  const res = await api<TokenResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
    skipAuth: true,
  });
  setTokens(res.access_token, res.refresh_token);
  return res;
}

export async function logoutUser(refreshToken: string): Promise<void> {
  await api("/auth/logout", { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) });
  clearTokens();
}
