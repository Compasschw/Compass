/**
 * Service Requests API — create, list, and act on service requests.
 *
 * Mirrors the web API contract at /requests/.
 */

import { api } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Server-side service request shape (snake_case as returned by the API). */
export interface ServiceRequestData {
  id: string;
  member_id: string;
  matched_chw_id: string | null;
  vertical: string;
  urgency: string;
  description: string;
  preferred_mode: string;
  status: string;
  estimated_units: number;
  created_at: string;
  member_name: string | null;
}

// ─── API functions ────────────────────────────────────────────────────────────

/** Fetch all service requests visible to the current user. */
export function fetchRequests(): Promise<ServiceRequestData[]> {
  return api<ServiceRequestData[]>('/requests/');
}

/**
 * Create a new service request (member-initiated).
 *
 * @param data - Request payload (vertical, urgency, description, preferred_mode, etc.).
 */
export function createRequest(
  data: Record<string, unknown>,
): Promise<ServiceRequestData> {
  return api<ServiceRequestData>('/requests/', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** Accept a service request — assigns the CHW and creates a session. */
export function acceptRequest(id: string): Promise<ServiceRequestData> {
  return api<ServiceRequestData>(`/requests/${id}/accept`, { method: 'PATCH' });
}

/** Pass on a service request — marks the CHW as unavailable for this request. */
export function passRequest(id: string): Promise<ServiceRequestData> {
  return api<ServiceRequestData>(`/requests/${id}/pass`, { method: 'PATCH' });
}
