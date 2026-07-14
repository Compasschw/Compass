/**
 * Component test for CHWCalendarScreen's "Propose New Time" reschedule flow.
 *
 * A CHW can counter-offer a different time for a member-requested pending
 * session directly from the Pending Session Requests widget, instead of only
 * Approve/Decline. This mirrors MemberCalendarScreen's `replaceSessionId`
 * reschedule pattern: the new (pending) session is booked FIRST, and only
 * after that succeeds is the original request declined — so a failed re-book
 * never loses the member's original session.
 *
 * Only the network boundary (`../../api/client`), auth context, and
 * navigation hooks are mocked — useSessions, useChwMembers, useScheduleSession,
 * useConfirmSession, and useDeclineSession all run for real against a routed
 * `api()` mock (Tier 2 — jsdom + react-native-web, see native/TESTING.md), so
 * this exercises the actual production mutation-ordering wiring, not a
 * hand-rolled hook mock.
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test CHW', logout: vi.fn() }),
}));
// See CHWMessagesScreen.test.tsx for why this needs a full literal
// replacement rather than `importOriginal` — @react-navigation/native's real
// barrel drags in an extension-less import that jsdom/vite-node can't
// resolve. CHWCalendarScreen only uses `useNavigation` from this package.
// `mockNavigate` is hoisted so every `useNavigation()` call across re-renders
// returns the SAME spy — needed to assert "Begin Session" navigates after it
// starts the session.
const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
}));

import { api } from '../../api/client';
import type { SessionData } from '../../hooks/useApiQueries';
import { CHWCalendarScreen, deriveBadgeStatus } from './CHWCalendarScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// Day-view "today" fixture anchoring.
//
// The component derives which calendar day the Day view shows from module-level
// constants (`TODAY_YEAR/MONTH/DAY = new Date()` in CHWCalendarScreen.tsx),
// captured at import from the REAL clock — test-level fake timers can't override
// them. So fixtures MUST be anchored to the real current day too, and the
// Session Details "Begin Session" gate (`new Date(scheduledAt) >= now`) needs
// upcoming fixtures to be genuinely in the future.
//
// The old `Date.now() ± Nh` offsets rolled across local midnight in CI (e.g.
// `Date.now() - 5h` landed on the prior day between 00:00–05:00 UTC), dropping
// the fixture out of today's bucket. Instead, clamp every offset INSIDE today:
//   PAST_TODAY   — halfway between local midnight and now (always today, < now)
//   FUTURE_TODAY — halfway between now and local end-of-day (always today, > now)
// These can never cross a day boundary regardless of the run's wall-clock time.
const _fxNow = new Date();
const _startOfToday = new Date(_fxNow);
_startOfToday.setHours(0, 0, 0, 0);
const _endOfToday = new Date(_fxNow);
_endOfToday.setHours(23, 59, 59, 999);
const PAST_TODAY = new Date((_startOfToday.getTime() + _fxNow.getTime()) / 2);
const FUTURE_TODAY = new Date((_fxNow.getTime() + _endOfToday.getTime()) / 2);

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CHW_ID = 'chw-1';
const MEMBER_ID = 'member-1';
const MEMBER_NAME = 'Rosa Gutierrez';
const PENDING_SESSION_ID = 'sess-pending-1';
const NEW_SESSION_ID = 'sess-new-1';

// Derived from "now" so the fixture never goes stale, but computed once so
// every helper (fixture + input-value expectations) agrees on the exact same
// wall-clock components regardless of the machine's timezone.
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
const EXPECTED_START_TIME_INPUT = '2:00 PM';
const EXPECTED_END_TIME_INPUT = '3:00 PM';

const pendingSessionFixture = {
  id: PENDING_SESSION_ID,
  request_id: 'req-1',
  chw_id: CHW_ID,
  member_id: MEMBER_ID,
  vertical: 'housing',
  status: 'scheduled',
  mode: 'in_person',
  scheduled_at: scheduledStart.toISOString(),
  scheduled_end_at: scheduledEnd.toISOString(),
  scheduling_status: 'pending',
  created_at: '2026-07-01T00:00:00.000Z',
  chw_name: 'Test CHW',
  member_name: MEMBER_NAME,
};

const memberRosterFixture = {
  id: MEMBER_ID,
  display_name: MEMBER_NAME,
  age: 34,
  date_of_birth: '1992-01-01',
  masked_id: '...1234',
  avatar_initials: 'RG',
  status: 'active',
  risk: null,
  engagement: 'moderately',
  active_journey: null,
  last_contact_at: null,
  top_need: null,
};

// ─── Session Details modal fixtures (Begin Session / Propose / Remove) ───────
//
// These use "today" offsets (not "+3 days") so they always land in Day view's
// todaySessions bucket regardless of which day of the week/month the suite
// runs on — Day view is hardcoded to the real calendar date, sidestepping any
// month/week-navigation flakiness. Distinct member names disambiguate the two
// same-day SessionCards by accessible name.

const CONFIRMED_SESSION_ID = 'sess-confirmed-1';
const COMPLETED_SESSION_ID = 'sess-completed-1';
const MEMBER_ID_2 = 'member-2';
const MEMBER_NAME_2 = 'Diego Alvarez';

const confirmedUpcomingStart = new Date(FUTURE_TODAY); // upcoming, today (never rolls)
const confirmedUpcomingEnd = new Date(confirmedUpcomingStart.getTime() + 60 * 60 * 1000);

const confirmedSessionFixture = {
  id: CONFIRMED_SESSION_ID,
  request_id: 'req-3',
  chw_id: CHW_ID,
  member_id: MEMBER_ID,
  vertical: 'housing',
  status: 'scheduled',
  mode: 'in_person',
  scheduled_at: confirmedUpcomingStart.toISOString(),
  scheduled_end_at: confirmedUpcomingEnd.toISOString(),
  scheduling_status: 'confirmed',
  created_at: '2026-07-01T00:00:00.000Z',
  chw_name: 'Test CHW',
  member_name: MEMBER_NAME,
};

const completedStart = new Date(PAST_TODAY); // earlier today (never rolls)
const completedEnd = new Date(completedStart.getTime() + 60 * 60 * 1000);

const completedSessionFixture = {
  id: COMPLETED_SESSION_ID,
  request_id: 'req-4',
  chw_id: CHW_ID,
  member_id: MEMBER_ID_2,
  vertical: 'housing',
  status: 'completed',
  mode: 'in_person',
  scheduled_at: completedStart.toISOString(),
  scheduled_end_at: completedEnd.toISOString(),
  scheduling_status: 'confirmed',
  created_at: '2026-07-01T00:00:00.000Z',
  chw_name: 'Test CHW',
  member_name: MEMBER_NAME_2,
};

// ─── Fixtures for N1 (cancelled sessions vanish from the grid) and O1
// (truthful status tags — no auto-"Missed") ────────────────────────────────
//
// Both use "today" offsets for the same Day-view-bucketing reason as above.

const CANCELLED_SESSION_ID = 'sess-cancelled-1';
const MEMBER_ID_3 = 'member-3';
const MEMBER_NAME_3 = 'Priya Nair';

const cancelledStart = new Date(FUTURE_TODAY); // upcoming, today (never rolls)
const cancelledEnd = new Date(cancelledStart.getTime() + 60 * 60 * 1000);

/** A session the CHW Removed — status flips to 'cancelled' by useCancelSession. */
const cancelledSessionFixture = {
  id: CANCELLED_SESSION_ID,
  request_id: 'req-5',
  chw_id: CHW_ID,
  member_id: MEMBER_ID_3,
  vertical: 'housing',
  status: 'cancelled',
  mode: 'in_person',
  scheduled_at: cancelledStart.toISOString(),
  scheduled_end_at: cancelledEnd.toISOString(),
  scheduling_status: null,
  created_at: '2026-07-01T00:00:00.000Z',
  chw_name: 'Test CHW',
  member_name: MEMBER_NAME_3,
};

const PAST_SCHEDULED_SESSION_ID = 'sess-past-scheduled-1';
const MEMBER_ID_4 = 'member-4';
const MEMBER_NAME_4 = 'Sam Okafor';

const pastScheduledStart = new Date(PAST_TODAY); // time passed but never started, today
const pastScheduledEnd = new Date(pastScheduledStart.getTime() + 60 * 60 * 1000);

/** A confirmed session whose time passed but the CHW never began it —
 *  stays `status: 'scheduled'`. Must NOT be auto-labeled "Missed" (O1). */
const pastScheduledSessionFixture = {
  id: PAST_SCHEDULED_SESSION_ID,
  request_id: 'req-6',
  chw_id: CHW_ID,
  member_id: MEMBER_ID_4,
  vertical: 'housing',
  status: 'scheduled',
  mode: 'in_person',
  scheduled_at: pastScheduledStart.toISOString(),
  scheduled_end_at: pastScheduledEnd.toISOString(),
  scheduling_status: 'confirmed',
  created_at: '2026-07-01T00:00:00.000Z',
  chw_name: 'Test CHW',
  member_name: MEMBER_NAME_4,
};

// ─── QA2 A2 #17 — CHW-proposed pending session, "today" (Session Details) ────

const CHW_PROPOSED_TODAY_SESSION_ID = 'sess-chw-proposed-today-1';
const MEMBER_ID_8 = 'member-8';
const MEMBER_NAME_8 = 'Lucia Fernandez';

const chwProposedTodayStart = new Date(FUTURE_TODAY); // upcoming, today (never rolls)
const chwProposedTodayEnd = new Date(chwProposedTodayStart.getTime() + 60 * 60 * 1000);

/** A pending session THIS CHW proposed (proposedBy: 'chw'), anchored to today
 *  so it lands in Day view's todaySessions bucket — used to assert Session
 *  Details shows Remove + Propose New Time (no Confirm/Decline on your own
 *  proposal) for this branch, distinct from pendingSessionFixture's
 *  member-requested Confirm/Decline branch. */
const chwProposedTodaySessionFixture = {
  id: CHW_PROPOSED_TODAY_SESSION_ID,
  request_id: 'req-10',
  chw_id: CHW_ID,
  member_id: MEMBER_ID_8,
  vertical: 'housing',
  status: 'scheduled',
  mode: 'in_person',
  scheduled_at: chwProposedTodayStart.toISOString(),
  scheduled_end_at: chwProposedTodayEnd.toISOString(),
  scheduling_status: 'pending',
  proposed_by: 'chw',
  created_at: '2026-07-01T00:00:00.000Z',
  chw_name: 'Test CHW',
  member_name: MEMBER_NAME_8,
};

// ─── Epic L — Resource Needs fixtures ────────────────────────────────────────

const RESOURCE_NEEDS_SESSION_ID = 'sess-resource-needs-1';
const MEMBER_ID_5 = 'member-5';
const MEMBER_NAME_5 = 'Kenji Watanabe';

const resourceNeedsStart = new Date(FUTURE_TODAY); // upcoming, today (never rolls)
const resourceNeedsEnd = new Date(resourceNeedsStart.getTime() + 60 * 60 * 1000);

/** A confirmed session with resource_needs selected on schedule — used to
 *  assert Session Details renders the chips where Notes used to appear. */
const resourceNeedsSessionFixture = {
  id: RESOURCE_NEEDS_SESSION_ID,
  request_id: 'req-7',
  chw_id: CHW_ID,
  member_id: MEMBER_ID_5,
  vertical: 'housing',
  status: 'scheduled',
  mode: 'in_person',
  scheduled_at: resourceNeedsStart.toISOString(),
  scheduled_end_at: resourceNeedsEnd.toISOString(),
  scheduling_status: 'confirmed',
  resource_needs: ['housing', 'food'],
  created_at: '2026-07-01T00:00:00.000Z',
  chw_name: 'Test CHW',
  member_name: MEMBER_NAME_5,
};

// ─── proposedBy fixtures (initiator-inversion filter) ────────────────────────
//
// pendingSessionFixture above has no proposed_by field at all — that's the
// legacy case (pre-existing rows scheduled before this field existed) and
// must CONTINUE to show in the CHW's approval queue. These two extra fixtures
// cover the CHW-proposed (excluded) and member-proposed (included,
// unaffected) cases.

const CHW_PROPOSED_SESSION_ID = 'sess-pending-chw-proposed-1';
const MEMBER_ID_6 = 'member-6';
const MEMBER_NAME_6 = 'Elena Cruz';

const chwProposedStart = new Date();
chwProposedStart.setDate(chwProposedStart.getDate() + 4);
chwProposedStart.setHours(11, 0, 0, 0);
const chwProposedEnd = new Date(chwProposedStart.getTime() + 60 * 60 * 1000);

/** A pending session THIS CHW proposed (e.g. via "Propose New Time") — awaits
 *  the MEMBER's approval, so it must NOT appear in the CHW's own queue. */
const chwProposedSessionFixture = {
  id: CHW_PROPOSED_SESSION_ID,
  request_id: 'req-8',
  chw_id: CHW_ID,
  member_id: MEMBER_ID_6,
  vertical: 'housing',
  status: 'scheduled',
  mode: 'in_person',
  scheduled_at: chwProposedStart.toISOString(),
  scheduled_end_at: chwProposedEnd.toISOString(),
  scheduling_status: 'pending',
  proposed_by: 'chw',
  created_at: '2026-07-01T00:00:00.000Z',
  chw_name: 'Test CHW',
  member_name: MEMBER_NAME_6,
};

const MEMBER_PROPOSED_SESSION_ID = 'sess-pending-member-proposed-1';
const MEMBER_ID_7 = 'member-7';
const MEMBER_NAME_7 = 'Farid Haidari';

const memberProposedStart = new Date();
memberProposedStart.setDate(memberProposedStart.getDate() + 5);
memberProposedStart.setHours(13, 0, 0, 0);
const memberProposedEnd = new Date(memberProposedStart.getTime() + 60 * 60 * 1000);

/** A pending session the MEMBER proposed — explicitly proposed_by: 'member'.
 *  Must remain visible/actionable in the CHW's queue, unaffected by the
 *  proposedBy !== 'chw' filter change. */
const memberProposedSessionFixture = {
  id: MEMBER_PROPOSED_SESSION_ID,
  request_id: 'req-9',
  chw_id: CHW_ID,
  member_id: MEMBER_ID_7,
  vertical: 'housing',
  status: 'scheduled',
  mode: 'in_person',
  scheduled_at: memberProposedStart.toISOString(),
  scheduled_end_at: memberProposedEnd.toISOString(),
  scheduling_status: 'pending',
  proposed_by: 'member',
  created_at: '2026-07-01T00:00:00.000Z',
  chw_name: 'Test CHW',
  member_name: MEMBER_NAME_7,
};

// ─── API router — the sole network boundary ──────────────────────────────────

let scheduleShouldFail = false;
let startShouldFail = false;
/** Extra session rows layered onto the base '/sessions/' GET response, reset
 *  to [] in the top-level beforeEach — individual describe blocks opt in. */
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
      request_id: 'req-2',
      chw_id: CHW_ID,
      member_id: body.member_id,
      vertical: 'housing',
      status: 'scheduled',
      mode: body.mode,
      scheduled_at: body.scheduled_at,
      scheduled_end_at: body.scheduled_end_at,
      scheduling_status: body.scheduling_status,
      resource_needs: body.resource_needs,
      created_at: new Date().toISOString(),
      chw_name: 'Test CHW',
      member_name: MEMBER_NAME,
    };
  }

  if (path === `/sessions/${PENDING_SESSION_ID}/decline` && method === 'PATCH') {
    return { ...pendingSessionFixture, status: 'cancelled', scheduling_status: null };
  }

  if (path === `/sessions/${PENDING_SESSION_ID}/confirm` && method === 'PATCH') {
    return { ...pendingSessionFixture, scheduling_status: 'confirmed' };
  }

  if (path === `/sessions/${CONFIRMED_SESSION_ID}/start` && method === 'PATCH') {
    if (startShouldFail) {
      throw new Error('Could not start session');
    }
    return { ...confirmedSessionFixture, status: 'in_progress' };
  }

  if (path === `/sessions/${CONFIRMED_SESSION_ID}/cancel` && method === 'PATCH') {
    return { ...confirmedSessionFixture, status: 'cancelled' };
  }

  if (path === `/sessions/${CONFIRMED_SESSION_ID}/decline` && method === 'PATCH') {
    return { ...confirmedSessionFixture, status: 'cancelled', scheduling_status: null };
  }

  if (path === `/sessions/${CHW_PROPOSED_TODAY_SESSION_ID}/cancel` && method === 'PATCH') {
    return { ...chwProposedTodaySessionFixture, status: 'cancelled' };
  }

  if (path === '/sessions/' && method === 'GET') {
    return [
      pendingSessionFixture,
      confirmedSessionFixture,
      completedSessionFixture,
      ...additionalSessionFixtures,
    ];
  }

  if (path === '/chw/members' && method === 'GET') {
    return [memberRosterFixture];
  }

  if (path.startsWith('/conversations/')) {
    return [];
  }

  throw new Error(`Unhandled api() call in CHWCalendarScreen test: ${method} ${path}`);
}

// ─── Harness ──────────────────────────────────────────────────────────────────

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CHWCalendarScreen />
    </QueryClientProvider>,
  );
}

/** Opens the "Propose New Time" modal for the fixture's pending request. */
async function openProposeModal(): Promise<void> {
  const proposeBtn = await screen.findByLabelText(`Propose new time for ${MEMBER_NAME}`);
  fireEvent.click(proposeBtn);
  await screen.findByLabelText('Propose new time'); // submit button, proves the modal opened
}

beforeEach(() => {
  scheduleShouldFail = false;
  startShouldFail = false;
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CHWCalendarScreen — Pending Session Requests "Propose New Time"', () => {
  it('renders a "Propose New Time" button on the pending request row, to the left of Decline', async () => {
    renderScreen();

    const proposeBtn = await screen.findByLabelText(`Propose new time for ${MEMBER_NAME}`);
    const declineBtn = await screen.findByLabelText(`Decline request from ${MEMBER_NAME}`);

    expect(proposeBtn).toBeTruthy();
    expect(declineBtn).toBeTruthy();
    // DOCUMENT_POSITION_FOLLOWING on declineBtn (relative to proposeBtn) means
    // proposeBtn comes first in DOM order — i.e. to the left in the row's
    // flex-row layout.
    // eslint-disable-next-line no-bitwise
    expect(proposeBtn.compareDocumentPosition(declineBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens the modal prefilled with the member + the request\'s date/time, titled "Propose New Time"', async () => {
    renderScreen();
    await openProposeModal();

    // Text "Propose New Time" appears 3 times once the modal is open: the
    // still-rendered row trigger button behind the modal, the modal header,
    // and the modal's submit button — proving the default "Schedule Session"
    // title was replaced for this mode.
    expect(screen.getAllByText('Propose New Time').length).toBe(3);

    // Member is locked to the request's member — shown both in the pending
    // row (behind the modal) and as the modal's locked selection — with no
    // "Clear member selection" control while in propose mode.
    expect(screen.getAllByText(MEMBER_NAME).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByLabelText('Clear member selection')).toBeNull();

    // Date/time inputs are prefilled from the original session's schedule,
    // round-tripped through the same MM/DD/YYYY + "h:mm AM/PM" formats the
    // modal itself parses on submit.
    expect((screen.getByLabelText('Session date') as HTMLInputElement).value).toBe(EXPECTED_DATE_INPUT);
    expect((screen.getByLabelText('Session start time') as HTMLInputElement).value).toBe(
      EXPECTED_START_TIME_INPUT,
    );
    expect((screen.getByLabelText('Session end time') as HTMLInputElement).value).toBe(
      EXPECTED_END_TIME_INPUT,
    );
  });

  it('offers only Phone and In-Person session types — Video is not selectable', async () => {
    renderScreen();
    await openProposeModal();

    // Product decision 2026-07-14: Video removed from NEW-session selection on
    // both the CHW and member sides (legacy virtual sessions still render).
    expect(screen.getByText('Phone')).toBeTruthy();
    expect(screen.getByText('In-Person')).toBeTruthy();
    expect(screen.queryByText('Video')).toBeNull();
  });

  it('submits schedulingStatus "pending" with the new time, THEN declines the original session', async () => {
    renderScreen();
    await openProposeModal();

    // Counter-offer a different time on the same day.
    fireEvent.change(screen.getByLabelText('Session start time'), { target: { value: '9:00 AM' } });
    fireEvent.change(screen.getByLabelText('Session end time'), { target: { value: '10:00 AM' } });

    fireEvent.click(screen.getByLabelText('Propose new time'));

    await waitFor(() => {
      expect(mockedApi.mock.calls.some(([path]) => path === '/sessions/schedule')).toBe(true);
    });
    await waitFor(() => {
      expect(
        mockedApi.mock.calls.some(([path]) => path === `/sessions/${PENDING_SESSION_ID}/decline`),
      ).toBe(true);
    });

    const scheduleCallIndex = mockedApi.mock.calls.findIndex(([path]) => path === '/sessions/schedule');
    const declineCallIndex = mockedApi.mock.calls.findIndex(
      ([path]) => path === `/sessions/${PENDING_SESSION_ID}/decline`,
    );
    // The new session must be booked BEFORE the old one is declined — the
    // ordering that keeps a failed re-book from losing the member's session.
    expect(scheduleCallIndex).toBeGreaterThanOrEqual(0);
    expect(declineCallIndex).toBeGreaterThan(scheduleCallIndex);

    const [, scheduleOptions] = mockedApi.mock.calls[scheduleCallIndex];
    const scheduleBody = JSON.parse((scheduleOptions as { body: string }).body);
    expect(scheduleBody.member_id).toBe(MEMBER_ID);
    expect(scheduleBody.scheduling_status).toBe('pending');

    const newStart = new Date(scheduleBody.scheduled_at);
    const newEnd = new Date(scheduleBody.scheduled_end_at);
    expect(newStart.getHours()).toBe(9);
    expect(newStart.getMinutes()).toBe(0);
    expect(newStart.getDate()).toBe(scheduledStart.getDate());
    expect(newEnd.getHours()).toBe(10);
    expect(newEnd.getMinutes()).toBe(0);

    const [declinePath, declineOptions] = mockedApi.mock.calls[declineCallIndex];
    expect(declinePath).toBe(`/sessions/${PENDING_SESSION_ID}/decline`);
    expect((declineOptions as { method?: string })?.method).toBe('PATCH');
  });

  it('does NOT decline the original session when the new booking fails', async () => {
    scheduleShouldFail = true;
    renderScreen();
    await openProposeModal();

    fireEvent.click(screen.getByLabelText('Propose new time'));

    // Give the rejected mutation a tick to settle.
    await waitFor(() => {
      expect(mockedApi.mock.calls.some(([path]) => path === '/sessions/schedule')).toBe(true);
    });

    // The decline call must never fire — the original pending session is
    // preserved when the re-book fails.
    expect(mockedApi.mock.calls.some(([path]) => path === `/sessions/${PENDING_SESSION_ID}/decline`)).toBe(
      false,
    );

    // The modal stays open (not silently closed) so the CHW can retry.
    expect(screen.getByLabelText('Propose new time')).toBeTruthy();
  });
});

describe('CHWCalendarScreen — Pending Session Requests proposedBy filter (initiator inversion)', () => {
  it('excludes a pending session this CHW proposed (proposedBy: "chw") from the approval queue', async () => {
    additionalSessionFixtures = [chwProposedSessionFixture];
    renderScreen();

    // A legacy/unaffected pending request renders normally...
    await screen.findByLabelText(`Approve request from ${MEMBER_NAME}`);
    // ...but the CHW's own proposal must never appear as something for the
    // CHW to approve/decline/re-propose against themselves. (The underlying
    // session still renders elsewhere on the calendar grid as a normal
    // session card, so this only asserts absence from the approval-queue
    // actions, not a global absence of the member's name.)
    expect(screen.queryByLabelText(`Approve request from ${MEMBER_NAME_6}`)).toBeNull();
    expect(screen.queryByLabelText(`Decline request from ${MEMBER_NAME_6}`)).toBeNull();
    expect(screen.queryByLabelText(`Propose new time for ${MEMBER_NAME_6}`)).toBeNull();
  });

  it('still shows a legacy pending session with no proposedBy field (undefined) — preserves today\'s behavior', async () => {
    // pendingSessionFixture (the base fixture) has no proposed_by key at all.
    renderScreen();

    expect(await screen.findByLabelText(`Approve request from ${MEMBER_NAME}`)).toBeTruthy();
    expect(await screen.findByLabelText(`Decline request from ${MEMBER_NAME}`)).toBeTruthy();
  });

  it('still shows a member-proposed pending session (proposedBy: "member") — unaffected by the filter', async () => {
    additionalSessionFixtures = [memberProposedSessionFixture];
    renderScreen();

    expect(await screen.findByLabelText(`Approve request from ${MEMBER_NAME_7}`)).toBeTruthy();
    expect(await screen.findByLabelText(`Decline request from ${MEMBER_NAME_7}`)).toBeTruthy();
  });
});

/**
 * Schedule Session modal — Resource Needs multi-select (Epic L).
 *
 * The free-text "Notes (optional)" field was replaced by a chip multi-select
 * of resource-need verticals (Housing, Food, Transportation, ...), reusing
 * lib/verticals.ts's VERTICAL_PICKER_OPTIONS so the list can never drift from
 * the backend enum. Covers: the multiselect renders (and the old Notes input
 * does not), selecting chips submits `resource_needs`, and Session Details
 * renders the selected chips where Notes used to appear.
 */
describe('CHWCalendarScreen — Schedule Session Resource Needs multi-select (Epic L)', () => {
  /** Opens the normal (non-propose) Schedule Session modal and selects the
   *  fixture member, so the submit button becomes enabled. */
  async function openScheduleModalWithMember(): Promise<void> {
    fireEvent.click(await screen.findByLabelText('Schedule a new session'));
    await screen.findByLabelText('Search members');
    fireEvent.click(await screen.findByLabelText(`Select ${MEMBER_NAME}`));
  }

  it('shows the Resource Needs multiselect, not a free-text Notes input', async () => {
    renderScreen();
    await openScheduleModalWithMember();

    expect(screen.getByText('Resource Needs (optional)')).toBeTruthy();
    expect(screen.queryByText('Notes (optional)')).toBeNull();
    expect(screen.queryByLabelText('Session notes')).toBeNull();

    // Chips for every SELECTABLE vertical render as checkboxes (role="checkbox",
    // accessibilityState={{checked}} on the real component — asserted here
    // via the visible "✓" marker, since react-native-web's jsdom test
    // rendering doesn't surface accessibilityState as an aria-checked
    // attribute). Unchecked by default: no checkmark yet.
    //
    // Epic C5: 'Housing' is grandfathered — no longer offered as a NEW
    // selection here (VERTICAL_PICKER_OPTIONS excludes it); 'Utilities'
    // replaces it.
    const utilitiesChip = screen.getByLabelText('Utilities');
    expect(utilitiesChip.getAttribute('role')).toBe('checkbox');
    expect(utilitiesChip.textContent).not.toContain('✓');
    expect(screen.getByLabelText('Food Security')).toBeTruthy();
    expect(screen.getByLabelText('Transportation')).toBeTruthy();
    expect(screen.queryByLabelText('Housing')).toBeNull();
  });

  it('submits selected chips as resource_needs, and toggling off removes them', async () => {
    renderScreen();
    await openScheduleModalWithMember();

    const utilitiesChip = screen.getByLabelText('Utilities');
    const foodChip = screen.getByLabelText('Food Security');

    fireEvent.click(utilitiesChip);
    fireEvent.click(foodChip);
    expect(utilitiesChip.textContent).toContain('✓');
    expect(foodChip.textContent).toContain('✓');

    // Toggle Food back off before submitting — only Utilities should ship.
    fireEvent.click(foodChip);
    expect(foodChip.textContent).not.toContain('✓');

    fireEvent.click(screen.getByLabelText('Schedule session'));

    await waitFor(() => {
      expect(mockedApi.mock.calls.some(([path]) => path === '/sessions/schedule')).toBe(true);
    });

    const [, options] = mockedApi.mock.calls.find(([path]) => path === '/sessions/schedule')!;
    const body = JSON.parse((options as { body: string }).body);
    expect(body.resource_needs).toEqual(['utilities']);
    // The modal no longer collects notes at all — the mutation hook still
    // sends the legacy `notes` key (payload.notes defaults to null) for
    // backward compatibility with the still-present DB column, but nothing
    // in the UI ever populates it anymore.
    expect(body.notes).toBeNull();
  });

  it('submits an empty resource_needs array when no chips are selected', async () => {
    renderScreen();
    await openScheduleModalWithMember();

    fireEvent.click(screen.getByLabelText('Schedule session'));

    await waitFor(() => {
      expect(mockedApi.mock.calls.some(([path]) => path === '/sessions/schedule')).toBe(true);
    });

    const [, options] = mockedApi.mock.calls.find(([path]) => path === '/sessions/schedule')!;
    const body = JSON.parse((options as { body: string }).body);
    expect(body.resource_needs).toEqual([]);
  });
});

/**
 * QA2 A2 #14 — the Confirmed/Pending Status toggle was removed from Schedule
 * Session. Every CHW-scheduled session (new session AND Propose New Time) is
 * now ALWAYS submitted with `scheduling_status: 'pending'` explicitly — the
 * FE never relies on the backend's 'confirmed' default.
 */
describe('CHWCalendarScreen — Schedule Session always submits pending (QA2 A2 #14)', () => {
  it('does not render a Confirmed/Pending status picker', async () => {
    renderScreen();
    fireEvent.click(await screen.findByLabelText('Schedule a new session'));
    await screen.findByLabelText('Search members');
    fireEvent.click(await screen.findByLabelText(`Select ${MEMBER_NAME}`));

    // The "Status" field label still renders (as an informational hint), but
    // the Confirmed/Pending radio picker itself must be gone.
    expect(screen.queryByLabelText('Confirmed')).toBeNull();
    expect(screen.queryByLabelText('Pending')).toBeNull();
  });

  it('submits scheduling_status "pending" for a brand-new session (never "confirmed")', async () => {
    renderScreen();
    fireEvent.click(await screen.findByLabelText('Schedule a new session'));
    await screen.findByLabelText('Search members');
    fireEvent.click(await screen.findByLabelText(`Select ${MEMBER_NAME}`));

    fireEvent.click(screen.getByLabelText('Schedule session'));

    await waitFor(() => {
      expect(mockedApi.mock.calls.some(([path]) => path === '/sessions/schedule')).toBe(true);
    });

    const [, options] = mockedApi.mock.calls.find(([path]) => path === '/sessions/schedule')!;
    const body = JSON.parse((options as { body: string }).body);
    expect(body.scheduling_status).toBe('pending');
  });
});

/**
 * QA2 A2 #15 — Propose New Time seeds Resource Needs from the ORIGINAL
 * session's resourceNeeds instead of resetting to an empty set, so
 * counter-offering a new time doesn't silently drop needs already on record.
 */
describe('CHWCalendarScreen — Propose New Time prefills Resource Needs (QA2 A2 #15)', () => {
  beforeEach(() => {
    additionalSessionFixtures = [resourceNeedsSessionFixture];
  });

  it('seeds the Resource Needs chips from the original session when opening Propose New Time', async () => {
    renderScreen();
    fireEvent.click(await screen.findByLabelText('day view'));
    const card = await screen.findByLabelText(new RegExp(`^Session with ${MEMBER_NAME_5} at`));
    fireEvent.click(card);
    await screen.findByText('Session Details');

    fireEvent.click(screen.getByLabelText('Propose a new time'));
    await screen.findByLabelText('Propose new time'); // submit button, proves the modal opened

    // resourceNeedsSessionFixture has resource_needs: ['housing', 'food'].
    // 'Housing' is grandfathered (VERTICAL_PICKER_OPTIONS excludes it as a
    // selectable chip — see lib/verticals.ts), so only 'Food Security' has a
    // renderable chip to assert the checkmark on.
    const foodChip = screen.getByLabelText('Food Security');
    expect(foodChip.textContent).toContain('✓');
  });

  it('submits the prefilled Resource Needs unchanged if the CHW does not touch the chips', async () => {
    renderScreen();
    fireEvent.click(await screen.findByLabelText('day view'));
    const card = await screen.findByLabelText(new RegExp(`^Session with ${MEMBER_NAME_5} at`));
    fireEvent.click(card);
    await screen.findByText('Session Details');

    fireEvent.click(screen.getByLabelText('Propose a new time'));
    await screen.findByLabelText('Propose new time');

    // Explicitly set a start/end time (rather than relying on the prefilled
    // values verbatim) — resourceNeedsSessionFixture is anchored to
    // FUTURE_TODAY, which can land close enough to midnight that its
    // prefilled 1-hour block rolls the end time onto the next calendar day
    // and trips the modal's own "end must be after start" guard depending on
    // what time of day the suite runs. Fixing the times here keeps this
    // test's assertion (resource_needs round-trips unchanged) independent of
    // that unrelated flakiness.
    fireEvent.change(screen.getByLabelText('Session start time'), { target: { value: '9:00 AM' } });
    fireEvent.change(screen.getByLabelText('Session end time'), { target: { value: '10:00 AM' } });

    fireEvent.click(screen.getByLabelText('Propose new time'));

    await waitFor(() => {
      expect(mockedApi.mock.calls.some(([path]) => path === '/sessions/schedule')).toBe(true);
    });

    const [, options] = mockedApi.mock.calls.find(([path]) => path === '/sessions/schedule')!;
    const body = JSON.parse((options as { body: string }).body);
    // Both prefilled needs round-trip unchanged, including 'housing' — it has
    // no visible chip (grandfathered out of VERTICAL_PICKER_OPTIONS, see
    // lib/verticals.ts), but the prefill effect seeds it straight into the
    // Set, and since nothing here toggles it off, it stays in the submitted
    // payload exactly as it was on the original session.
    expect(body.resource_needs).toEqual(['housing', 'food']);
  });
});

describe('CHWCalendarScreen — Session Details renders Resource Needs (Epic L)', () => {
  beforeEach(() => {
    additionalSessionFixtures = [resourceNeedsSessionFixture];
  });

  it('renders the selected Resource Needs chips where Notes used to appear', async () => {
    renderScreen();
    fireEvent.click(await screen.findByLabelText('day view'));
    const card = await screen.findByLabelText(new RegExp(`^Session with ${MEMBER_NAME_5} at`));
    fireEvent.click(card);
    await screen.findByText('Session Details');

    expect(screen.getByText('Resource Needs')).toBeTruthy();
    const chips = screen.getByLabelText('Resource needs');
    expect(chips.textContent).toContain('Housing');
    expect(chips.textContent).toContain('Food Security');
    expect(screen.queryByText('Notes')).toBeNull();
  });

  it('does not render a Resource Needs row for a session with none selected', async () => {
    renderScreen();
    fireEvent.click(await screen.findByLabelText('day view'));
    const card = await screen.findByLabelText(new RegExp(`^Session with ${MEMBER_NAME} at`));
    fireEvent.click(card);
    await screen.findByText('Session Details');

    expect(screen.queryByText('Resource Needs')).toBeNull();
    expect(screen.queryByLabelText('Resource needs')).toBeNull();
  });
});

/**
 * Session Details modal — Begin Session / Propose New Time (confirmed), and
 * Remove / Propose New Time (a pending session THIS CHW proposed).
 *
 * QA2 A2 #17: for an upcoming, CHW-confirmed session (status 'scheduled',
 * scheduledAt in the future, NOT a still-pending request) the modal's footer
 * swaps the plain "Open Member Profile" button for Begin Session + Propose
 * New Time — Remove was DELETED from this row (product decision). A missed/
 * completed session is unaffected and keeps Open Member Profile only. A
 * pending session THIS CHW proposed (proposedBy 'chw') gets its own branch:
 * Remove + Propose New Time, no Confirm/Decline (see the
 * "CHW-proposed pending session" describe block below).
 */
describe('CHWCalendarScreen — Session Details modal actions', () => {
  /** Switches to Day view (hardcoded to the real calendar date — see the
   *  fixtures comment above) and opens Session Details for the given member's
   *  card. */
  async function openSessionDetails(memberName: string): Promise<void> {
    const dayViewBtn = await screen.findByLabelText('day view');
    fireEvent.click(dayViewBtn);
    const card = await screen.findByLabelText(new RegExp(`^Session with ${memberName} at`));
    fireEvent.click(card);
    await screen.findByText('Session Details');
  }

  it('shows Begin Session / Propose New Time (no Remove) for an upcoming confirmed session, not for a completed one', async () => {
    renderScreen();
    await openSessionDetails(MEMBER_NAME);

    expect(screen.getByLabelText('Begin session')).toBeTruthy();
    expect(screen.getByLabelText('Propose a new time')).toBeTruthy();
    // QA2 A2 #17 — Remove was deleted from the confirmed-session action row.
    expect(screen.queryByLabelText('Remove session')).toBeNull();
    expect(screen.queryByLabelText(`Open ${MEMBER_NAME} profile`)).toBeNull();

    fireEvent.click(screen.getByLabelText('Close session details'));
    await openSessionDetails(MEMBER_NAME_2);

    expect(screen.queryByLabelText('Begin session')).toBeNull();
    expect(screen.queryByLabelText('Propose a new time')).toBeNull();
    expect(screen.queryByLabelText('Remove session')).toBeNull();
    expect(screen.getByLabelText(`Open ${MEMBER_NAME_2} profile`)).toBeTruthy();
  });

  it('Begin Session starts the session then navigates to Messages for that member', async () => {
    renderScreen();
    await openSessionDetails(MEMBER_NAME);

    fireEvent.click(screen.getByLabelText('Begin session'));

    await waitFor(() => {
      expect(
        mockedApi.mock.calls.some(
          ([path, opts]) =>
            path === `/sessions/${CONFIRMED_SESSION_ID}/start` &&
            (opts as { method?: string })?.method === 'PATCH',
        ),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('SessionsStack', {
        screen: 'Messages',
        params: { memberId: MEMBER_ID },
      });
    });
  });

  it('does NOT navigate to Messages when starting the session fails', async () => {
    startShouldFail = true;
    renderScreen();
    await openSessionDetails(MEMBER_NAME);

    fireEvent.click(screen.getByLabelText('Begin session'));

    await waitFor(() => {
      expect(
        mockedApi.mock.calls.some(([path]) => path === `/sessions/${CONFIRMED_SESSION_ID}/start`),
      ).toBe(true);
    });

    expect(mockNavigate).not.toHaveBeenCalled();
    // Modal stays open so the CHW can see the failure / retry.
    expect(screen.getByLabelText('Begin session')).toBeTruthy();
  });

  it('Propose New Time from Session Details opens the reschedule modal prefilled for that session', async () => {
    renderScreen();
    await openSessionDetails(MEMBER_NAME);

    fireEvent.click(screen.getByLabelText('Propose a new time'));

    // ScheduleSessionModal opens in propose mode, prefilled for this session.
    await screen.findByLabelText('Propose new time'); // submit button

    const expectedDate = mmddyyyy(confirmedUpcomingStart);
    expect((screen.getByLabelText('Session date') as HTMLInputElement).value).toBe(expectedDate);
    expect(screen.queryByLabelText('Clear member selection')).toBeNull();
  });

});

/**
 * QA2 A2 #17 — a pending session THIS CHW proposed (proposedBy: 'chw') gets
 * Remove + Propose New Time in Session Details, with NO Confirm/Decline
 * (confirming/declining your own proposal is invalid self-approval — the
 * backend 409s a CHW-confirm on proposed_by='chw' sessions). This is
 * distinct from pendingSessionFixture (proposedBy undefined — a legacy/
 * member-requested row), which keeps the existing Confirm/Decline row
 * unchanged (covered by the "Pending Session Requests" describe blocks
 * above, and implicitly here via the isPendingAwaitingChwDecision branch not
 * firing for this fixture).
 */
describe('CHWCalendarScreen — Session Details for a CHW-proposed pending session (QA2 A2 #17)', () => {
  beforeEach(() => {
    additionalSessionFixtures = [chwProposedTodaySessionFixture];
  });

  async function openChwProposedSessionDetails(): Promise<void> {
    const dayViewBtn = await screen.findByLabelText('day view');
    fireEvent.click(dayViewBtn);
    const card = await screen.findByLabelText(new RegExp(`^Session with ${MEMBER_NAME_8} at`));
    fireEvent.click(card);
    await screen.findByText('Session Details');
  }

  it('shows Remove + Propose New Time, and NOT Confirm/Decline/Begin Session', async () => {
    renderScreen();
    await openChwProposedSessionDetails();

    expect(screen.getByLabelText('Remove session')).toBeTruthy();
    expect(screen.getByLabelText('Propose a new time')).toBeTruthy();
    expect(screen.queryByLabelText('Confirm session request')).toBeNull();
    expect(screen.queryByLabelText('Decline session request')).toBeNull();
    expect(screen.queryByLabelText('Begin session')).toBeNull();
    expect(screen.queryByLabelText(`Open ${MEMBER_NAME_8} profile`)).toBeNull();
  });

  it('Remove only cancels the session after the Yes/No confirm is accepted (never via window.confirm)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderScreen();
    await openChwProposedSessionDetails();

    fireEvent.click(screen.getByLabelText('Remove session'));
    await screen.findByText('Remove this scheduled session?');
    expect(confirmSpy).not.toHaveBeenCalled();

    // "No" — must NOT cancel. (react-native-web's Modal keeps content mounted
    // through its close animation rather than unmounting synchronously, so
    // assert on behavior — no cancel call — rather than the confirm text
    // disappearing from the DOM.)
    fireEvent.click(screen.getByLabelText('No, keep session'));
    expect(
      mockedApi.mock.calls.some(([path]) => path === `/sessions/${CHW_PROPOSED_TODAY_SESSION_ID}/cancel`),
    ).toBe(false);

    // "Yes" — cancels.
    fireEvent.click(screen.getByLabelText('Yes, remove session'));

    await waitFor(() => {
      expect(
        mockedApi.mock.calls.some(
          ([path, opts]) =>
            path === `/sessions/${CHW_PROPOSED_TODAY_SESSION_ID}/cancel` &&
            (opts as { method?: string })?.method === 'PATCH',
        ),
      ).toBe(true);
    });
    confirmSpy.mockRestore();
  });

  it('Propose New Time opens the reschedule modal prefilled for that session', async () => {
    renderScreen();
    await openChwProposedSessionDetails();

    fireEvent.click(screen.getByLabelText('Propose a new time'));

    await screen.findByLabelText('Propose new time'); // submit button
    const expectedDate = mmddyyyy(chwProposedTodayStart);
    expect((screen.getByLabelText('Session date') as HTMLInputElement).value).toBe(expectedDate);
  });
});

/**
 * N1 — a session the CHW Removed (status flips to `cancelled` via
 * useCancelSession) must vanish from the calendar grid entirely: it should
 * render as neither a Week/Day session card nor count toward a Month
 * day-cell's session badge. This is `groupSessionsByDate` excluding
 * `cancelled`/`cancelled_no_consent` rows before the grid ever sees them.
 */
describe('CHWCalendarScreen — removed sessions vanish from the calendar (N1)', () => {
  beforeEach(() => {
    additionalSessionFixtures = [cancelledSessionFixture];
  });

  it('does not render a cancelled session as a card in Day view', async () => {
    renderScreen();
    fireEvent.click(await screen.findByLabelText('day view'));

    // Control: a non-cancelled same-day session still renders, proving the
    // day's data actually loaded (a false negative here would otherwise make
    // the "cancelled card absent" assertion below meaningless).
    await screen.findByLabelText(new RegExp(`^Session with ${MEMBER_NAME} at`));

    expect(
      screen.queryByLabelText(new RegExp(`^Session with ${MEMBER_NAME_3} at`)),
    ).toBeNull();
  });

  it('excludes the cancelled session from the Month view day-cell session count', async () => {
    renderScreen();
    fireEvent.click(await screen.findByLabelText('month view'));

    // Today has 2 non-cancelled sessions (the Session-Details-modal
    // confirmed + completed fixtures). The 3rd, cancelled fixture must not
    // push today's badge count to 3.
    await waitFor(() => {
      expect(screen.getByLabelText(/, 2 sessions$/)).toBeTruthy();
    });
    expect(screen.queryByLabelText(/, 3 sessions?$/)).toBeNull();
  });
});

/**
 * O1 — the status tag must reflect the session's REAL status. Covers both
 * the pure `deriveBadgeStatus` mapping directly (fast, exhaustive) and one
 * rendered-UI assertion tying it back to the actual Session Details modal.
 */
describe('CHWCalendarScreen — deriveBadgeStatus truthful status tags (O1)', () => {
  // Pure-logic tests only — a fixed instant keeps deriveBadgeStatus assertions
  // deterministic. These never render, so they don't touch the real day clock.
  const now = new Date('2026-07-12T18:00:00.000Z');

  /** Builds a minimal-but-valid SessionData row with the given overrides. */
  function makeSession(overrides: Partial<SessionData>): SessionData {
    return {
      id: 's-1',
      requestId: 'r-1',
      chwId: CHW_ID,
      memberId: MEMBER_ID,
      vertical: 'housing',
      mode: 'in_person',
      status: 'scheduled',
      scheduledAt: '2026-07-12T15:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('maps completed → "Completed"', () => {
    expect(deriveBadgeStatus(makeSession({ status: 'completed' }), now)).toBe('Completed');
  });

  it('maps cancelled → "Cancelled"', () => {
    expect(deriveBadgeStatus(makeSession({ status: 'cancelled' }), now)).toBe('Cancelled');
  });

  it('maps cancelled_no_consent → "Cancelled"', () => {
    expect(deriveBadgeStatus(makeSession({ status: 'cancelled_no_consent' }), now)).toBe('Cancelled');
  });

  it('maps a still-pending scheduling request → "Pending"', () => {
    expect(
      deriveBadgeStatus(makeSession({ status: 'scheduled', schedulingStatus: 'pending' }), now),
    ).toBe('Pending');
  });

  it('maps an upcoming confirmed session → "Confirmed"', () => {
    const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    expect(
      deriveBadgeStatus(makeSession({ status: 'scheduled', scheduledAt: future }), now),
    ).toBe('Confirmed');
  });

  it('does NOT auto-label a past-but-never-started scheduled session "Missed" — stays "Confirmed"', () => {
    const past = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    expect(
      deriveBadgeStatus(makeSession({ status: 'scheduled', scheduledAt: past }), now),
    ).toBe('Confirmed');
  });

  it('never produces a "Missed" tag for any known status — the auto-Missed rule is gone', () => {
    const statuses = [
      'scheduled',
      'in_progress',
      'awaiting_documentation',
      'completed',
      'cancelled',
      'cancelled_no_consent',
    ];
    for (const status of statuses) {
      const past = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
      expect(deriveBadgeStatus(makeSession({ status, scheduledAt: past }), now)).not.toBe('Missed');
    }
  });

  it('renders "Confirmed" (never "Missed") for a session whose time passed but was never started', async () => {
    additionalSessionFixtures = [pastScheduledSessionFixture];
    renderScreen();

    fireEvent.click(await screen.findByLabelText('day view'));
    const card = await screen.findByLabelText(new RegExp(`^Session with ${MEMBER_NAME_4} at`));
    fireEvent.click(card);
    await screen.findByText('Session Details');

    // The card's own inline badge (Day view) AND the modal's status badge
    // both read "Confirmed" — asserting "at least one" avoids over-coupling
    // to how many badges happen to be on screen, while still proving the
    // real status renders and "Missed" never does.
    expect(screen.getAllByText('Confirmed').length).toBeGreaterThan(0);
    expect(screen.queryByText('Missed')).toBeNull();
  });
});
