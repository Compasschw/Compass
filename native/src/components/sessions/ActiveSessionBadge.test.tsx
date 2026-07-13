/**
 * Component test for ActiveSessionBadge — the persistent bottom-right
 * "active session" card mounted CHW-only from AppShell.
 *
 * Only the network boundary is out of scope here (the badge reads straight
 * off the react-query cache via useConversations, seeded directly below) and
 * `@react-navigation/native`'s `useNavigation` is mocked — same pattern as
 * CHWCalendarScreen.test.tsx / CHWMessagesScreen.test.tsx. Tier 2 — jsdom +
 * react-native-web (see native/TESTING.md).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
  }),
}));

import { ActiveSessionBadge } from './ActiveSessionBadge';
import { queryKeys, type ConversationData } from '../../hooks/useApiQueries';

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
    window.localStorage.removeItem('compass:activeSessionBadge:dragOffsetY');
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
    fireEvent.mouseMove(document, { clientX: 40, clientY: 140 }); // drag down 40px
    fireEvent.mouseUp(document, { clientX: 40, clientY: 140 });

    // The badge is anchored `bottom: 24` with an 8px edge margin, so a 40px
    // downward drag clamps at the max allowed offset (24 - 8 = 16) rather
    // than passing straight through — this also proves the viewport clamp
    // is live, not just that *some* transform got applied.
    expect(badge.style.transform).toContain('translateY(16px)');
    expect(window.localStorage.getItem('compass:activeSessionBadge:dragOffsetY')).toBe('16');
  });

  it('clamps an upward drag so the badge cannot be dragged above the top of the viewport', () => {
    window.localStorage.removeItem('compass:activeSessionBadge:dragOffsetY');
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
