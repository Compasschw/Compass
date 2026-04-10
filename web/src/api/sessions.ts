import { api } from "./client";

export interface SessionData {
  id: string; request_id: string; chw_id: string; member_id: string;
  vertical: string; status: string; mode: string;
  scheduled_at: string | null; started_at: string | null; ended_at: string | null;
  duration_minutes: number | null; units_billed: number | null;
  gross_amount: number | null; net_amount: number | null; created_at: string;
  chw_name: string | null; member_name: string | null;
}

export const fetchSessions = (): Promise<SessionData[]> => api("/sessions/");
export const fetchSession = (id: string): Promise<SessionData> => api("/sessions/" + id);
export const createSession = (data: { request_id: string; scheduled_at: string; mode: string }) =>
  api<SessionData>("/sessions/", { method: "POST", body: JSON.stringify(data) });
export const startSession = (id: string) => api<SessionData>("/sessions/" + id + "/start", { method: "PATCH" });
export const completeSession = (id: string) => api<SessionData>("/sessions/" + id + "/complete", { method: "PATCH" });
export const submitDocumentation = (sessionId: string, data: Record<string, unknown>) =>
  api("/sessions/" + sessionId + "/documentation", { method: "POST", body: JSON.stringify(data) });
