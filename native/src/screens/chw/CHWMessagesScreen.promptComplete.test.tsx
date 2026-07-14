/**
 * Component test for CHWMessagesScreen's `promptComplete` route-param wiring
 * — the auto-open behavior ActiveSessionBadge's "Complete" button relies on
 * (see native/src/components/sessions/ActiveSessionBadge.tsx and
 * MemberContextRail's `promptCompleteOnMount` prop).
 *
 * #19/#20 (2026-07-13): promptComplete now calls POST /sessions/{id}/end and
 * opens DocumentationModal DIRECTLY as an on-brand overlay — there is no
 * longer an intermediate "Complete the session for X?" confirm panel (that
 * panel, and the rail's separate manual "Complete Session" button, were
 * removed; ActiveSessionBadge is now the sole active-session control
 * surface, and it already offers Cancel/Missed before the CHW ever taps
 * Complete).
 *
 * Split into its own file (rather than added to CHWMessagesScreen.test.tsx)
 * because it needs a different `useRoute()` mock — CHWMessagesScreen.test.tsx
 * hardcodes `params: {}` at module scope for its own (unrelated) SDOH-panel
 * suite, and vi.mock factories can't easily be parameterized per-test.
 *
 * Only the network boundary (`../../api/client`), auth context, and
 * navigation hooks are mocked — useConversations, useSession, and the
 * end-session mutation all run for real against a routed `api()` mock
 * (Tier 2 — jsdom + react-native-web, see native/TESTING.md).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test CHW' }),
}));
// See CHWMessagesScreen.test.tsx for why this needs a full literal
// replacement rather than `importOriginal`. This suite's whole point is the
// `promptComplete` route param, so `useRoute` returns it directly.
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
  useRoute: () => ({ params: { memberId: MEMBER_ID, promptComplete: true } }),
}));

import { api } from '../../api/client';
import { CHWMessagesScreen } from './CHWMessagesScreen';
import { SDOH_PANEL_PANE_BREAKPOINT } from '../../components/assessment/InlineSdohPanel';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CONVERSATION_ID = 'conv-1';
const MEMBER_ID = 'member-1';
const CHW_ID = 'chw-1';
const SESSION_ID = 'sess-1';

const conversationFixture = {
  id: CONVERSATION_ID,
  chw_id: CHW_ID,
  member_id: MEMBER_ID,
  session_id: SESSION_ID,
  active_session_id: SESSION_ID,
  active_session_started_at: '2026-07-11T09:00:00.000Z',
  created_at: '2026-06-01T00:00:00.000Z',
  chw_name: 'Test CHW',
  member_name: 'Rosa Gutierrez',
  member_last_active_at: null,
  last_message_preview: 'Hi there',
  last_message_at: '2026-07-11T09:00:00.000Z',
  last_message_sender_id: MEMBER_ID,
  unread_count: 0,
  pinned_at: null,
  archived_at: null,
  deleted_at: null,
  deleted_by_user_id: null,
};

function sessionFixture(status: string) {
  return {
    id: SESSION_ID,
    request_id: 'req-1',
    chw_id: CHW_ID,
    member_id: MEMBER_ID,
    vertical: 'housing',
    status,
    mode: 'call',
    scheduled_at: '2026-07-11T09:00:00.000Z',
    started_at: '2026-07-11T09:00:00.000Z',
  };
}

let currentSessionStatus = 'in_progress';
let currentConsent: string | null = null;
// Mutable per-test `ended_at` the mocked POST /sessions/{id}/end route
// returns, alongside the fixture's fixed `started_at`
// ('2026-07-11T09:00:00.000Z') — lets individual tests control the
// resulting session duration (e.g. a sub-16-minute end time for the
// not-billable-floor test). Defaults to a comfortably-billable 50 minutes.
let endSessionEndedAt = '2026-07-11T09:50:00.000Z';

function routeApi(path: string, options?: { method?: string; body?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path.startsWith(`/conversations/${CONVERSATION_ID}/messages`)) {
    return [];
  }
  if (path.startsWith('/conversations/')) {
    return [conversationFixture];
  }
  if (path.startsWith('/sessions/') && path.endsWith('/end') && method === 'POST') {
    currentSessionStatus = 'awaiting_documentation';
    return {
      ...sessionFixture('awaiting_documentation'),
      started_at: sessionFixture('awaiting_documentation').started_at,
      ended_at: endSessionEndedAt,
    };
  }
  if (path.startsWith('/sessions/')) {
    return sessionFixture(currentSessionStatus);
  }
  if (path === '/chw/journeys') {
    return [];
  }
  if (path.startsWith('/member/services-consent')) {
    return currentConsent ? { value: currentConsent } : null;
  }

  throw new Error(`Unhandled api() call in CHWMessagesScreen promptComplete test: ${method} ${path}`);
}

// ─── Harness ──────────────────────────────────────────────────────────────────

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CHWMessagesScreen />
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  // Wide desktop viewport — MemberContextRail (and the badge's controls)
  // only render above BP_HIDE_RAIL (1280px).
  Object.defineProperty(document.documentElement, 'clientWidth', {
    value: SDOH_PANEL_PANE_BREAKPOINT + 200,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: 1000,
    configurable: true,
  });
});

beforeEach(() => {
  currentSessionStatus = 'in_progress';
  currentConsent = null;
  endSessionEndedAt = '2026-07-11T09:50:00.000Z';
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) =>
    routeApi(path, options),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CHWMessagesScreen — promptComplete route param (ActiveSessionBadge wiring, #19/#20)', () => {
  it('auto-calls POST /sessions/{id}/end and opens DocumentationModal directly — no confirm panel — when landing with promptComplete=true on an in-progress session', async () => {
    renderScreen();

    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });

    // /end fires automatically, with no user interaction / confirm step.
    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(`/sessions/${SESSION_ID}/end`, { method: 'POST' });
    });

    // DocumentationModal opens directly as an overlay.
    await screen.findByLabelText('Close documentation modal', {}, { timeout: 3000 });

    // The old intermediate confirm panel is gone — never rendered at any point.
    expect(screen.queryByText('Complete the session for Rosa?')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Confirm end session' })).toBeNull();

    // On-brand overlay (Epic Q4, re-verified under the new #19/#20 trigger):
    // rendered in-place inside the Messages page, not a full-screen Modal
    // takeover — the thread/composer stays reachable in the same document.
    expect(screen.getByPlaceholderText(/type a message/i)).toBeTruthy();
    expect(screen.getByLabelText('Search message threads')).toBeTruthy();

    // Q1: inline "Units: N" line present (50-minute default fixture duration).
    expect(screen.getByText('Units:')).toBeTruthy();

    // Q3: a grouped diagnosis chip renders inside the overlay.
    fireEvent.click(screen.getByLabelText('Housing'));
    expect(screen.getByLabelText('Z59.00: Homelessness, unspecified')).toBeTruthy();
  });

  it('the 16-minute not-billable gate still blocks submit inside the auto-opened overlay', async () => {
    // 10-minute session (started 09:00, ended 09:10) — under the 16-minute
    // floor, so the overlay's submit must stay blocked.
    endSessionEndedAt = '2026-07-11T09:10:00.000Z';
    renderScreen();

    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });
    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(`/sessions/${SESSION_ID}/end`, { method: 'POST' });
    });
    await screen.findByLabelText('Close documentation modal', {}, { timeout: 3000 });

    expect(
      screen.getByText('Under 16 minutes — not billable; no claim will be filed.'),
    ).toBeTruthy();
    const submit = screen.getByLabelText('Submit documentation and billing');
    expect(submit.getAttribute('aria-disabled')).toBe('true');
  });

  it('does NOT call /end or open the modal when the session is not in a completable state (still scheduled)', async () => {
    currentSessionStatus = 'scheduled';
    renderScreen();

    // Give the auto-select + session query effects a chance to settle.
    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });
    await waitFor(() => {
      expect(screen.getByLabelText('Begin session')).toBeTruthy();
    });

    expect(mockedApi).not.toHaveBeenCalledWith(
      `/sessions/${SESSION_ID}/end`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.queryByLabelText('Close documentation modal')).toBeNull();
  });

  it('does NOT call /end or open the modal when the member has refused services', async () => {
    currentConsent = 'refuse_services';
    renderScreen();

    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });
    // Session is in_progress (default fixture) — the rail shows the
    // read-only "active session, use the badge" note either way (#19/#20
    // removed the rail's own Complete Session control, so there's no
    // separate "disabled — refused services" state to assert on here); what
    // matters is that the auto-complete effect itself stayed gated off.
    await screen.findByLabelText('Active session', {}, { timeout: 3000 });

    expect(mockedApi).not.toHaveBeenCalledWith(
      `/sessions/${SESSION_ID}/end`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.queryByLabelText('Close documentation modal')).toBeNull();
  });

  it('is a one-shot: /end is only called once even if the rail re-renders after the modal opens', async () => {
    renderScreen();

    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });
    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(`/sessions/${SESSION_ID}/end`, { method: 'POST' });
    });
    await screen.findByLabelText('Close documentation modal', {}, { timeout: 3000 });

    const endCallCount = mockedApi.mock.calls.filter(
      (args) => args[0] === `/sessions/${SESSION_ID}/end`,
    ).length;
    expect(endCallCount).toBe(1);
  });
});
