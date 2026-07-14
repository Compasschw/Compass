/**
 * Component test for ActiveSessionBadge — the persistent bottom-right
 * "active session" card mounted CHW-only from AppShell.
 *
 * The network boundary (`../../api/client`) is mocked so the Cancel/Missed
 * Session mutations (PATCH /sessions/{id}/abort, /no-show — Epic P + O2) can
 * be asserted without a real backend; the badge otherwise reads straight off
 * the react-query cache via useConversations, seeded directly below.
 * `@react-navigation/native`'s `useNavigation` is mocked — same pattern as
 * CHWCalendarScreen.test.tsx / CHWMessagesScreen.test.tsx. Tier 2 — jsdom +
 * react-native-web (see native/TESTING.md).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
  }),
}));
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});

import { ActiveSessionBadge } from './ActiveSessionBadge';
import { queryKeys, type ConversationData } from '../../hooks/useApiQueries';
import { api } from '../../api/client';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

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

function renderBadge(conversations: ConversationData[]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  qc.setQueryData<ConversationData[]>(queryKeys.conversationList(false), conversations);
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <ActiveSessionBadge />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  mockNavigate.mockReset();
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string }) => {
    const method = options?.method ?? 'GET';
    if (path === '/sessions/sess-1/abort' && method === 'PATCH') {
      return { id: 'sess-1', status: 'cancelled', ended_at: new Date().toISOString() };
    }
    if (path === '/sessions/sess-1/no-show' && method === 'PATCH') {
      return { id: 'sess-1', status: 'no_show', ended_at: new Date().toISOString() };
    }
    throw new Error(`Unhandled api() call in ActiveSessionBadge test: ${method} ${path}`);
  });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-07-11T09:05:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ActiveSessionBadge', () => {
  it('renders nothing when no conversation has an active session', () => {
    const { container } = renderBadge([conv({ id: 'a', activeSessionId: null })]);
    expect(container.querySelector('[data-testid="active-session-badge"]')).toBeNull();
    expect(screen.queryByTestId('active-session-badge')).toBeNull();
  });

  it('renders nothing when there are no conversations at all', () => {
    renderBadge([]);
    expect(screen.queryByTestId('active-session-badge')).toBeNull();
  });

  it('renders the member name and Complete Session button for an active session', () => {
    renderBadge([
      conv({
        id: 'c1',
        activeSessionId: 'sess-1',
        activeSessionStartedAt: '2026-07-11T09:00:00.000Z',
        memberId: 'member-1',
        memberName: 'Rosa Gutierrez',
      }),
    ]);

    expect(screen.getByTestId('active-session-badge')).toBeTruthy();
    expect(screen.getByTestId('active-session-badge-member-name').textContent).toBe(
      'Rosa Gutierrez',
    );
    expect(
      screen.getByRole('button', { name: 'Complete session' }),
    ).toBeTruthy();
  });

  it('shows the elapsed time as MM:SS and ticks forward every second', () => {
    renderBadge([
      conv({
        id: 'c1',
        activeSessionId: 'sess-1',
        activeSessionStartedAt: '2026-07-11T09:00:00.000Z', // 5 minutes before "now"
        memberName: 'Rosa Gutierrez',
      }),
    ]);

    expect(screen.getByTestId('active-session-badge-timer').textContent).toBe('5:00');

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(screen.getByTestId('active-session-badge-timer').textContent).toBe('5:03');
  });

  it('formats elapsed time past an hour as H:MM:SS', () => {
    renderBadge([
      conv({
        id: 'c1',
        activeSessionId: 'sess-1',
        activeSessionStartedAt: '2026-07-11T07:58:30.000Z', // 1h 6m 30s before "now"
        memberName: 'Rosa Gutierrez',
      }),
    ]);

    expect(screen.getByTestId('active-session-badge-timer').textContent).toBe('1:06:30');
  });

  it('navigates to SessionsStack > Messages with the member id and promptComplete on tap', () => {
    renderBadge([
      conv({
        id: 'c1',
        activeSessionId: 'sess-1',
        activeSessionStartedAt: '2026-07-11T09:00:00.000Z',
        memberId: 'member-42',
        memberName: 'Rosa Gutierrez',
      }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Complete session' }));

    expect(mockNavigate).toHaveBeenCalledWith('SessionsStack', {
      screen: 'Messages',
      params: { memberId: 'member-42', promptComplete: true },
    });
  });

  it('picks the most recently started session when more than one conversation is somehow active', () => {
    renderBadge([
      conv({
        id: 'older',
        activeSessionId: 'sess-older',
        activeSessionStartedAt: '2026-07-11T08:00:00.000Z',
        memberName: 'Older Member',
      }),
      conv({
        id: 'newer',
        activeSessionId: 'sess-newer',
        activeSessionStartedAt: '2026-07-11T09:00:00.000Z',
        memberName: 'Newer Member',
      }),
    ]);

    expect(screen.getByTestId('active-session-badge-member-name').textContent).toBe(
      'Newer Member',
    );
  });

  it('renders a drag handle so the badge can be repositioned off the Complete Session control', () => {
    renderBadge([
      conv({
        id: 'c1',
        activeSessionId: 'sess-1',
        activeSessionStartedAt: '2026-07-11T09:00:00.000Z',
        memberName: 'Rosa Gutierrez',
      }),
    ]);

    const handle = screen.getByTestId('active-session-badge-drag-handle');
    expect(handle).toBeTruthy();
    expect(handle.getAttribute('aria-label')).toBe('Drag to move active session badge');
  });

  it('moves the badge (and persists the offset) when the drag handle is dragged vertically', () => {
    window.localStorage.removeItem('compass:activeSessionBadge:dragOffset');
    renderBadge([
      conv({
        id: 'c1',
        activeSessionId: 'sess-1',
        activeSessionStartedAt: '2026-07-11T09:00:00.000Z',
        memberName: 'Rosa Gutierrez',
      }),
    ]);

    const badge = screen.getByTestId('active-session-badge');
    const handle = screen.getByTestId('active-session-badge-drag-handle');

    // Badge starts undragged — no translateY applied yet.
    expect(badge.style.transform || '').not.toMatch(/translateY\((?!0)/);

    fireEvent.mouseDown(handle, { clientX: 40, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 40, clientY: 140 }); // drag down 40px, no horizontal movement
    fireEvent.mouseUp(document, { clientX: 40, clientY: 140 });

    // The badge is anchored `bottom: 24` with an 8px edge margin, so a 40px
    // downward drag clamps at the max allowed offset (24 - 8 = 16) rather
    // than passing straight through — this also proves the viewport clamp
    // is live, not just that *some* transform got applied.
    expect(badge.style.transform).toContain('translateY(16px)');
    expect(JSON.parse(window.localStorage.getItem('compass:activeSessionBadge:dragOffset') ?? '{}')).toEqual({
      x: 0,
      y: 16,
    });
  });

  it('clamps an upward drag so the badge cannot be dragged above the top of the viewport', () => {
    window.localStorage.removeItem('compass:activeSessionBadge:dragOffset');
    renderBadge([
      conv({
        id: 'c1',
        activeSessionId: 'sess-1',
        activeSessionStartedAt: '2026-07-11T09:00:00.000Z',
        memberName: 'Rosa Gutierrez',
      }),
    ]);

    const badge = screen.getByTestId('active-session-badge');
    const handle = screen.getByTestId('active-session-badge-drag-handle');

    // Drag far past the top of a jsdom-default (768px) viewport — should
    // clamp rather than pushing the badge off-screen.
    fireEvent.mouseDown(handle, { clientX: 40, clientY: 600 });
    fireEvent.mouseMove(document, { clientX: 40, clientY: -5000 });
    fireEvent.mouseUp(document, { clientX: 40, clientY: -5000 });

    const match = /translateY\((-?\d+(?:\.\d+)?)px\)/.exec(badge.style.transform || '');
    expect(match).not.toBeNull();
    const appliedOffset = Number(match?.[1]);
    // Never further up than DEFAULT_BOTTOM_OFFSET(24) - (windowHeight - estimatedHeight - margin).
    expect(appliedOffset).toBeGreaterThan(-5000);
    expect(appliedOffset).toBeLessThanOrEqual(16);
  });

  // ─── #19 — full 2D drag (horizontal axis) ──────────────────────────────────

  it('moves the badge horizontally (and persists the offset) when dragged sideways', () => {
    window.localStorage.removeItem('compass:activeSessionBadge:dragOffset');
    renderBadge([
      conv({
        id: 'c1',
        activeSessionId: 'sess-1',
        activeSessionStartedAt: '2026-07-11T09:00:00.000Z',
        memberName: 'Rosa Gutierrez',
      }),
    ]);

    const badge = screen.getByTestId('active-session-badge');
    const handle = screen.getByTestId('active-session-badge-drag-handle');

    expect(badge.style.transform || '').not.toMatch(/translateX\((?!0)/);

    // Drag left by 40px, no vertical movement — the badge is anchored
    // `right: 16` with an 8px edge margin and plenty of viewport width
    // (jsdom default 1024px), so a modest 40px leftward drag is well within
    // bounds and should apply unclamped.
    fireEvent.mouseDown(handle, { clientX: 300, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 260, clientY: 100 });
    fireEvent.mouseUp(document, { clientX: 260, clientY: 100 });

    expect(badge.style.transform).toContain('translateX(-40px)');
    expect(JSON.parse(window.localStorage.getItem('compass:activeSessionBadge:dragOffset') ?? '{}')).toEqual({
      x: -40,
      y: 0,
    });
  });

  it('clamps a rightward drag so the badge cannot be dragged past the right edge of the viewport', () => {
    window.localStorage.removeItem('compass:activeSessionBadge:dragOffset');
    renderBadge([
      conv({
        id: 'c1',
        activeSessionId: 'sess-1',
        activeSessionStartedAt: '2026-07-11T09:00:00.000Z',
        memberName: 'Rosa Gutierrez',
      }),
    ]);

    const badge = screen.getByTestId('active-session-badge');
    const handle = screen.getByTestId('active-session-badge-drag-handle');

    // Drag far past the right edge — should clamp rather than pushing the
    // badge off-screen. Max allowed offset is DEFAULT_RIGHT_OFFSET(16) -
    // DRAG_EDGE_MARGIN(8) = 8.
    fireEvent.mouseDown(handle, { clientX: 300, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 5300, clientY: 100 });
    fireEvent.mouseUp(document, { clientX: 5300, clientY: 100 });

    const match = /translateX\((-?\d+(?:\.\d+)?)px\)/.exec(badge.style.transform || '');
    expect(match).not.toBeNull();
    const appliedOffset = Number(match?.[1]);
    expect(appliedOffset).toBeLessThan(5000);
    expect(appliedOffset).toBeLessThanOrEqual(8);
  });

  it('moves the badge diagonally (both axes at once) in a single drag gesture', () => {
    window.localStorage.removeItem('compass:activeSessionBadge:dragOffset');
    renderBadge([
      conv({
        id: 'c1',
        activeSessionId: 'sess-1',
        activeSessionStartedAt: '2026-07-11T09:00:00.000Z',
        memberName: 'Rosa Gutierrez',
      }),
    ]);

    const badge = screen.getByTestId('active-session-badge');
    const handle = screen.getByTestId('active-session-badge-drag-handle');

    // Y offset kept small (10px) and well within the vertical clamp's max
    // allowed offset (DEFAULT_BOTTOM_OFFSET(24) - DRAG_EDGE_MARGIN(8) = 16,
    // see the dedicated vertical-clamp test above) so both axes move
    // unclamped here — this test is about the two axes moving together in
    // one gesture, not about clamp math (already covered separately per axis).
    fireEvent.mouseDown(handle, { clientX: 300, clientY: 300 });
    fireEvent.mouseMove(document, { clientX: 270, clientY: 310 }); // left 30, down 10
    fireEvent.mouseUp(document, { clientX: 270, clientY: 310 });

    expect(badge.style.transform).toContain('translateX(-30px)');
    expect(badge.style.transform).toContain('translateY(10px)');
    expect(JSON.parse(window.localStorage.getItem('compass:activeSessionBadge:dragOffset') ?? '{}')).toEqual({
      x: -30,
      y: 10,
    });
  });

  it('clears the tick interval on unmount (no leaked timers)', () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const { unmount } = renderBadge([
      conv({
        id: 'c1',
        activeSessionId: 'sess-1',
        activeSessionStartedAt: '2026-07-11T09:00:00.000Z',
        memberName: 'Rosa Gutierrez',
      }),
    ]);

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });
});

// ─── Epic P + O2 — Cancel / Missed Session actions ─────────────────────────────

describe('ActiveSessionBadge — Cancel / Missed Session actions (Epic P + O2)', () => {
  function renderActiveBadge() {
    return renderBadge([
      conv({
        id: 'c1',
        activeSessionId: 'sess-1',
        activeSessionStartedAt: '2026-07-11T09:00:00.000Z',
        memberId: 'member-1',
        memberName: 'Rosa Gutierrez',
      }),
    ]);
  }

  it('shows Cancel, Missed, and Complete actions together', () => {
    renderActiveBadge();

    expect(screen.getByRole('button', { name: 'Cancel session' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark session missed' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete session' })).toBeTruthy();
  });

  it('Cancel opens an in-app confirm modal, never window.confirm', () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    try {
      renderActiveBadge();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));

      expect(screen.getByText('Cancel this session?')).toBeTruthy();
      expect(confirmSpy).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('Missed opens an in-app confirm modal with no-show copy, never window.confirm', () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    try {
      renderActiveBadge();

      fireEvent.click(screen.getByRole('button', { name: 'Mark session missed' }));

      expect(screen.getByText('Mark this session as missed?')).toBeTruthy();
      expect(confirmSpy).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('declining the Cancel confirm modal does not fire the abort mutation', () => {
    renderActiveBadge();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    fireEvent.click(screen.getByRole('button', { name: 'No, keep session' }));

    // react-native-web's Modal keeps its content mounted (opacity: 0) until
    // a real CSS `animationend` fires, which jsdom never dispatches — so we
    // assert the actual behavioral contract (no mutation fired, badge still
    // fully active) rather than DOM removal of the modal markup.
    // (useConversations' own background refetch legitimately calls
    // GET /conversations/ — only the destructive mutation endpoints matter here.)
    expect(mockedApi).not.toHaveBeenCalledWith(
      '/sessions/sess-1/abort',
      expect.anything(),
    );
    expect(mockedApi).not.toHaveBeenCalledWith(
      '/sessions/sess-1/no-show',
      expect.anything(),
    );
    expect(screen.getByTestId('active-session-badge')).toBeTruthy();
    expect(screen.getByTestId('active-session-badge-timer')).toBeTruthy();
  });

  it('confirming Cancel fires PATCH /sessions/{id}/abort and clears the badge', async () => {
    const { qc } = renderActiveBadge();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Cancel Session' }));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        '/sessions/sess-1/abort',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    // The mutation's onSuccess invalidates the sessions cache — the badge
    // itself is driven by the conversations cache, so clear activeSessionId
    // there the way a real refetch would once the backend reflects the
    // cancelled session, and assert the badge unmounts.
    act(() => {
      qc.setQueryData<ConversationData[]>(
        queryKeys.conversationList(false),
        [conv({ id: 'c1', activeSessionId: null, memberName: 'Rosa Gutierrez' })],
      );
    });

    await waitFor(() => {
      expect(screen.queryByTestId('active-session-badge')).toBeNull();
    });
  });

  it('confirming Missed fires PATCH /sessions/{id}/no-show and clears the badge', async () => {
    const { qc } = renderActiveBadge();

    fireEvent.click(screen.getByRole('button', { name: 'Mark session missed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Mark Missed' }));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        '/sessions/sess-1/no-show',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });

    act(() => {
      qc.setQueryData<ConversationData[]>(
        queryKeys.conversationList(false),
        [conv({ id: 'c1', activeSessionId: null, memberName: 'Rosa Gutierrez' })],
      );
    });

    await waitFor(() => {
      expect(screen.queryByTestId('active-session-badge')).toBeNull();
    });
  });

  it('Complete Session still navigates (unchanged) alongside the new actions', () => {
    renderActiveBadge();

    fireEvent.click(screen.getByRole('button', { name: 'Complete session' }));

    expect(mockNavigate).toHaveBeenCalledWith('SessionsStack', {
      screen: 'Messages',
      params: { memberId: 'member-1', promptComplete: true },
    });
  });
});
