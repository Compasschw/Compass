/**
 * Component test for MemberMessagesScreen — Epic K (mobile web polish).
 *
 * Covers the phone-width single-pane collapse this epic adds: below
 * BP_PHONE (520px) only one of {inbox, conversation} pane is visible at a
 * time (extending the screen's existing <BP_HIDE_INBOX collapse down to
 * phone width), and the CareContextRail — which has no sibling pane to live
 * in at that width — is reachable via a MoreMenu item ("Your care context")
 * rendered as a full-screen overlay instead.
 *
 * Only the network boundary (`../../api/client`), auth context, and
 * navigation hooks are mocked — every data hook (useConversations,
 * useConversationMessages, useMemberProfile, useMemberJourneys,
 * useOwnServicesConsent, usePendingConsents) runs for real against a routed
 * `api()` mock, mirroring CHWMessagesScreen.test.tsx's harness.
 * Tier 2 — jsdom + react-native-web (see native/TESTING.md).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test Member' }),
}));
const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
  useRoute: () => ({ params: {} }),
}));

import { api } from '../../api/client';
import { MemberMessagesScreen, formatApptLabel } from './MemberMessagesScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CONVERSATION_ID = 'conv-1';
const MEMBER_ID = 'member-1';
const CHW_ID = 'chw-1';

const conversationFixture = {
  id: CONVERSATION_ID,
  chw_id: CHW_ID,
  member_id: MEMBER_ID,
  session_id: null,
  active_session_id: null,
  active_session_started_at: null,
  created_at: '2026-06-01T00:00:00.000Z',
  chw_name: 'Test CHW',
  member_name: 'Test Member',
  member_last_active_at: null,
  last_message_preview: 'Hi there',
  last_message_at: '2026-07-11T09:00:00.000Z',
  last_message_sender_id: CHW_ID,
  unread_count: 0,
  pinned_at: null,
  archived_at: null,
  deleted_at: null,
  deleted_by_user_id: null,
};

const memberProfileFixture = {
  id: 'profile-1',
  user_id: MEMBER_ID,
  zip_code: '90001',
  primary_language: 'en',
  primary_need: 'housing',
  rewards_balance: 0,
};

/**
 * Raw (snake_case) session rows returned by the `/sessions/` endpoint mock.
 * Mutable so each test can stage the exact set the CareContextRail's
 * "Upcoming appointment" selector should (or should not) surface. Reset to
 * empty in beforeEach.
 */
let sessionsFixture: Array<Record<string, unknown>> = [];

/** Builds a raw session row; override any field per test. */
function makeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `sess-${Math.random().toString(36).slice(2)}`,
    request_id: 'req-1',
    chw_id: CHW_ID,
    member_id: MEMBER_ID,
    vertical: 'housing',
    status: 'scheduled',
    mode: 'phone',
    scheduled_at: '2099-03-05T18:00:00.000Z',
    scheduled_end_at: '2099-03-05T19:00:00.000Z',
    scheduling_status: 'confirmed',
    proposed_by: 'chw',
    ...overrides,
  };
}

function routeApi(path: string, options?: { method?: string; body?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path.startsWith(`/conversations/${CONVERSATION_ID}/messages`)) {
    if (method === 'GET') return [];
  }

  if (path.startsWith('/conversations/')) {
    return [conversationFixture];
  }

  if (path === '/member/profile') {
    return memberProfileFixture;
  }

  if (path === '/member/services-consent') {
    return null;
  }

  if (path.startsWith('/members/') && path.endsWith('/journeys')) {
    return [];
  }

  if (path.startsWith('/sessions/') && path.endsWith('/pending-consents')) {
    return [];
  }

  // useSessions() — member-scoped session list feeding the rail's
  // "Upcoming appointment" selector.
  if (path === '/sessions/' || path.startsWith('/sessions/?')) {
    return sessionsFixture;
  }

  throw new Error(`Unhandled api() call in MemberMessagesScreen test: ${method} ${path}`);
}

// ─── Harness ──────────────────────────────────────────────────────────────────

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemberMessagesScreen />
    </QueryClientProvider>,
  );
}

/** Wide desktop viewport — plenty of room for all 3 panes at once. */
const WIDE_VIEWPORT_WIDTH = 1400;

/**
 * Waits until useSessions() has actually fetched (the `/sessions/` endpoint was
 * hit and its query resolved), so that "section is hidden" assertions test the
 * post-load state rather than the still-loading one.
 */
async function waitForSessionsLoaded(): Promise<void> {
  await waitFor(() =>
    expect(
      mockedApi.mock.calls.some(([p]) => String(p).startsWith('/sessions/?') || p === '/sessions/'),
    ).toBe(true),
  );
}

/**
 * See CHWMessagesScreen.test.tsx's identical helper for why the property
 * must be set AND a resize event dispatched *before* `render()` is called.
 */
function setViewportWidth(width: number, height = 1000): void {
  Object.defineProperty(document.documentElement, 'clientWidth', {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: height,
    configurable: true,
  });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

beforeAll(() => {
  Object.defineProperty(document.documentElement, 'clientWidth', {
    value: WIDE_VIEWPORT_WIDTH,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: 1000,
    configurable: true,
  });
});

beforeEach(() => {
  mockedApi.mockReset();
  mockNavigate.mockClear();
  sessionsFixture = [];
  mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) =>
    routeApi(path, options),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MemberMessagesScreen — phone-width single-pane collapse (Epic K)', () => {
  const PHONE_VIEWPORT_WIDTH = 390;

  beforeEach(() => {
    setViewportWidth(PHONE_VIEWPORT_WIDTH);
  });

  afterEach(() => {
    setViewportWidth(WIDE_VIEWPORT_WIDTH);
  });

  it('shows the inbox first, then collapses to a single conversation pane with a back control', async () => {
    renderScreen();

    // Initial render at phone width: the inbox pane, not the conversation,
    // is what's showing (showInbox starts true) — only one pane's worth of
    // content at a time.
    const threadRow = await screen.findByText('Test CHW', {}, { timeout: 3000 });
    expect(screen.getByLabelText('Search messages')).toBeTruthy();
    expect(screen.queryByLabelText('Schedule appointment')).toBeNull();

    // Selecting a thread swaps to the conversation pane...
    fireEvent.click(threadRow);
    expect(await screen.findByLabelText('Schedule appointment')).toBeTruthy();
    // ...and the inbox is no longer rendered alongside it.
    expect(screen.queryByLabelText('Search messages')).toBeNull();
    expect(screen.getByLabelText('Back to inbox')).toBeTruthy();

    // Tapping back returns to the inbox.
    fireEvent.click(screen.getByLabelText('Back to inbox'));
    expect(await screen.findByLabelText('Search messages')).toBeTruthy();
    expect(screen.queryByLabelText('Schedule appointment')).toBeNull();
  });

  it('the care context rail is not rendered as a sibling pane, but stays reachable via MoreMenu', async () => {
    renderScreen();
    fireEvent.click(await screen.findByText('Test CHW', {}, { timeout: 3000 }));
    await screen.findByLabelText('Schedule appointment');

    // No sibling rail pane at phone width.
    expect(screen.queryByLabelText('Your care context')).toBeNull();

    // Reachable via the "More options" menu instead.
    fireEvent.click(screen.getByLabelText('More options'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Your care context' }));

    const overlay = await screen.findByLabelText('Your care context');
    expect(overlay).toBeTruthy();

    // Closing the overlay removes the rail again.
    fireEvent.click(screen.getByLabelText('Close care context'));
    await waitFor(() => {
      expect(screen.queryByLabelText('Your care context')).toBeNull();
    });
  });

  it('does not offer the "Your care context" MoreMenu item at wide viewports (rail already visible as its own pane)', async () => {
    setViewportWidth(WIDE_VIEWPORT_WIDTH);
    renderScreen();
    await screen.findAllByText('Test CHW', {}, { timeout: 3000 });

    // Rail already visible as a sibling pane at this width.
    expect(screen.getByLabelText('Your care context')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('More options'));
    expect(screen.queryByRole('menuitem', { name: 'Your care context' })).toBeNull();
  });
});

describe('CareContextRail — Upcoming appointment (real next confirmed session)', () => {
  // Wide viewport so the care-context rail renders as its own pane.
  beforeEach(() => {
    setViewportWidth(WIDE_VIEWPORT_WIDTH);
  });

  it('shows the section with the real date when a future confirmed session exists', async () => {
    const scheduledAt = '2099-03-05T18:00:00.000Z';
    sessionsFixture = [
      makeSession({
        scheduled_at: scheduledAt,
        scheduling_status: 'confirmed',
        status: 'scheduled',
        mode: 'phone',
      }),
    ];
    renderScreen();
    await screen.findAllByText('Test CHW', {}, { timeout: 3000 });

    // Section is present with a date DERIVED from the session (not a hardcoded
    // literal). Compute the expected label with the same formatter the screen
    // uses so the assertion is timezone-independent.
    expect(await screen.findByText('Upcoming appointment')).toBeTruthy();
    expect(screen.getByText(formatApptLabel(scheduledAt))).toBeTruthy();
    // No hardcoded fallbacks remain.
    expect(screen.queryByText('Vermont DPSS office')).toBeNull();
    expect(screen.queryByText('Thursday, June 12 · 2 PM')).toBeNull();
  });

  it('offers "Get directions" only for in-person appointments', async () => {
    sessionsFixture = [makeSession({ mode: 'in_person' })];
    renderScreen();
    await screen.findAllByText('Test CHW', {}, { timeout: 3000 });

    expect(await screen.findByLabelText('Reschedule appointment')).toBeTruthy();
    expect(screen.getByLabelText('Get directions')).toBeTruthy();
  });

  it('omits "Get directions" for a phone appointment (no address on SessionData)', async () => {
    sessionsFixture = [makeSession({ mode: 'phone' })];
    renderScreen();
    await screen.findAllByText('Test CHW', {}, { timeout: 3000 });

    expect(await screen.findByLabelText('Reschedule appointment')).toBeTruthy();
    expect(screen.queryByLabelText('Get directions')).toBeNull();
  });

  it('hides the section entirely when there are no sessions', async () => {
    sessionsFixture = [];
    renderScreen();
    await screen.findAllByText('Test CHW', {}, { timeout: 3000 });
    await waitForSessionsLoaded();

    expect(screen.queryByText('Upcoming appointment')).toBeNull();
    expect(screen.queryByLabelText('Reschedule appointment')).toBeNull();
  });

  it('hides the section for a PAST confirmed session', async () => {
    sessionsFixture = [
      makeSession({ scheduled_at: '2000-01-01T18:00:00.000Z', scheduling_status: 'confirmed' }),
    ];
    renderScreen();
    await screen.findAllByText('Test CHW', {}, { timeout: 3000 });
    await waitForSessionsLoaded();

    expect(screen.queryByText('Upcoming appointment')).toBeNull();
  });

  it('hides the section for a future PENDING (unconfirmed) session', async () => {
    sessionsFixture = [
      makeSession({ scheduled_at: '2099-03-05T18:00:00.000Z', scheduling_status: 'pending' }),
    ];
    renderScreen();
    await screen.findAllByText('Test CHW', {}, { timeout: 3000 });
    await waitForSessionsLoaded();

    expect(screen.queryByText('Upcoming appointment')).toBeNull();
  });

  it('hides the section for a COMPLETED session even if scheduled in the future', async () => {
    sessionsFixture = [
      makeSession({
        scheduled_at: '2099-03-05T18:00:00.000Z',
        scheduling_status: 'confirmed',
        status: 'completed',
      }),
    ];
    renderScreen();
    await screen.findAllByText('Test CHW', {}, { timeout: 3000 });
    await waitForSessionsLoaded();

    expect(screen.queryByText('Upcoming appointment')).toBeNull();
  });

  it('picks the SOONEST future confirmed session when several exist', async () => {
    sessionsFixture = [
      makeSession({ scheduled_at: '2099-06-10T18:00:00.000Z', scheduling_status: 'confirmed' }),
      makeSession({ scheduled_at: '2099-03-05T18:00:00.000Z', scheduling_status: 'confirmed' }),
      makeSession({ scheduled_at: '2099-09-01T18:00:00.000Z', scheduling_status: 'confirmed' }),
    ];
    renderScreen();
    await screen.findAllByText('Test CHW', {}, { timeout: 3000 });

    expect(await screen.findByText('Upcoming appointment')).toBeTruthy();
    expect(screen.getByText(formatApptLabel('2099-03-05T18:00:00.000Z'))).toBeTruthy();
    expect(screen.queryByText(formatApptLabel('2099-06-10T18:00:00.000Z'))).toBeNull();
  });
});
