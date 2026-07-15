/**
 * Unit tests for `selectOpenTodoItems` — the shared selector introduced in
 * QA batch (2026-07-14) Part 26.
 *
 * Both MemberHomeScreen's "To do list" tile and MemberJourneyScreen's
 * visible "From Your Sessions" action-items list must filter roadmap items
 * through this exact function so their counts can never drift apart (the
 * bug class being fixed: two independent `.filter()` calls silently
 * diverging over time).
 */
import { describe, expect, it } from 'vitest';
import { selectOpenTodoItems, type SessionFollowup } from './useFollowupQueries';

function buildFollowup(overrides: Partial<SessionFollowup> = {}): SessionFollowup {
  return {
    id: 'followup-1',
    kind: 'action_item',
    description: 'Call the utility company',
    owner: 'member',
    vertical: 'housing',
    priority: 'medium',
    dueDate: null,
    status: 'pending',
    autoCreated: false,
    showOnRoadmap: true,
    confirmedByUserId: null,
    confirmedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('selectOpenTodoItems', () => {
  it('keeps pending and confirmed items', () => {
    const pending = buildFollowup({ id: 'a', status: 'pending' });
    const confirmed = buildFollowup({ id: 'b', status: 'confirmed' });

    const result = selectOpenTodoItems([pending, confirmed]);

    expect(result).toEqual([pending, confirmed]);
  });

  it('excludes completed items', () => {
    const open = buildFollowup({ id: 'open-1', status: 'pending' });
    const completed = buildFollowup({ id: 'done-1', status: 'completed' });

    const result = selectOpenTodoItems([open, completed]);

    expect(result).toEqual([open]);
  });

  it('excludes dismissed items', () => {
    const open = buildFollowup({ id: 'open-1', status: 'pending' });
    const dismissed = buildFollowup({ id: 'dismissed-1', status: 'dismissed' });

    const result = selectOpenTodoItems([open, dismissed]);

    expect(result).toEqual([open]);
  });

  it('returns 3 items from a mixed fixture of open + completed + dismissed (Part 26 test spec)', () => {
    const items = [
      buildFollowup({ id: '1', status: 'pending' }),
      buildFollowup({ id: '2', status: 'confirmed' }),
      buildFollowup({ id: '3', status: 'pending' }),
      buildFollowup({ id: '4', status: 'completed' }),
      buildFollowup({ id: '5', status: 'dismissed' }),
    ];

    const result = selectOpenTodoItems(items);

    expect(result.map((i) => i.id)).toEqual(['1', '2', '3']);
  });

  it('returns an empty array when given an empty array', () => {
    expect(selectOpenTodoItems([])).toEqual([]);
  });
});
