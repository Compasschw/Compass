/**
 * Status-label tests for CHWCalendarScreen's `deriveBadgeStatus` — Epic P + O2
 * ("Missed" status for a no-show session).
 *
 * Kept in a SEPARATE file from CHWCalendarScreen.test.tsx (per file-ownership
 * rules for this change — another agent's edits and tests live there) so this
 * change doesn't touch that file at all. Same import shape
 * (`import { CHWCalendarScreen, deriveBadgeStatus } from './CHWCalendarScreen'`)
 * as the existing O1 `deriveBadgeStatus` describe block in that file.
 *
 * Covers:
 *   - deriveBadgeStatus(no_show) === 'Missed' (new, Epic O2)
 *   - deriveBadgeStatus(cancelled) === 'Cancelled' (regression, O1 unchanged)
 *   - deriveBadgeStatus(past-scheduled-never-started) === 'Confirmed' (O1 regression)
 *   - a no_show session still renders on the Day grid (record-keeping) while a
 *     cancelled session does not (N1 regression) — rendered-UI assertion tying
 *     the pure mapping back to the actual calendar grid.
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test CHW', logout: vi.fn() }),
}));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
}));

import { api } from '../../api/client';
import type { SessionData } from '../../hooks/useApiQueries';
import { CHWCalendarScreen, deriveBadgeStatus } from './CHWCalendarScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Pure-logic tests: deriveBadgeStatus ───────────────────────────────────────

describe('CHWCalendarScreen — deriveBadgeStatus "Missed" for no_show (Epic O2)', () => {
  const now = new Date('2026-07-12T18:00:00.000Z');

  /** Builds a minimal-but-valid SessionData row with the given overrides. */
  function makeSession(overrides: Partial<SessionData>): SessionData {
    return {
      id: 's-1',
      requestId: 'r-1',
      chwId: 'chw-1',
      memberId: 'member-1',
      vertical: 'housing',
      mode: 'in_person',
      status: 'scheduled',
      scheduledAt: '2026-07-12T15:00:00.000Z',
      createdAt: '2026-07-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('maps no_show → "Missed"', () => {
    expect(deriveBadgeStatus(makeSession({ status: 'no_show' }), now)).toBe('Missed');
  });

  it('maps cancelled → "Cancelled" (O1/N1 regression — no_show must not be conflated with cancelled)', () => {
    expect(deriveBadgeStatus(makeSession({ status: 'cancelled' }), now)).toBe('Cancelled');
  });

  it('maps cancelled_no_consent → "Cancelled" (regression)', () => {
    expect(deriveBadgeStatus(makeSession({ status: 'cancelled_no_consent' }), now)).toBe('Cancelled');
  });

  it('does NOT label a past-but-never-started scheduled session "Missed" — stays "Confirmed" (O1 regression)', () => {
    const past = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    expect(
      deriveBadgeStatus(makeSession({ status: 'scheduled', scheduledAt: past }), now),
    ).toBe('Confirmed');
  });

  it('maps completed → "Completed" (regression)', () => {
    expect(deriveBadgeStatus(makeSession({ status: 'completed' }), now)).toBe('Completed');
  });

  it('maps a still-pending scheduling request → "Pending" (regression)', () => {
    expect(
      deriveBadgeStatus(makeSession({ status: 'scheduled', schedulingStatus: 'pending' }), now),
    ).toBe('Pending');
  });
});

// ─── Rendered-UI regression: no_show stays visible, cancelled does not (N1) ────

const CHW_ID = 'chw-1';
const MEMBER_ID_CONTROL = 'member-control';
const MEMBER_NAME_CONTROL = 'Control Member';
const MEMBER_ID_NOSHOW = 'member-noshow';
const MEMBER_NAME_NOSHOW = 'Noshow Member';
const MEMBER_ID_CANCELLED = 'member-cancelled';
const MEMBER_NAME_CANCELLED = 'Cancelled Member';

// Day-view "today" fixture anchoring — same clamp-inside-today approach as
// CHWCalendarScreen.test.tsx (Day view reads the real calendar date; module-
// level TODAY_YEAR/MONTH/DAY constants there can't be overridden by fake
// timers), so all three fixtures must land on today, before end-of-day.
const _fxNow = new Date();
const _endOfToday = new Date(_fxNow);
_endOfToday.setHours(23, 59, 59, 999);
const FUTURE_TODAY = new Date((_fxNow.getTime() + _endOfToday.getTime()) / 2);

function fixtureAt(overrides: {
  id: string;
  member_id: string;
  member_name: string;
  status: string;
}) {
  const start = new Date(FUTURE_TODAY);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    id: overrides.id,
    request_id: `req-${overrides.id}`,
    chw_id: CHW_ID,
    member_id: overrides.member_id,
    vertical: 'housing',
    status: overrides.status,
    mode: 'in_person',
    scheduled_at: start.toISOString(),
    scheduled_end_at: end.toISOString(),
    scheduling_status: overrides.status === 'scheduled' ? 'confirmed' : null,
    created_at: '2026-07-01T00:00:00.000Z',
    chw_name: 'Test CHW',
    member_name: overrides.member_name,
  };
}

const controlFixture = fixtureAt({
  id: 'sess-control',
  member_id: MEMBER_ID_CONTROL,
  member_name: MEMBER_NAME_CONTROL,
  status: 'scheduled',
});
const noShowFixture = fixtureAt({
  id: 'sess-noshow',
  member_id: MEMBER_ID_NOSHOW,
  member_name: MEMBER_NAME_NOSHOW,
  status: 'no_show',
});
const cancelledFixture = fixtureAt({
  id: 'sess-cancelled',
  member_id: MEMBER_ID_CANCELLED,
  member_name: MEMBER_NAME_CANCELLED,
  status: 'cancelled',
});

function routeApi(path: string, options?: { method?: string }): unknown {
  const method = options?.method ?? 'GET';
  if (path === '/sessions/' && method === 'GET') {
    return [controlFixture, noShowFixture, cancelledFixture];
  }
  if (path === '/chw/members' && method === 'GET') {
    return [];
  }
  if (path.startsWith('/conversations/')) {
    return [];
  }
  throw new Error(`Unhandled api() call in CHWCalendarScreen.status test: ${method} ${path}`);
}

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

beforeEach(() => {
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string }) =>
    routeApi(path, options),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CHWCalendarScreen — no_show stays visible on the Day grid tagged "Missed"; cancelled does not (N1 regression)', () => {
  it('renders a no_show session as a Day-view card, but not a cancelled one', async () => {
    renderScreen();
    fireEvent.click(await screen.findByLabelText('day view'));

    // Control: a non-terminal same-day session renders, proving the day's
    // data actually loaded (a false negative here would make the assertions
    // below meaningless).
    await screen.findByLabelText(new RegExp(`^Session with ${MEMBER_NAME_CONTROL} at`));

    // no_show (Epic O2) — record-keeping: stays visible, unlike cancelled.
    expect(
      screen.getByLabelText(new RegExp(`^Session with ${MEMBER_NAME_NOSHOW} at`)),
    ).toBeTruthy();

    // cancelled (N1) — still excluded entirely.
    expect(
      screen.queryByLabelText(new RegExp(`^Session with ${MEMBER_NAME_CANCELLED} at`)),
    ).toBeNull();
  });

  it('shows the "Missed" badge text on the no_show session\'s card', async () => {
    renderScreen();
    fireEvent.click(await screen.findByLabelText('day view'));

    const card = await screen.findByLabelText(
      new RegExp(`^Session with ${MEMBER_NAME_NOSHOW} at`),
    );
    expect(card.textContent).toContain('Missed');
  });
});
