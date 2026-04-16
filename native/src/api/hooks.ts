/**
 * Data-fetching functions for the CompassCHW API.
 *
 * Plain async functions — no React Query dependency for now.
 * All functions require an authenticated session (tokens in secure storage).
 */

import { api } from './client';
import type { Session, ServiceRequest, EarningsSummary } from '../data/mock';
import type { SessionData, CreateSessionPayload } from './sessions';
import type { ServiceRequestData } from './requests';
import type { ConversationSummary, MessageData } from './conversations';
import type { CredentialValidation } from './credentials';

// ─── Sessions ─────────────────────────────────────────────────────────────────

/**
 * Fetch all sessions visible to the current user.
 */
export async function fetchSessions(): Promise<Session[]> {
  return api<Session[]>('/sessions/');
}

/**
 * Fetch a single session by ID.
 */
export async function fetchSession(id: string): Promise<SessionData> {
  return api<SessionData>(`/sessions/${id}`);
}

/**
 * Create a new session from a service request.
 */
export async function createSession(
  data: CreateSessionPayload,
): Promise<SessionData> {
  return api<SessionData>('/sessions/', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Start a session that is currently in the 'scheduled' state.
 */
export async function startSession(id: string): Promise<Session> {
  return api<Session>(`/sessions/${id}/start`, { method: 'PATCH' });
}

/**
 * Mark a session as completed.
 */
export async function completeSession(id: string): Promise<Session> {
  return api<Session>(`/sessions/${id}/complete`, { method: 'PATCH' });
}

/**
 * Submit post-session documentation (notes, Z-codes, billing units, etc.).
 *
 * @param sessionId - Target session ID.
 * @param data      - Documentation payload matching SessionDocumentation shape.
 */
export async function submitDocumentation(
  sessionId: string,
  data: Record<string, unknown>,
): Promise<void> {
  return api<void>(`/sessions/${sessionId}/documentation`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ─── Service Requests ─────────────────────────────────────────────────────────

/**
 * Fetch open service requests available to the current CHW.
 */
export async function fetchRequests(): Promise<ServiceRequest[]> {
  return api<ServiceRequest[]>('/requests/');
}

/**
 * Create a new service request (member-initiated).
 */
export async function createRequest(
  data: Record<string, unknown>,
): Promise<ServiceRequestData> {
  return api<ServiceRequestData>('/requests/', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Accept a service request, creating a session assignment.
 */
export async function acceptRequest(id: string): Promise<ServiceRequest> {
  return api<ServiceRequest>(`/requests/${id}/accept`, { method: 'PATCH' });
}

/**
 * Pass on a service request (CHW is not available / not a fit).
 */
export async function passRequest(id: string): Promise<ServiceRequest> {
  return api<ServiceRequest>(`/requests/${id}/pass`, { method: 'PATCH' });
}

// ─── Conversations ────────────────────────────────────────────────────────────

/**
 * Fetch all conversations visible to the current user.
 */
export async function fetchConversations(): Promise<ConversationSummary[]> {
  return api<ConversationSummary[]>('/conversations/');
}

/**
 * Fetch all messages within a conversation thread.
 */
export async function fetchMessages(conversationId: string): Promise<MessageData[]> {
  return api<MessageData[]>(`/conversations/${conversationId}/messages`);
}

/**
 * Send a text message to a conversation.
 */
export async function sendMessage(
  conversationId: string,
  content: string,
  type = 'text',
): Promise<MessageData> {
  return api<MessageData>(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body: content, type }),
  });
}

// ─── Credentials ──────────────────────────────────────────────────────────────

/**
 * Fetch credential validation records for the current user.
 */
export async function fetchCredentialValidations(): Promise<CredentialValidation[]> {
  return api<CredentialValidation[]>('/credentials/validations');
}

// ─── Earnings ─────────────────────────────────────────────────────────────────

/**
 * Fetch the earnings summary for the currently authenticated CHW.
 */
export async function fetchChwEarnings(): Promise<EarningsSummary> {
  return api<EarningsSummary>('/chw/earnings');
}
