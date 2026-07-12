/**
 * useActiveChwSession — resolves the CHW's single in-progress session (if
 * any) from the shared conversations query, for the persistent
 * ActiveSessionBadge (see components/sessions/ActiveSessionBadge.tsx).
 *
 * Deliberately thin: it subscribes to `useConversations()` — the SAME query
 * key AppShell's unread-message badge and CHWMessagesScreen already read —
 * so calling this from any CHW screen costs no extra network fetch, just an
 * extra subscriber to an already-fetched cache entry. The backend
 * (activeSessionId / activeSessionStartedAt on ConversationData, written by
 * useStartSession's optimistic update and cleared by end/abort/complete) is
 * the sole source of truth; this hook holds no local start/stop state of its
 * own, so it survives navigation and a page refresh (once conversations
 * refetch) with zero extra plumbing.
 */
import { useConversations } from './useApiQueries';
import { selectActiveChwSession, type ActiveChwSession } from './selectActiveChwSession';

export type { ActiveChwSession };

/**
 * Returns the CHW's active session, or null when none is in progress.
 *
 * Callers should only invoke this for CHW users — a member's conversations
 * never have `activeSessionId` set, so it's harmless there, but pointless.
 */
export function useActiveChwSession(): ActiveChwSession | null {
  const { data: conversations } = useConversations();
  return selectActiveChwSession(conversations);
}
