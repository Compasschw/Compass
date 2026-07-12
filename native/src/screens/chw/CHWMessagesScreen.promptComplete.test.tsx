/**
 * Component test for CHWMessagesScreen's `promptComplete` route-param wiring
 * — the auto-open behavior ActiveSessionBadge's "Complete Session" button
 * relies on (see native/src/components/sessions/ActiveSessionBadge.tsx and
 * MemberContextRail's `promptCompleteOnMount` prop).
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

function routeApi(path: string, options?: { method?: string; body?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path.startsWith(`/conversations/${CONVERSATION_ID}/messages`)) {
    return [];
  }
  if (path.startsWith('/conversations/')) {
    return [conversationFixture];
  }
  if (path.startsWith('/sessions/') && path.endsWith('/end') && method === 'POST') {
    return { ...sessionFixture('awaiting_documentation'), ended_at: new Date().toISOString() };
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
  // Wide desktop viewport — MemberContextRail (and its Complete-Session
  // confirm panel) only renders above BP_HIDE_RAIL (1280px).
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
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) =>
    routeApi(path, options),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CHWMessagesScreen — promptComplete route param (ActiveSessionBadge wiring)', () => {
  it('auto-opens the Complete-Session confirm panel when landing with promptComplete=true on an in-progress session', async () => {
    renderScreen();

    // The confirm panel opens on its own — no click required.
    await waitFor(
      () => {
        expect(screen.getByText('Complete the session for Rosa?')).toBeTruthy();
      },
      { timeout: 3000 },
    );
    expect(screen.getByRole('dialog', { name: 'Confirm end session' })).toBeTruthy();

    // Confirming actually ends the session through the real mutation.
    const proceedBtn = screen.getByLabelText('Confirm complete session');
    fireEvent.click(proceedBtn);

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(`/sessions/${SESSION_ID}/end`, { method: 'POST' });
    });
  });

  it('does NOT auto-open the confirm panel when the session is not in a completable state (still scheduled)', async () => {
    currentSessionStatus = 'scheduled';
    renderScreen();

    // Give the auto-select + session query effects a chance to settle.
    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });
    await waitFor(() => {
      expect(screen.getByLabelText('Begin session')).toBeTruthy();
    });

    expect(screen.queryByText('Complete the session for Rosa?')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Confirm end session' })).toBeNull();
  });

  it('does NOT auto-open the confirm panel when the member has refused services', async () => {
    currentConsent = 'refuse_services';
    renderScreen();

    await screen.findByText('Rosa Gutierrez', {}, { timeout: 3000 });
    await waitFor(() => {
      expect(screen.getByLabelText('Complete session disabled — member has refused services')).toBeTruthy();
    });

    expect(screen.queryByText('Complete the session for Rosa?')).toBeNull();
  });
});
