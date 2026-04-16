/**
 * Conversations API — fetch conversation threads and messages, send messages.
 *
 * Mirrors the web API contract at /conversations/.
 */

import { api } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConversationSummary {
  id: string;
  chw_id: string;
  member_id: string;
  session_id: string | null;
  created_at: string;
}

export interface MessageData {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  type: string;
  created_at: string;
}

// ─── API functions ────────────────────────────────────────────────────────────

/**
 * Fetch all conversations visible to the current user.
 */
export function fetchConversations(): Promise<ConversationSummary[]> {
  return api<ConversationSummary[]>('/conversations/');
}

/**
 * Fetch all messages within a specific conversation.
 */
export function fetchMessages(conversationId: string): Promise<MessageData[]> {
  return api<MessageData[]>(`/conversations/${conversationId}/messages`);
}

/**
 * Send a message to a conversation.
 *
 * @param conversationId - Target conversation ID.
 * @param content        - Message body text.
 * @param type           - Message type, defaults to "text".
 */
export function sendMessage(
  conversationId: string,
  content: string,
  type = 'text',
): Promise<MessageData> {
  return api<MessageData>(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body: content, type }),
  });
}
