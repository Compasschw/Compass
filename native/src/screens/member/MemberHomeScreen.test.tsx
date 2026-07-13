/**
 * Component test for MemberHomeScreen's "Your CHW" hero — Epic G1 regression.
 *
 * Bug: a CHW-created member (POST /chw/members) is matched immediately via
 * ServiceRequest.matched_chw_id, but has zero sessions yet. The OLD hero
 * logic derived the assigned CHW purely from session history (`chwName`/
 * `chwId` on the most-recent session), so this member incorrectly saw
 * "You haven't been matched with a CHW yet".
 *
 * Fix: GET /member/chw (backed by ServiceRequest.matched_chw_id, the same
 * relationship column) is now the primary source; session-derived data is
 * only a defensive fallback.
 *
 * Only the network boundary (`../../api/client`) and auth context are
 * mocked — useSessions, useMemberProfile, useMemberRoadmap, useRequests,
 * useMemberJourneys, and useAssignedCHW all run for real against a routed
 * `api()` mock (Tier 2 — jsdom + react-native-web, see native/TESTING.md).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub only the network call; keep ApiError real so PromptDialog's onError
// branching (err instanceof ApiError) works exactly as it does in production.
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test Member', logout: vi.fn() }),
}));
// AppShell's sidebar calls useNavigation() internally (DashboardSidebar). The
// real `@react-navigation/native` barrel drags in an extension-less import
// that jsdom/vite-node can't resolve — same pattern as
// CHWCalendarScreen.test.tsx / ActiveSessionBadge.test.tsx.
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
  }),
}));

import { api, ApiError } from '../../api/client';
import { MemberHomeScreen } from './MemberHomeScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MEMBER_USER_ID = 'member-1';
const CHW_ID = 'chw-1';
const CHW_NAME = 'Rosa Gutierrez';

function buildMemberProfileFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    user_id: MEMBER_USER_ID,
    zip_code: '90001',
    primary_language: 'English',
    primary_need: 'housing',
    rewards_balance: 40,
    name: 'Test Member',
    must_change_password: false,
    ...overrides,
  };
}

// ─── Pending Session Requests widget fixtures ───────────────────────────────
// (CHW_ID / CHW_NAME reused from the Epic G1 fixtures above.)

const CHW_PROPOSED_SESSION_ID = 'sess-pending-chw-proposed-1';
const NEW_SESSION_ID = 'sess-new-1';

const scheduledStart = new Date();
scheduledStart.setDate(scheduledStart.getDate() + 3);
scheduledStart.setHours(14, 0, 0, 0); // 2:00 PM local
const scheduledEnd = new Date(scheduledStart.getTime() + 60 * 60 * 1000);

/** A pending session the CHW proposed — must appear in the dashboard widget. */
const chwProposedSessionFixture = {
  id: CHW_PROPOSED_SESSION_ID,
  request_id: 'req-1',
  chw_id: CHW_ID,
  member_id: MEMBER_USER_ID,
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

// ─── API router — the sole network boundary ──────────────────────────────────

let assignedChwResponse: unknown = null;
let sessionsResponse: unknown[] = [];
let memberProfileFixture: Record<string, unknown> = buildMemberProfileFixture();
/** Controls what POST /auth/change-password does for the next call. */
let changePasswordBehavior: 'success' | 'wrong-current' | 'weak' | null = 'success';
let changePasswordRequestBodies: Array<{ current_password: string; new_password: string }> = [];
/** Controls what POST /sessions/schedule does for the Propose New Time flow. */
let scheduleShouldFail = false;

function routeApi(path: string, options?: { method?: string; body?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path === '/member/profile' && method === 'GET') {
    return memberProfileFixture;
  }
  if (path.startsWith('/sessions/') && method === 'GET') {
    return sessionsResponse;
  }
  if (path === '/member/roadmap' && method === 'GET') {
    return [];
  }
  if (path === '/requests/' && method === 'GET') {
    return [];
  }
  if (path === '/member/chw' && method === 'GET') {
    return assignedChwResponse;
  }
  if (path === `/members/${MEMBER_USER_ID}/journeys` && method === 'GET') {
    return [];
  }
  if (path === '/auth/change-password' && method === 'POST') {
    const body = JSON.parse(options?.body ?? '{}') as {
      current_password: string;
      new_password: string;
    };
    changePasswordRequestBodies.push(body);
    if (changePasswordBehavior === 'wrong-current') {
      throw new ApiError(401, 'Current password is incorrect');
    }
    if (changePasswordBehavior === 'weak') {
      throw new ApiError(422, 'new_password must be at least 8 characters');
    }
    // Success: mirror the real backend — clear the flag so a subsequent
    // GET /member/profile (triggered by the mutation's query invalidation
    // and this screen's explicit refetch) reflects the change.
    memberProfileFixture = buildMemberProfileFixture({ must_change_password: false });
    return { detail: 'Password updated successfully', must_change_password: false };
  }
  if (path === '/sessions/schedule' && method === 'POST') {
    if (scheduleShouldFail) {
      throw new Error('Network error');
    }
    const body = options?.body ? JSON.parse(options.body) : {};
    return {
      id: NEW_SESSION_ID,
      request_id: 'req-new',
      chw_id: body.chw_id,
      member_id: MEMBER_USER_ID,
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
  if (path === `/sessions/${CHW_PROPOSED_SESSION_ID}/confirm` && method === 'PATCH') {
    return { ...chwProposedSessionFixture, scheduling_status: 'confirmed' };
  }
  if (path === `/sessions/${CHW_PROPOSED_SESSION_ID}/decline` && method === 'PATCH') {
    return { ...chwProposedSessionFixture, status: 'cancelled', scheduling_status: null };
  }

  throw new Error(`Unhandled api() call in MemberHomeScreen test: ${method} ${path}`);
}

// ─── Harness ──────────────────────────────────────────────────────────────────

const mockNavigation = {
  navigate: vi.fn(),
  goBack: vi.fn(),
  addListener: vi.fn(() => vi.fn()),
  setOptions: vi.fn(),
};

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const MemberHomeScreenAny = MemberHomeScreen as unknown as React.FC<Record<string, unknown>>;
  return render(
    <QueryClientProvider client={qc}>
      <MemberHomeScreenAny navigation={mockNavigation} route={{}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  assignedChwResponse = null;
  sessionsResponse = [];
  memberProfileFixture = buildMemberProfileFixture();
  changePasswordBehavior = 'success';
  changePasswordRequestBodies = [];
  scheduleShouldFail = false;
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) =>
    routeApi(path, options),
  );
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MemberHomeScreen — "Your CHW" hero (Epic G1)', () => {
  it('shows the matched CHW from GET /member/chw even with zero sessions', async () => {
    // The exact CHW-created-member scenario: matched via ServiceRequest, but
    // no session has been scheduled yet.
    assignedChwResponse = { id: CHW_ID, name: CHW_NAME };
    sessionsResponse = [];

    renderScreen();

    expect(await screen.findByText(CHW_NAME)).toBeTruthy();
    expect(screen.queryByText(/haven.t been matched/i)).toBeNull();
  });

  it('shows the "not matched" placeholder when neither /member/chw nor sessions have a match', async () => {
    assignedChwResponse = null;
    sessionsResponse = [];

    renderScreen();

    expect(await screen.findByText(/haven.t been matched with a CHW yet/i)).toBeTruthy();
  });

  it('falls back to session-derived CHW info when /member/chw has no match', async () => {
    assignedChwResponse = null;
    sessionsResponse = [
      {
        id: 'sess-1',
        request_id: 'req-1',
        chw_id: CHW_ID,
        member_id: MEMBER_USER_ID,
        vertical: 'housing',
        status: 'completed',
        mode: 'in_person',
        scheduled_at: '2026-06-01T10:00:00.000Z',
        created_at: '2026-06-01T00:00:00.000Z',
        chw_name: CHW_NAME,
        member_name: 'Test Member',
      },
    ];

    renderScreen();

    expect(await screen.findByText(CHW_NAME)).toBeTruthy();
  });

  it('prefers the /member/chw match over session-derived data when both are present', async () => {
    assignedChwResponse = { id: CHW_ID, name: CHW_NAME };
    sessionsResponse = [
      {
        id: 'sess-1',
        request_id: 'req-1',
        chw_id: 'chw-other',
        member_id: MEMBER_USER_ID,
        vertical: 'housing',
        status: 'completed',
        mode: 'in_person',
        scheduled_at: '2026-06-01T10:00:00.000Z',
        created_at: '2026-06-01T00:00:00.000Z',
        chw_name: 'A Different CHW',
        member_name: 'Test Member',
      },
    ];

    renderScreen();

    expect(await screen.findByText(CHW_NAME)).toBeTruthy();
    expect(screen.queryByText('A Different CHW')).toBeNull();
  });
});

// ─── Mandatory first-login password change (Epic G2) ───────────────────────

function setPasswordFieldText(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fillAndSubmitPasswordPrompt({
  currentPassword = 'temp-pass-1234',
  newPassword = 'brand-new-password-1',
  confirmPassword = 'brand-new-password-1',
}: {
  currentPassword?: string;
  newPassword?: string;
  confirmPassword?: string;
} = {}): void {
  setPasswordFieldText('Current (temporary) password', currentPassword);
  setPasswordFieldText('New password', newPassword);
  setPasswordFieldText('Confirm new password', confirmPassword);
  fireEvent.click(screen.getByLabelText('Update password'));
}

describe('MemberHomeScreen — first-login password change (Epic G2)', () => {
  it('shows the password prompt when the member profile reports must_change_password', async () => {
    memberProfileFixture = buildMemberProfileFixture({ must_change_password: true });

    renderScreen();

    expect(await screen.findByText('Set your password')).toBeTruthy();
    expect(screen.getByLabelText('Current (temporary) password')).toBeTruthy();
    expect(screen.getByLabelText('New password')).toBeTruthy();
    expect(screen.getByLabelText('Confirm new password')).toBeTruthy();
  });

  it('does not show the password prompt for a self-registered member', async () => {
    memberProfileFixture = buildMemberProfileFixture({ must_change_password: false });

    renderScreen();

    // Wait for the screen to finish loading before asserting the prompt's
    // absence — assignedChwResponse/sessionsResponse default to null/[],
    // so the "not matched" placeholder is a reliable loaded-state signal
    // (same one used by the Epic G1 tests above).
    await screen.findByText(/haven.t been matched with a CHW yet/i);
    expect(screen.queryByText('Set your password')).toBeNull();
  });

  it('submits the current/new password to POST /auth/change-password and clears the prompt on success', async () => {
    memberProfileFixture = buildMemberProfileFixture({ must_change_password: true });
    changePasswordBehavior = 'success';

    renderScreen();

    await screen.findByText('Set your password');
    fillAndSubmitPasswordPrompt();

    await waitFor(() => {
      expect(changePasswordRequestBodies).toEqual([
        { current_password: 'temp-pass-1234', new_password: 'brand-new-password-1' },
      ]);
    });

    await waitFor(() => {
      expect(screen.queryByText('Set your password')).toBeNull();
    });
  });

  it('surfaces a wrong-current-password error inline and keeps the prompt open', async () => {
    memberProfileFixture = buildMemberProfileFixture({ must_change_password: true });
    changePasswordBehavior = 'wrong-current';

    renderScreen();

    await screen.findByText('Set your password');
    fillAndSubmitPasswordPrompt({ currentPassword: 'wrong-temp-password' });

    expect(await screen.findByText('Current password is incorrect.')).toBeTruthy();
    // The prompt must remain — a wrong password is not a fatal/blocking error.
    expect(screen.getByText('Set your password')).toBeTruthy();
  });

  it('surfaces a mismatch error inline without calling the API', async () => {
    memberProfileFixture = buildMemberProfileFixture({ must_change_password: true });

    renderScreen();

    await screen.findByText('Set your password');
    fillAndSubmitPasswordPrompt({ newPassword: 'brand-new-password-1', confirmPassword: 'different-password-1' });

    expect(await screen.findByText('Passwords do not match.')).toBeTruthy();
    expect(changePasswordRequestBodies).toEqual([]);
  });
});

// ─── Pending Session Requests dashboard widget ──────────────────────────────
//
// Reciprocal of CHWCalendarScreen's "Pending Session Requests" widget — a
// member sees CHW-proposed pending sessions here too, reusing the SAME
// useConfirmSession/useDeclineSession/useScheduleSession mutations the CHW
// side uses (see MemberPendingRequestsList.tsx). The widget is mounted right
// after PageHeader, ABOVE the "Your CHW" hero — a sibling to the G2 password
// gate (which renders as an independent overlay outside AppShell), so it
// must never affect whether/when that gate shows.

async function openProposeModal(): Promise<void> {
  const proposeBtn = await screen.findByLabelText(`Propose new time for ${CHW_NAME}`);
  fireEvent.click(proposeBtn);
  await screen.findByLabelText('Propose new time'); // submit button, proves the modal opened
}

describe('MemberHomeScreen — Pending Session Requests widget', () => {
  it('renders a CHW-proposed pending request with all 3 actions (Approve / Decline / Propose New Time)', async () => {
    sessionsResponse = [chwProposedSessionFixture];

    renderScreen();

    expect(await screen.findByLabelText(`Approve request from ${CHW_NAME}`)).toBeTruthy();
    expect(screen.getByLabelText(`Decline request from ${CHW_NAME}`)).toBeTruthy();
    expect(screen.getByLabelText(`Propose new time for ${CHW_NAME}`)).toBeTruthy();
  });

  it('does NOT show a member-proposed pending request (proposedBy: "member")', async () => {
    sessionsResponse = [
      {
        ...chwProposedSessionFixture,
        id: 'sess-pending-member-proposed-1',
        proposed_by: 'member',
      },
    ];

    renderScreen();

    // Loaded state confirmed via the session-derived "Your CHW" hero (the
    // fixture still carries chwName/chwId, so the hero shows the CHW even
    // though the pending widget must render nothing for this session).
    await screen.findAllByText(CHW_NAME);
    expect(screen.queryByLabelText(`Approve request from ${CHW_NAME}`)).toBeNull();
    expect(screen.queryByText(/Pending Session Requests/)).toBeNull();
  });

  it('does NOT show a legacy pending request with no proposedBy field (safe-default exclusion)', async () => {
    const { proposed_by: _proposedBy, ...legacyFixture } = chwProposedSessionFixture as Record<
      string,
      unknown
    >;
    sessionsResponse = [{ ...legacyFixture, id: 'sess-pending-legacy-1' }];

    renderScreen();

    await screen.findAllByText(CHW_NAME);
    expect(screen.queryByLabelText(`Approve request from ${CHW_NAME}`)).toBeNull();
    expect(screen.queryByText(/Pending Session Requests/)).toBeNull();
  });

  it('Approve fires the confirm mutation against PATCH /sessions/{id}/confirm', async () => {
    sessionsResponse = [chwProposedSessionFixture];
    renderScreen();

    fireEvent.click(await screen.findByLabelText(`Approve request from ${CHW_NAME}`));

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
    sessionsResponse = [chwProposedSessionFixture];
    renderScreen();

    fireEvent.click(await screen.findByLabelText(`Decline request from ${CHW_NAME}`));

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

  it('Propose New Time books the new session BEFORE declining the old one (never the reverse)', async () => {
    sessionsResponse = [chwProposedSessionFixture];
    renderScreen();
    await openProposeModal();

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
    expect(scheduleCallIndex).toBeGreaterThanOrEqual(0);
    expect(declineCallIndex).toBeGreaterThan(scheduleCallIndex);
  });

  it('does NOT decline the original session when the new booking fails', async () => {
    sessionsResponse = [chwProposedSessionFixture];
    scheduleShouldFail = true;
    renderScreen();
    await openProposeModal();

    fireEvent.click(screen.getByLabelText('Propose new time'));

    await waitFor(() => {
      expect(mockedApi.mock.calls.some(([path]) => path === '/sessions/schedule')).toBe(true);
    });

    expect(
      mockedApi.mock.calls.some(([path]) => path === `/sessions/${CHW_PROPOSED_SESSION_ID}/decline`),
    ).toBe(false);
    expect(screen.getByLabelText('Propose new time')).toBeTruthy();
  });

  it('does not affect the G2 must-change-password gate — the prompt still shows when required, alongside the widget', async () => {
    memberProfileFixture = buildMemberProfileFixture({ must_change_password: true });
    sessionsResponse = [chwProposedSessionFixture];

    renderScreen();

    expect(await screen.findByText('Set your password')).toBeTruthy();
    // The widget still renders underneath/alongside the gate — the gate is a
    // sibling overlay, not something the widget can suppress or reorder.
    expect(await screen.findByLabelText(`Approve request from ${CHW_NAME}`)).toBeTruthy();
  });
});
