/**
 * Pure thread-list filtering for the CHW Messages screen.
 *
 * Kept in its own module (no react-native / navigation imports) so the tab
 * behavior is unit-tested in the node env without dragging in the whole
 * screen. Consumed by CHWMessagesScreen's visible-conversations memo.
 */
import type { ConversationData } from '../../hooks/useApiQueries';

export type ThreadFilterTab = 'all' | 'unread' | 'pinned' | 'archived';

/**
 * Filters conversations for a thread-list tab.
 *
 * - all:      non-archived conversations
 * - unread:   conversations with at least one unread message
 * - pinned:   conversations the CHW has pinned (excludes archived)
 * - archived: archived conversations
 */
export function applyThreadFilter(
  conversations: readonly ConversationData[],
  tab: ThreadFilterTab,
): ConversationData[] {
  switch (tab) {
    case 'archived':
      return conversations.filter((c) => !!c.archivedAt);
    case 'unread':
      return conversations.filter((c) => c.unreadCount > 0);
    case 'pinned':
      return conversations.filter((c) => !!c.pinnedAt && !c.archivedAt);
    default:
      return conversations.filter((c) => !c.archivedAt);
  }
}
