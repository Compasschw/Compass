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
import { MemberMessagesScreen } from './MemberMessagesScreen';

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
