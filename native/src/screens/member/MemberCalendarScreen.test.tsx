/**
 * Component + unit coverage for MemberCalendarScreen.
 *
 * Two tiers in this file:
 *
 *  1. Tier-1 pure-function coverage for `deriveBadgeStatus` — the O1 fix
 *     (Compass Batch Plan, Epic O) that stops the calendar auto-labeling any
 *     cancelled session OR any past-but-still-`scheduled` session as
 *     "Missed". MemberCalendarScreen PORTS (copies + adapts) the same badge
 *     logic rather than importing it (see the file's module docstring), so
 *     it needs its own regression coverage rather than relying on the CHW
 *     screen's tests to catch a drift between the two copies.
 *
 *  2. Tier-2 component coverage for the member-side "Pending Session
 *     Requests" widget (MemberPendingRequestsList, mounted above the
 *     calendar) — the reciprocal of CHWCalendarScreen's pending-requests
 *     widget. Only the network boundary (`../../api/client`), auth context,
 *     and navigation hooks are mocked — useSessions, useConfirmSession,
 *     useDeclineSession, and useScheduleSession all run for real against a
 *     routed `api()` mock (Tier 2 — jsdom + react-native-web, see
 *     native/TESTING.md), so this exercises the actual production
 *     mutation-ordering wiring, not a hand-rolled hook mock.
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Tier-1 (pure helper) setup ─────────────────────────────────────────────
//
// @react-navigation/native's real barrel drags in an extension-less import
// that jsdom/vite-node can't resolve (see CHWMessagesScreen.test.tsx /
// CHWCalendarScreen.test.tsx for the same issue) — even the Tier-1 tests
// below need this mock since importing the module evaluates
// MemberCalendarScreen.tsx's top-level imports, which include
// `useNavigation`/`useRoute` from this package.
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

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test Member', logout: vi.fn() }),
}));

import { api } from '../../api/client';
import { deriveBadgeStatus, MemberCalendarScreen } from './MemberCalendarScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

describe('MemberCalendarScreen — deriveBadgeStatus truthful status tags (O1)', () => {
  const now = new Date('2026-07-12T18:00:00.000Z');

  it('maps completed → "Completed"', () => {
    expect(
      deriveBadgeStatus({ status: 'completed', scheduledAt: '2026-07-12T15:00:00.000Z' }, now),
    ).toBe('Completed');
  });

  it('maps cancelled → "Cancelled"', () => {
    expect(
      deriveBadgeStatus({ status: 'cancelled', scheduledAt: '2026-07-12T15:00:00.000Z' }, now),
    ).toBe('Cancelled');
  });

  it('maps cancelled_no_consent → "Cancelled"', () => {
    expect(
      deriveBadgeStatus(
        { status: 'cancelled_no_consent', scheduledAt: '2026-07-12T15:00:00.000Z' },
        now,
      ),
    ).toBe('Cancelled');
  });

  it('maps a still-pending scheduling request → "Pending"', () => {
    expect(
      deriveBadgeStatus(
        { status: 'scheduled', schedulingStatus: 'pending', scheduledAt: '2026-07-12T15:00:00.000Z' },
        now,
      ),
    ).toBe('Pending');
  });

  it('maps an upcoming confirmed session → "Confirmed"', () => {
    const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    expect(deriveBadgeStatus({ status: 'scheduled', scheduledAt: future }, now)).toBe('Confirmed');
  });

  it('does NOT auto-label a past-but-never-started scheduled session "Missed" — stays "Confirmed"', () => {
    const past = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    expect(deriveBadgeStatus({ status: 'scheduled', scheduledAt: past }, now)).toBe('Confirmed');
  });

  it('never produces a "Missed" tag for any past-but-never-started status — the auto-Missed rule is gone', () => {
    const statuses = [
      'scheduled',
      'in_progress',
      'awaiting_documentation',
      'completed',
      'cancelled',
      'cancelled_no_consent',
    ];
    const past = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    for (const status of statuses) {
      expect(deriveBadgeStatus({ status, scheduledAt: past }, now)).not.toBe('Missed');
    }
  });

  // ── Epic O2 — explicit no_show status ("Missed") ─────────────────────────

  it('maps no_show → "Missed"', () => {
    expect(
      deriveBadgeStatus({ status: 'no_show', scheduledAt: '2026-07-12T15:00:00.000Z' }, now),
    ).toBe('Missed');
  });

  it('does not conflate no_show with cancelled — they remain distinct statuses', () => {
    const past = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    expect(deriveBadgeStatus({ status: 'no_show', scheduledAt: past }, now)).toBe('Missed');
    expect(deriveBadgeStatus({ status: 'cancelled', scheduledAt: past }, now)).toBe('Cancelled');
  });
});

// ─── Tier-2 (component) coverage — member-side Pending Session Requests ────

const MEMBER_ID = 'member-1';
const CHW_ID = 'chw-1';
const CHW_NAME = 'Rosa Gutierrez';
const CHW_PROPOSED_SESSION_ID = 'sess-pending-chw-proposed-1';
const MEMBER_PROPOSED_SESSION_ID = 'sess-pending-member-proposed-1';
const LEGACY_PENDING_SESSION_ID = 'sess-pending-legacy-1';
const NEW_SESSION_ID = 'sess-new-1';

// Derived from "now" so the fixture never goes stale, but computed once so
// every helper (fixture + input-value expectations) agrees on the exact same
// wall-clock components regardless of the machine's timezone. Mirrors
// CHWCalendarScreen.test.tsx's fixture-anchoring pattern.
const scheduledStart = new Date();
scheduledStart.setDate(scheduledStart.getDate() + 3);
scheduledStart.setHours(14, 0, 0, 0); // 2:00 PM local
const scheduledEnd = new Date(scheduledStart.getTime() + 60 * 60 * 1000); // 3:00 PM local

function mmddyyyy(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

const EXPECTED_DATE_INPUT = mmddyyyy(scheduledStart);

/** A pending session the CHW proposed — must appear in the member's widget
 *  with all 3 actions (Approve / Decline / Propose New Time). */
const chwProposedSessionFixture = {
  id: CHW_PROPOSED_SESSION_ID,
  request_id: 'req-1',
  chw_id: CHW_ID,
  member_id: MEMBER_ID,
  vertical: 'housing',
  status: 'scheduled',
  mode: 'in_person',
  scheduled_at: scheduledStart.toISOString(),
  scheduled_end_at: scheduledEnd.toISOString(),
  scheduling_status: 'pending',
  proposed_by: 'chw',
  created_at: '2026-07-01T00:00:00.000Z',
  chw_name: CHW_NAME,
  member_name: 'Test Member',
};

/** A pending session the MEMBER proposed — must be EXCLUDED from this
 *  member's own approval widget (they can't approve/decline their own
 *  proposal; the initiator-inversion rule means the CHW acts on this one). */
const memberProposedSessionFixture = {
  id: MEMBER_PROPOSED_SESSION_ID,
  request_id: 'req-2',
  chw_id: CHW_ID,
  member_id: MEMBER_ID,
  vertical: 'housing',
  status: 'scheduled',
  mode: 'in_person',
  scheduled_at: new Date(scheduledStart.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  scheduled_end_at: new Date(scheduledEnd.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  scheduling_status: 'pending',
  proposed_by: 'member',
  created_at: '2026-07-01T00:00:00.000Z',
  chw_name: CHW_NAME,
  member_name: 'Test Member',
};

/** A legacy pending session with no proposed_by field at all — must be
 *  EXCLUDED from the member's widget (safe-default: unknown initiator). */
const legacyPendingSessionFixture = {
  id: LEGACY_PENDING_SESSION_ID,
  request_id: 'req-3',
  chw_id: CHW_ID,
  member_id: MEMBER_ID,
  vertical: 'housing',
  status: 'scheduled',
  mode: 'in_person',
  scheduled_at: new Date(scheduledStart.getTime() + 48 * 60 * 60 * 1000).toISOString(),
  scheduled_end_at: new Date(scheduledEnd.getTime() + 48 * 60 * 60 * 1000).toISOString(),
  scheduling_status: 'pending',
  created_at: '2026-07-01T00:00:00.000Z',
  chw_name: CHW_NAME,
  member_name: 'Test Member',
};

let scheduleShouldFail = false;
/** Extra session rows layered onto the base '/sessions/' GET response, reset
 *  in the top-level beforeEach — individual describe blocks opt in. */
let additionalSessionFixtures: unknown[] = [];

function routeApi(path: string, options?: { method?: string; body?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path === '/sessions/schedule' && method === 'POST') {
    if (scheduleShouldFail) {
      throw new Error('Network error');
    }
    const body = options?.body ? JSON.parse(options.body) : {};
    return {
      id: NEW_SESSION_ID,
      request_id: 'req-new',
      chw_id: body.chw_id,
      member_id: MEMBER_ID,
      vertical: 'housing',
      status: 'scheduled',
      mode: body.mode,
      scheduled_at: body.scheduled_at,
      scheduled_end_at: body.scheduled_end_at,
      scheduling_status: body.scheduling_status,
      proposed_by: 'member',
      created_at: new Date().toISOString(),
      chw_name: CHW_NAME,
      member_name: 'Test Member',
    };
  }

  if (path === `/sessions/${CHW_PROPOSED_SESSION_ID}/decline` && method === 'PATCH') {
    return { ...chwProposedSessionFixture, status: 'cancelled', scheduling_status: null };
  }

  if (path === `/sessions/${CHW_PROPOSED_SESSION_ID}/confirm` && method === 'PATCH') {
    return { ...chwProposedSessionFixture, scheduling_status: 'confirmed' };
  }

  if (path === '/sessions/' && method === 'GET') {
    return [chwProposedSessionFixture, ...additionalSessionFixtures];
  }

  if (path.startsWith('/member/chws/')) {
    return { availabilityWindows: undefined };
  }

  throw new Error(`Unhandled api() call in MemberCalendarScreen test: ${method} ${path}`);
}

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemberCalendarScreen />
    </QueryClientProvider>,
  );
}

/** Opens the "Propose New Time" modal for the CHW-proposed fixture request. */
async function openProposeModal(): Promise<void> {
  const proposeBtn = await screen.findByLabelText(`Propose new time for ${CHW_NAME}`);
  fireEvent.click(proposeBtn);
  await screen.findByLabelText('Propose new time'); // submit button, proves the modal opened
}

beforeEach(() => {
  scheduleShouldFail = false;
  additionalSessionFixtures = [];
  mockNavigate.mockClear();
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) =>
    routeApi(path, options),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('MemberCalendarScreen — Pending Session Requests widget (member POV)', () => {
  it('renders a CHW-proposed pending request with all 3 actions (Approve / Decline / Propose New Time)', async () => {
    renderScreen();

    expect(await screen.findByLabelText(`Approve request from ${CHW_NAME}`)).toBeTruthy();
    expect(screen.getByLabelText(`Decline request from ${CHW_NAME}`)).toBeTruthy();
    expect(screen.getByLabelText(`Propose new time for ${CHW_NAME}`)).toBeTruthy();
  });

  it('does NOT show a member-proposed pending request (proposedBy: "member")', async () => {
    additionalSessionFixtures = [memberProposedSessionFixture];
    renderScreen();

    // The CHW-proposed fixture still renders (proves the widget loaded)...
    await screen.findByLabelText(`Approve request from ${CHW_NAME}`);
    // ...but only ONE pending row should be actionable — the member-proposed
    // one must not add a second Approve/Decline/Propose row. Since both
    // fixtures share the same CHW name, we assert exactly one Approve button
    // total rather than a per-name query.
    expect(screen.getAllByLabelText(`Approve request from ${CHW_NAME}`).length).toBe(1);
  });

  it('does NOT show a legacy pending request with no proposedBy field (safe-default exclusion)', async () => {
    additionalSessionFixtures = [legacyPendingSessionFixture];
    renderScreen();

    await screen.findByLabelText(`Approve request from ${CHW_NAME}`);
    // Same reasoning as above: legacy row must not add a second actionable row.
    expect(screen.getAllByLabelText(`Approve request from ${CHW_NAME}`).length).toBe(1);
  });

  it('Approve fires the confirm mutation against PATCH /sessions/{id}/confirm', async () => {
    renderScreen();

    const approveBtn = await screen.findByLabelText(`Approve request from ${CHW_NAME}`);
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(
        mockedApi.mock.calls.some(
          ([path, opts]) =>
            path === `/sessions/${CHW_PROPOSED_SESSION_ID}/confirm` &&
            (opts as { method?: string })?.method === 'PATCH',
        ),
      ).toBe(true);
    });
  });

  it('Decline shows an on-brand confirm dialog first, and only calls the API after confirming', async () => {
    renderScreen();

    const declineBtn = await screen.findByLabelText(`Decline request from ${CHW_NAME}`);
    fireEvent.click(declineBtn);

    // The confirm dialog appears (on-brand Modal, not window.confirm) — the
    // decline API call must NOT have fired yet.
    const confirmBtn = await screen.findByLabelText('Yes, decline request');
    expect(
      mockedApi.mock.calls.some(([path]) => path === `/sessions/${CHW_PROPOSED_SESSION_ID}/decline`),
    ).toBe(false);

    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(
        mockedApi.mock.calls.some(
          ([path, opts]) =>
            path === `/sessions/${CHW_PROPOSED_SESSION_ID}/decline` &&
            (opts as { method?: string })?.method === 'PATCH',
        ),
      ).toBe(true);
    });
  });

  it('opens the Propose New Time modal prefilled with the request\'s date/time', async () => {
    renderScreen();
    await openProposeModal();

    expect((screen.getByLabelText('Session date') as HTMLInputElement).value).toBe(EXPECTED_DATE_INPUT);
    expect((screen.getByLabelText('Session start time') as HTMLInputElement).value).toBe('2:00 PM');
    expect((screen.getByLabelText('Session end time') as HTMLInputElement).value).toBe('3:00 PM');
  });

  it('Propose New Time books the new session BEFORE declining the old one (never the reverse)', async () => {
    renderScreen();
    await openProposeModal();

    fireEvent.change(screen.getByLabelText('Session start time'), { target: { value: '9:00 AM' } });
    fireEvent.change(screen.getByLabelText('Session end time'), { target: { value: '10:00 AM' } });

    fireEvent.click(screen.getByLabelText('Propose new time'));

    await waitFor(() => {
      expect(mockedApi.mock.calls.some(([path]) => path === '/sessions/schedule')).toBe(true);
    });
    await waitFor(() => {
      expect(
        mockedApi.mock.calls.some(([path]) => path === `/sessions/${CHW_PROPOSED_SESSION_ID}/decline`),
      ).toBe(true);
    });

    const scheduleCallIndex = mockedApi.mock.calls.findIndex(([path]) => path === '/sessions/schedule');
    const declineCallIndex = mockedApi.mock.calls.findIndex(
      ([path]) => path === `/sessions/${CHW_PROPOSED_SESSION_ID}/decline`,
    );
    // The new session must be booked BEFORE the old one is declined — the
    // ordering that keeps a failed re-book from losing the member's session.
    expect(scheduleCallIndex).toBeGreaterThanOrEqual(0);
    expect(declineCallIndex).toBeGreaterThan(scheduleCallIndex);

    const [, scheduleOptions] = mockedApi.mock.calls[scheduleCallIndex];
    const scheduleBody = JSON.parse((scheduleOptions as { body: string }).body);
    expect(scheduleBody.chw_id).toBe(CHW_ID);
    expect(scheduleBody.scheduling_status).toBe('pending');

    const [declinePath, declineOptions] = mockedApi.mock.calls[declineCallIndex];
    expect(declinePath).toBe(`/sessions/${CHW_PROPOSED_SESSION_ID}/decline`);
    expect((declineOptions as { method?: string })?.method).toBe('PATCH');
  });

  it('does NOT decline the original session when the new booking fails', async () => {
    scheduleShouldFail = true;
    renderScreen();
    await openProposeModal();

    fireEvent.click(screen.getByLabelText('Propose new time'));

    await waitFor(() => {
      expect(mockedApi.mock.calls.some(([path]) => path === '/sessions/schedule')).toBe(true);
    });

    // The decline call must never fire — the original pending request is
    // preserved when the re-book fails.
    expect(
      mockedApi.mock.calls.some(([path]) => path === `/sessions/${CHW_PROPOSED_SESSION_ID}/decline`),
    ).toBe(false);

    // The modal stays open (not silently closed) so the member can retry.
    expect(screen.getByLabelText('Propose new time')).toBeTruthy();
  });
});
