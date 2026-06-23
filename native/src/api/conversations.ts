/**
 * Conversations API — fetch conversation threads and messages, send messages.
 *
 * Mirrors the web API contract at /conversations/.
 *
 * Wire fields use snake_case here (raw API layer); the React Query hooks in
 * useApiQueries.ts apply `transformKeys` to produce the camelCase shapes that
 * screens consume.
 */

import { api } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConversationSummary {
  id: string;
  chw_id: string;
  member_id: string;
  session_id: string | null;
  /**
   * Currently in_progress Session for this conversation, if any.
   * Source-of-truth for End Session / Submit Documentation in the CHW
   * Messages screen — when null, those buttons should be hidden.
   * Populated server-side by app.services.session_lookup (added in #193).
   */
  active_session_id: string | null;
  created_at: string;
  /**
   * Inbox display fields — populated by the Stage 1 backend enrichment
   * (GET /api/v1/conversations/ with include_archived support).
   */
  /** Display name of the CHW participant. */
  chw_name: string;
  /** Display name of the member participant. */
  member_name: string;
  /** Body-truncated preview of the most recent message. Null when no messages yet. */
  last_message_preview: string | null;
  /** ISO8601 timestamp of the most recent message. Null when no messages yet. */
  last_message_at: string | null;
  /** UUID of the user who sent the most recent message. Null when no messages. */
  last_message_sender_id: string | null;
  /** Count of messages the authenticated user has not yet read. */
  unread_count: number;
  /** ISO8601 timestamp when the authenticated user pinned this thread. Null = unpinned. */
  pinned_at: string | null;
  /** ISO8601 timestamp when the authenticated user archived this thread. Null = active. */
  archived_at: string | null;
  /** ISO8601 soft-delete timestamp. Null = not deleted. */
  deleted_at: string | null;
  /** UUID of the user who soft-deleted the thread. Null = not deleted. */
  deleted_by_user_id: string | null;
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
 *
 * @param includeArchived - When true, archived threads are included in the result.
 *   Defaults to false (standard inbox view).
 */
export function fetchConversations(includeArchived = false): Promise<ConversationSummary[]> {
  const qs = includeArchived ? '?include_archived=true' : '';
  return api<ConversationSummary[]>(`/conversations/${qs}`);
}

/**
 * Fetch paginated messages within a specific conversation.
 *
 * Supports cursor-based pagination: pass `before` (ISO8601 timestamp or message ID)
 * to fetch messages older than that cursor, and `limit` for page size.
 *
 * @param conversationId - Target conversation UUID.
 * @param before         - Optional cursor — fetch messages before this value.
 * @param limit          - Max messages to return. Server default applies when omitted.
 */
export function fetchMessages(
  conversationId: string,
  before?: string,
  limit?: number,
): Promise<MessageData[]> {
  const params = new URLSearchParams();
  if (before !== undefined) params.set('before', before);
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString() ? `?${params.toString()}` : '';
  return api<MessageData[]>(`/conversations/${conversationId}/messages${qs}`);
}

/**
 * Send a message to a conversation.
 *
 * Supports optional file attachments previously uploaded via
 * /upload/presigned-url. Mirrors the shape accepted by
 * POST /api/v1/sessions/{id}/messages (same attachment field names).
 *
 * @param conversationId - Target conversation UUID.
 * @param body           - Message body text. May be empty when an attachment is present.
 * @param type           - Message type, defaults to "text".
 * @param attachment     - Optional pre-uploaded file metadata.
 */
export function sendMessage(
  conversationId: string,
  body: string,
  type = 'text',
  attachment?: {
    s3Key: string;
    filename: string;
    sizeBytes: number;
    contentType: string;
  },
): Promise<MessageData> {
  const payload: Record<string, unknown> = { body, type };
  if (attachment !== undefined) {
    payload.attachment_s3_key = attachment.s3Key;
    payload.attachment_filename = attachment.filename;
    payload.attachment_size_bytes = attachment.sizeBytes;
    payload.attachment_content_type = attachment.contentType;
  }
  return api<MessageData>(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * Pin or unpin a conversation thread.
 * PATCH /api/v1/conversations/{id}/pin  body: { pinned: boolean }
 */
export function patchConversationPin(conversationId: string, pinned: boolean): Promise<void> {
  return api<void>(`/conversations/${conversationId}/pin`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned }),
  });
}

/**
 * Archive or unarchive a conversation thread.
 * PATCH /api/v1/conversations/{id}/archive  body: { archived: boolean }
 */
export function patchConversationArchive(
  conversationId: string,
  archived: boolean,
): Promise<void> {
  return api<void>(`/conversations/${conversationId}/archive`, {
    method: 'PATCH',
    body: JSON.stringify({ archived }),
  });
}

/**
 * Mark messages as read up to (and including) the given message ID.
 * POST /api/v1/conversations/{id}/messages/read  body: { up_to_message_id: uuid }
 */
export function postConversationMarkRead(
  conversationId: string,
  upToMessageId: string,
): Promise<void> {
  return api<void>(`/conversations/${conversationId}/messages/read`, {
    method: 'POST',
    body: JSON.stringify({ up_to_message_id: upToMessageId }),
  });
}
