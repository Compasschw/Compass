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
import { CHWCalendarScreen } from './CHWCalendarScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

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

const confirmedUpcomingStart = new Date(Date.now() + 2 * 60 * 60 * 1000); // +2h, today
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

const completedStart = new Date(Date.now() - 3 * 60 * 60 * 1000); // -3h, today
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

// ─── API router — the sole network boundary ──────────────────────────────────

let scheduleShouldFail = false;
let startShouldFail = false;

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

  if (path === '/sessions/' && method === 'GET') {
    return [pendingSessionFixture, confirmedSessionFixture, completedSessionFixture];
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

/**
 * Session Details modal — Begin Session / Propose New Time / Remove.
 *
 * For an upcoming, CHW-confirmed session (status 'scheduled', scheduledAt in
 * the future, NOT a still-pending member request) the modal's footer swaps
 * the plain "Open Member Profile" button for these three actions. A missed/
 * completed session is unaffected and keeps Open Member Profile only.
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

  it('shows Begin Session / Propose New Time / Remove for an upcoming confirmed session, not for a completed one', async () => {
    renderScreen();
    await openSessionDetails(MEMBER_NAME);

    expect(screen.getByLabelText('Begin session')).toBeTruthy();
    expect(screen.getByLabelText('Propose a new time')).toBeTruthy();
    expect(screen.getByLabelText('Remove session')).toBeTruthy();
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

  it('Remove only cancels the session after the Yes/No confirm is accepted (never via window.confirm)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderScreen();
    await openSessionDetails(MEMBER_NAME);

    fireEvent.click(screen.getByLabelText('Remove session'));
    await screen.findByText('Remove this scheduled session?');
    expect(confirmSpy).not.toHaveBeenCalled();

    // "No" — must NOT cancel. (react-native-web's Modal keeps content mounted
    // through its close animation rather than unmounting synchronously, so
    // assert on behavior — no cancel call — rather than the confirm text
    // disappearing from the DOM.)
    fireEvent.click(screen.getByLabelText('No, keep session'));
    expect(
      mockedApi.mock.calls.some(([path]) => path === `/sessions/${CONFIRMED_SESSION_ID}/cancel`),
    ).toBe(false);

    // "Yes" — cancels.
    fireEvent.click(screen.getByLabelText('Yes, remove session'));

    await waitFor(() => {
      expect(
        mockedApi.mock.calls.some(
          ([path, opts]) =>
            path === `/sessions/${CONFIRMED_SESSION_ID}/cancel` &&
            (opts as { method?: string })?.method === 'PATCH',
        ),
      ).toBe(true);
    });
    confirmSpy.mockRestore();
  });
});
