/**
 * Waitlist API endpoints.
 */

import { api } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WaitlistPayload {
  first_name: string;
  last_name: string;
  email: string;
  /** 'chw' | 'member' */
  role: string;
}

export interface WaitlistResponse {
  id: string;
  email: string;
  message?: string;
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

/**
 * Submit an email to the waitlist.
 */
export async function submitWaitlist(
  payload: WaitlistPayload,
): Promise<WaitlistResponse> {
  return api<WaitlistResponse>('/waitlist/', {
    method: 'POST',
    body: JSON.stringify(payload),
    skipAuth: true,
  });
}
