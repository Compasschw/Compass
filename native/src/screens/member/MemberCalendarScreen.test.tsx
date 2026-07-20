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
 *     mutation-ordering wiring, not a hand-rolled hook mock. QA2 A2 #14/#18:
 *     the widget's row actions are Approve + Propose New Time ONLY — the
 *     standalone Decline button was removed (product decision); Decline is
 *     still exercised internally as step 2 of the Propose New Time flow.
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
 *  with 2 actions (Approve / Propose New Time — QA2 A2 #14/#18 removed the
 *  standalone Decline). Carries resource_needs so QA2 A2 #3's Propose New
 *  Time prefill-seeding can be asserted against a known value. */
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
  resource_needs: ['food', 'transportation'],
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
/** Open slots returned from the assigned CHW's /available-slots endpoint —
 *  empty by default (Pending Requests widget tests never need a slot);
 *  Part 23's Schedule Session tests below opt in with one fixed slot. */
let availableSlotFixtures: string[] = [];

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

  if (path.includes('/available-slots')) {
    return { slots: availableSlotFixtures };
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
  availableSlotFixtures = [];
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
  it('renders a CHW-proposed pending request with 2 actions (Approve / Propose New Time) — no standalone Decline (QA2 A2 #14/#18)', async () => {
    renderScreen();

    expect(await screen.findByLabelText(`Approve request from ${CHW_NAME}`)).toBeTruthy();
    expect(screen.getByLabelText(`Propose new time for ${CHW_NAME}`)).toBeTruthy();
    expect(screen.queryByLabelText(`Decline request from ${CHW_NAME}`)).toBeNull();
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

  it('has no standalone Decline confirm dialog anywhere in the widget (QA2 A2 #14/#18)', async () => {
    renderScreen();

    await screen.findByLabelText(`Approve request from ${CHW_NAME}`);

    // Neither the row action nor its confirm-dialog remnants exist.
    expect(screen.queryByLabelText(`Decline request from ${CHW_NAME}`)).toBeNull();
    expect(screen.queryByText('Decline this session request?')).toBeNull();
    expect(screen.queryByLabelText('Yes, decline request')).toBeNull();

    expect(
      mockedApi.mock.calls.some(([path]) => path === `/sessions/${CHW_PROPOSED_SESSION_ID}/decline`),
    ).toBe(false);
  });

  it('opens the Propose New Time modal prefilled with the request\'s date/time', async () => {
    renderScreen();
    await openProposeModal();

    expect((screen.getByLabelText('Session date') as HTMLInputElement).value).toBe(EXPECTED_DATE_INPUT);
    expect((screen.getByLabelText('Session start time') as HTMLInputElement).value).toBe('2:00 PM');
    expect((screen.getByLabelText('Session end time') as HTMLInputElement).value).toBe('3:00 PM');
  });

  it('seeds the Resource Needs chips from the original request (QA2 A2 #3)', async () => {
    renderScreen();
    await openProposeModal();

    // chwProposedSessionFixture has resource_needs: ['food', 'transportation'].
    const foodChip = screen.getByLabelText('Food Security');
    const transportationChip = screen.getByLabelText('Transportation');
    expect(foodChip.textContent).toContain('✓');
    expect(transportationChip.textContent).toContain('✓');
    // A vertical NOT in the fixture stays unchecked.
    expect(screen.getByLabelText('Utilities').textContent).not.toContain('✓');
  });

  it('submits the prefilled Resource Needs with the counter-proposal (QA2 A2 #3)', async () => {
    renderScreen();
    await openProposeModal();

    fireEvent.click(screen.getByLabelText('Propose new time'));

    await waitFor(() => {
      expect(mockedApi.mock.calls.some(([path]) => path === '/sessions/schedule')).toBe(true);
    });

    const [, options] = mockedApi.mock.calls.find(([path]) => path === '/sessions/schedule')!;
    const body = JSON.parse((options as { body: string }).body);
    expect(body.resource_needs).toEqual(['food', 'transportation']);
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

// ─── QA2 A2 #5 — cancelled sessions vanish from the member's grid (N1 mirror),
// and Session Details renders Resource Needs chips ──────────────────────────

const CONFIRMED_TODAY_SESSION_ID = 'sess-confirmed-today-1';
const CANCELLED_TODAY_SESSION_ID = 'sess-cancelled-today-1';
const RESOURCE_NEEDS_TODAY_SESSION_ID = 'sess-resource-needs-today-1';
const CHW_NAME_CONTROL = 'Alex Chen';

// "Today" anchoring, same clamp-inside-today approach as
// CHWCalendarScreen.status.test.tsx — Day view reads the real calendar date,
// so fixtures must land on today, before end-of-day, to render there.
const _fxNow2 = new Date();
const _endOfToday2 = new Date(_fxNow2);
_endOfToday2.setHours(23, 59, 59, 999);
const FUTURE_TODAY_2 = new Date((_fxNow2.getTime() + _endOfToday2.getTime()) / 2);

function todayFixture(overrides: {
  id: string;
  status: string;
  resource_needs?: string[];
}) {
  const start = new Date(FUTURE_TODAY_2);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    id: overrides.id,
    request_id: `req-${overrides.id}`,
    chw_id: CHW_ID,
    member_id: MEMBER_ID,
    vertical: 'housing',
    status: overrides.status,
    mode: 'in_person',
    scheduled_at: start.toISOString(),
    scheduled_end_at: end.toISOString(),
    scheduling_status: overrides.status === 'scheduled' ? 'confirmed' : null,
    resource_needs: overrides.resource_needs,
    created_at: '2026-07-01T00:00:00.000Z',
    chw_name: CHW_NAME_CONTROL,
    member_name: 'Test Member',
  };
}

const confirmedTodayFixture = todayFixture({
  id: CONFIRMED_TODAY_SESSION_ID,
  status: 'scheduled',
});
const cancelledTodayFixture = todayFixture({
  id: CANCELLED_TODAY_SESSION_ID,
  status: 'cancelled',
});
const resourceNeedsTodayFixture = todayFixture({
  id: RESOURCE_NEEDS_TODAY_SESSION_ID,
  status: 'scheduled',
  resource_needs: ['housing', 'food'],
});

describe('MemberCalendarScreen — cancelled sessions vanish from the grid (N1 mirror, QA2 A2 #5)', () => {
  beforeEach(() => {
    additionalSessionFixtures = [confirmedTodayFixture, cancelledTodayFixture];
  });

  it('does not render a cancelled session as a card in Day view', async () => {
    renderScreen();
    fireEvent.click(await screen.findByLabelText('day view'));

    // Control: the non-cancelled fixture renders, proving the day's data
    // actually loaded (a false negative here would make the assertion below
    // meaningless). Both fixtures share the same CHW name, so distinguish by
    // count instead of a per-name query.
    await screen.findByLabelText(new RegExp(`^Session with ${CHW_NAME_CONTROL} at`));
    expect(screen.getAllByLabelText(new RegExp(`^Session with ${CHW_NAME_CONTROL} at`)).length).toBe(1);
  });

  it('excludes the cancelled session from today\'s Month view day-cell session count', async () => {
    renderScreen();
    fireEvent.click(await screen.findByLabelText('month view'));

    // Scope to TODAY's specific day cell — other fixtures used elsewhere in
    // this suite (e.g. the base chwProposedSessionFixture, +3 days out) can
    // independently render a "1 session" cell on a different day, so a bare
    // `/, 1 session$/` regex is ambiguous across the whole month grid.
    const today = new Date();
    const monthName = today.toLocaleDateString('en-US', { month: 'long' });
    const todayLabel = `${monthName} ${today.getDate()}, 1 session`;

    await waitFor(() => {
      expect(screen.getByLabelText(todayLabel)).toBeTruthy();
    });
    expect(
      screen.queryByLabelText(`${monthName} ${today.getDate()}, 2 sessions`),
    ).toBeNull();
  });
});

describe('MemberCalendarScreen — Session Details renders Resource Needs chips (QA2 A2 #5)', () => {
  beforeEach(() => {
    additionalSessionFixtures = [resourceNeedsTodayFixture];
  });

  it('renders Resource Needs chips instead of the Focus Area row when resourceNeeds is present', async () => {
    renderScreen();
    fireEvent.click(await screen.findByLabelText('day view'));
    const card = await screen.findByLabelText(new RegExp(`^Session with ${CHW_NAME_CONTROL} at`));
    fireEvent.click(card);
    await screen.findByText('Session Details');

    expect(screen.getByText('Resource Needs')).toBeTruthy();
    const chips = screen.getByLabelText('Resource needs');
    expect(chips.textContent).toContain('Housing');
    expect(chips.textContent).toContain('Food Security');
    expect(screen.queryByText('Focus Area')).toBeNull();
  });

  it('falls back to the Focus Area row for a legacy session with no resourceNeeds', async () => {
    additionalSessionFixtures = [confirmedTodayFixture];
    renderScreen();
    fireEvent.click(await screen.findByLabelText('day view'));
    const card = await screen.findByLabelText(new RegExp(`^Session with ${CHW_NAME_CONTROL} at`));
    fireEvent.click(card);
    await screen.findByText('Session Details');

    expect(screen.queryByText('Resource Needs')).toBeNull();
    expect(screen.queryByLabelText('Resource needs')).toBeNull();
    expect(screen.getByText('Focus Area')).toBeTruthy();
  });
});

// ─── Part 23 (QA batch 2026-07-14 #23): Schedule dialog Type picker ───────
//
// MemberScheduleModal ("Schedule Session" button, top of the calendar) —
// Phone must render first and be pre-selected by default, matching the
// mirrored flip in MemberPendingRequestsList's ProposeNewTimeModal.

async function openScheduleModal(): Promise<void> {
  const scheduleBtn = await screen.findByLabelText(
    `Schedule a session with ${CHW_NAME}`,
  );
  fireEvent.click(scheduleBtn);
  await screen.findByText('Schedule a session'); // modal title, proves it opened
}

describe('MemberCalendarScreen — Schedule Session dialog: Type picker (Part 23)', () => {
  it('opens with Phone visually selected by default (not In person)', async () => {
    renderScreen();
    await openScheduleModal();

    const phoneBtn = screen.getByText('Phone').closest('button') as HTMLElement;
    const inPersonBtn = screen.getByText('In person').closest('button') as HTMLElement;
    const initialPhoneClass = phoneBtn.className;
    const initialInPersonClass = inPersonBtn.className;

    // segBtnActive styling is only applied to the currently-selected type.
    // Tapping "In person" flips which button carries it — if Phone's class
    // changes away from its initial value (and In person's changes too),
    // that proves Phone — not In person — held the active styling by
    // default, before any tap.
    fireEvent.click(inPersonBtn);

    expect(phoneBtn.className).not.toBe(initialPhoneClass);
    expect(inPersonBtn.className).not.toBe(initialInPersonClass);
  });

  it('renders the Phone option before the In person option', async () => {
    renderScreen();
    await openScheduleModal();

    const phoneLabel = screen.getByText('Phone');
    const inPersonLabel = screen.getByText('In person');
    const position = phoneLabel.compareDocumentPosition(inPersonLabel);
    // Node.DOCUMENT_POSITION_FOLLOWING === 4 — In person follows Phone.
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('requests a phone session when submitted without touching Type', async () => {
    availableSlotFixtures = [new Date(scheduledStart).toISOString()];
    renderScreen();
    await openScheduleModal();

    const slotLabel = new Date(availableSlotFixtures[0]).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
    fireEvent.click(await screen.findByLabelText(slotLabel));

    fireEvent.click(screen.getByLabelText('Request session'));

    await waitFor(() => {
      const scheduleCall = mockedApi.mock.calls.find(
        ([path, opts]) =>
          path === '/sessions/schedule' &&
          (opts as { method?: string } | undefined)?.method === 'POST',
      );
      expect(scheduleCall).toBeTruthy();
      const body = JSON.parse((scheduleCall?.[1] as { body: string }).body);
      expect(body.mode).toBe('phone');
    });
  });
});

// ─── Tap an empty 30-min grid cell → Schedule modal pre-filled ──────────────
//
// A member can tap any empty half-hour cell in the Week/Day grid to open the
// "Schedule a session" modal with that date filled and — when the CHW has that
// exact 30-min slot open — the matching slot auto-selected. If the tapped slot
// isn't among the CHW's open slots, the modal still opens with the date filled
// and no slot selected. Tapping a booked session card opens Session Details.

/** The accessible label a SlotTapZone renders for a given cell. Mirrors the
 *  component's own label construction so the test taps the exact empty cell. */
function slotCellLabel(date: Date, hour: number, minute: 0 | 30): string {
  const display = hour % 12 === 0 ? 12 : hour % 12;
  const suffix = hour < 12 ? 'AM' : 'PM';
  const timeLabel = `${display}:${minute === 0 ? '00' : '30'} ${suffix}`;
  const dateLabel = date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `Schedule a session on ${dateLabel} at ${timeLabel}`;
}

/** Local midnight Monday of the week the Week view anchors to (this week). */
function mondayOfThisWeek(): Date {
  const anchor = new Date();
  anchor.setHours(0, 0, 0, 0);
  const day = anchor.getDay();
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - day + (day === 0 ? -6 : 1));
  return monday;
}

/** Local midnight today — the day the Day view is pinned to. */
function todayMidnight(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** A Date at a specific hour/minute on the given local calendar day. */
function atTime(day: Date, hour: number, minute: 0 | 30): Date {
  const d = new Date(day);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** The slot-pill label the modal renders for an ISO slot — derived the same
 *  way the component does so the assertion is locale-agnostic in CI. */
function pillLabel(date: Date): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

describe('MemberCalendarScreen — tap an empty slot to schedule (Week + Day)', () => {
  it('opens the Schedule modal with the date filled from a Week-view empty cell', async () => {
    renderScreen();
    // Wait for the assigned-CHW-dependent grid to mount (its Schedule button
    // proves the CHW is known, so the tap zones and modal are wired).
    await screen.findByLabelText(`Schedule a session with ${CHW_NAME}`);

    const monday = mondayOfThisWeek();
    const slot = atTime(monday, 11, 0);
    availableSlotFixtures = [slot.toISOString()];

    fireEvent.click(await screen.findByLabelText(slotCellLabel(monday, 11, 0)));

    await screen.findByText('Schedule a session'); // modal title
    expect(screen.getByDisplayValue(mmddyyyy(monday))).toBeTruthy();
    // The CHW has this exact slot open → it auto-selects once slots resolve.
    expect(await screen.findByLabelText(`${pillLabel(slot)}, selected`)).toBeTruthy();
  });

  it('auto-selects the matching 30-min slot from a Day-view empty cell', async () => {
    const today = todayMidnight();
    const slot = atTime(today, 9, 0);
    availableSlotFixtures = [slot.toISOString()];

    renderScreen();
    await screen.findByLabelText(`Schedule a session with ${CHW_NAME}`);
    fireEvent.click(await screen.findByLabelText('day view'));

    fireEvent.click(await screen.findByLabelText(slotCellLabel(today, 9, 0)));

    await screen.findByText('Schedule a session');
    expect(screen.getByDisplayValue(mmddyyyy(today))).toBeTruthy();
    expect(await screen.findByLabelText(`${pillLabel(slot)}, selected`)).toBeTruthy();
  });

  it('opens with the date filled and NO slot selected when the tapped slot is not available', async () => {
    const today = todayMidnight();
    // The CHW is open at 10:00, but the member taps the 9:00 cell — no match.
    const openSlot = atTime(today, 10, 0);
    availableSlotFixtures = [openSlot.toISOString()];

    renderScreen();
    await screen.findByLabelText(`Schedule a session with ${CHW_NAME}`);
    fireEvent.click(await screen.findByLabelText('day view'));

    fireEvent.click(await screen.findByLabelText(slotCellLabel(today, 9, 0)));

    await screen.findByText('Schedule a session');
    expect(screen.getByDisplayValue(mmddyyyy(today))).toBeTruthy();
    // The 10:00 pill is offered but nothing is auto-selected (no 9:00 match).
    await screen.findByLabelText(pillLabel(openSlot));
    expect(screen.queryByLabelText(`${pillLabel(openSlot)}, selected`)).toBeNull();
    expect(screen.queryByLabelText(`${pillLabel(atTime(today, 9, 0))}, selected`)).toBeNull();
  });

  it('honors the :30 half-hour cell (auto-selects the :30 slot)', async () => {
    const today = todayMidnight();
    const slot = atTime(today, 13, 30);
    availableSlotFixtures = [slot.toISOString()];

    renderScreen();
    await screen.findByLabelText(`Schedule a session with ${CHW_NAME}`);
    fireEvent.click(await screen.findByLabelText('day view'));

    fireEvent.click(await screen.findByLabelText(slotCellLabel(today, 13, 30)));

    await screen.findByText('Schedule a session');
    expect(await screen.findByLabelText(`${pillLabel(slot)}, selected`)).toBeTruthy();
  });

  it('opens Session Details (NOT the scheduler) when an existing session card is tapped', async () => {
    additionalSessionFixtures = [confirmedTodayFixture];
    renderScreen();
    await screen.findByLabelText(`Schedule a session with ${CHW_NAME}`);
    fireEvent.click(await screen.findByLabelText('day view'));

    const card = await screen.findByLabelText(new RegExp(`^Session with ${CHW_NAME_CONTROL} at`));
    fireEvent.click(card);

    // The session block wins the tap: Session Details opens; the Schedule modal
    // title is never rendered by this tap.
    await screen.findByText('Session Details');
    expect(screen.queryByText('Schedule a session')).toBeNull();
  });
});
