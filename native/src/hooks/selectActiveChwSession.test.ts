/**
 * Unit tests for selectActiveChwSession — the pure selector behind
 * ActiveSessionBadge. Tier 1 (node env): no react-native imports.
 */
import { describe, it, expect } from 'vitest';

import { selectActiveChwSession } from './selectActiveChwSession';
import type { ConversationData } from './useApiQueries';

function conv(partial: Partial<ConversationData>): ConversationData {
  return {
    id: 'c',
    chwId: 'chw-1',
    memberId: 'member-1',
    sessionId: null,
    activeSessionId: null,
    activeSessionStartedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    chwName: 'Test CHW',
    memberName: 'Member',
    memberLastActiveAt: null,
    lastMessagePreview: null,
    lastMessageAt: null,
    lastMessageSenderId: null,
    unreadCount: 0,
    pinnedAt: null,
    archivedAt: null,
    deletedAt: null,
    deletedByUserId: null,
    ...partial,
  };
}

describe('selectActiveChwSession', () => {
  it('returns null when the conversations list is empty', () => {
    expect(selectActiveChwSession([])).toBeNull();
  });

  it('returns null when the conversations list is null/undefined', () => {
    expect(selectActiveChwSession(null)).toBeNull();
    expect(selectActiveChwSession(undefined)).toBeNull();
  });

  it('returns null when no conversation has an active session', () => {
    const list = [
      conv({ id: 'a', activeSessionId: null }),
      conv({ id: 'b', activeSessionId: null }),
    ];
    expect(selectActiveChwSession(list)).toBeNull();
  });

  it('returns the single active session, shaped correctly', () => {
    const list = [
      conv({ id: 'a', activeSessionId: null }),
      conv({
        id: 'b',
        activeSessionId: 'sess-1',
        activeSessionStartedAt: '2026-07-11T09:00:00.000Z',
        memberId: 'member-2',
        memberName: 'Rosa Gutierrez',
      }),
    ];
    expect(selectActiveChwSession(list)).toEqual({
      sessionId: 'sess-1',
      memberId: 'member-2',
      memberName: 'Rosa Gutierrez',
      startedAt: '2026-07-11T09:00:00.000Z',
    });
  });

  it('picks the most recently started session when more than one is active', () => {
    const older = conv({
      id: 'older',
      activeSessionId: 'sess-older',
      activeSessionStartedAt: '2026-07-11T08:00:00.000Z',
      memberName: 'Older Member',
    });
    const newer = conv({
      id: 'newer',
      activeSessionId: 'sess-newer',
      activeSessionStartedAt: '2026-07-11T09:30:00.000Z',
      memberName: 'Newer Member',
    });
    expect(selectActiveChwSession([older, newer])?.sessionId).toBe('sess-newer');
    // Order in the array must not matter.
    expect(selectActiveChwSession([newer, older])?.sessionId).toBe('sess-newer');
  });

  it('treats a null activeSessionStartedAt as the oldest possible — loses every tie-break', () => {
    const noStart = conv({
      id: 'no-start',
      activeSessionId: 'sess-no-start',
      activeSessionStartedAt: null,
    });
    const withStart = conv({
      id: 'with-start',
      activeSessionId: 'sess-with-start',
      activeSessionStartedAt: '2026-07-11T09:00:00.000Z',
    });
    expect(selectActiveChwSession([noStart, withStart])?.sessionId).toBe('sess-with-start');
  });

  it('degrades gracefully when every active session has an unparseable startedAt', () => {
    const a = conv({ id: 'a', activeSessionId: 'sess-a', activeSessionStartedAt: 'not-a-date' });
    const b = conv({ id: 'b', activeSessionId: 'sess-b', activeSessionStartedAt: 'also-not-a-date' });
    // Doesn't throw; deterministically returns one of them (reduce's first element).
    const result = selectActiveChwSession([a, b]);
    expect(result?.sessionId).toBe('sess-a');
  });
});
