/**
 * Unit tests for applyThreadFilter — the pure tab filter behind the CHW
 * Messages thread list (All / Unread / Pinned / Archived).
 *
 * Tier 1 (node env): the module has no react-native imports, so no jsdom.
 */
import { describe, it, expect } from 'vitest';

import { applyThreadFilter } from './threadFilter';
import type { ConversationData } from '../../hooks/useApiQueries';

function conv(partial: Partial<ConversationData>): ConversationData {
  return {
    id: 'c',
    memberName: 'Member',
    unreadCount: 0,
    pinnedAt: null,
    archivedAt: null,
    lastMessageAt: null,
    ...partial,
  } as ConversationData;
}

const active = conv({ id: 'active' });
const unread = conv({ id: 'unread', unreadCount: 3 });
const pinned = conv({ id: 'pinned', pinnedAt: '2026-07-01T00:00:00Z' });
const pinnedArchived = conv({
  id: 'pinnedArchived',
  pinnedAt: '2026-07-01T00:00:00Z',
  archivedAt: '2026-07-02T00:00:00Z',
});
const archived = conv({ id: 'archived', archivedAt: '2026-07-01T00:00:00Z' });
const all = [active, unread, pinned, pinnedArchived, archived];

const ids = (list: ConversationData[]) => list.map((c) => c.id);

describe('applyThreadFilter', () => {
  it('all → non-archived conversations only', () => {
    expect(ids(applyThreadFilter(all, 'all'))).toEqual(['active', 'unread', 'pinned']);
  });

  it('unread → conversations with unreadCount > 0', () => {
    expect(ids(applyThreadFilter(all, 'unread'))).toEqual(['unread']);
  });

  it('pinned → pinned conversations, excluding archived', () => {
    // pinnedArchived is pinned but archived → must NOT appear under Pinned.
    expect(ids(applyThreadFilter(all, 'pinned'))).toEqual(['pinned']);
  });

  it('archived → archived conversations only', () => {
    expect(ids(applyThreadFilter(all, 'archived'))).toEqual(['pinnedArchived', 'archived']);
  });
});
