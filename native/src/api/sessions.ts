/**
 * Sessions API — full CRUD + lifecycle operations for CHW sessions.
 *
 * Mirrors the web API contract at /sessions/.
 */

import { api } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Server-side session shape (snake_case as returned by the API). */
export interface SessionData {
  id: string;
  request_id: string;
  chw_id: string;
  member_id: string;
  vertical: string;
  status: string;
  mode: string;
  scheduled_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_minutes: number | null;
  suggested_units: number | null;
  units_billed: number | null;
  gross_amount: number | null;
  net_amount: number | null;
  created_at: string;
  chw_name: string | null;
  member_name: string | null;
}

export interface CreateSessionPayload {
  request_id: string;
  scheduled_at: string;
  mode: string;
}

// ─── API functions ────────────────────────────────────────────────────────────

/** Fetch all sessions visible to the current user. */
export function fetchSessions(): Promise<SessionData[]> {
  return api<SessionData[]>('/sessions/');
}

/** Fetch a single session by ID. */
export function fetchSession(id: string): Promise<SessionData> {
  return api<SessionData>(`/sessions/${id}`);
}

/** Create a session from an accepted service request. */
export function createSession(data: CreateSessionPayload): Promise<SessionData> {
  return api<SessionData>('/sessions/', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** Transition a session from 'scheduled' to 'in_progress'. */
export function startSession(id: string): Promise<SessionData> {
  return api<SessionData>(`/sessions/${id}/start`, { method: 'PATCH' });
}

/** Transition a session from 'in_progress' to 'completed'. */
export function completeSession(id: string): Promise<SessionData> {
  return api<SessionData>(`/sessions/${id}/complete`, { method: 'PATCH' });
}

/**
 * Submit post-session documentation.
 *
 * @param sessionId - The session being documented.
 * @param data      - Documentation payload (summary, Z-codes, billing units, etc.).
 */
export function submitDocumentation(
  sessionId: string,
  data: Record<string, unknown>,
): Promise<void> {
  return api<void>(`/sessions/${sessionId}/documentation`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
