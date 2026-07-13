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

// ─── API router — the sole network boundary ──────────────────────────────────

let assignedChwResponse: unknown = null;
let sessionsResponse: unknown[] = [];
let memberProfileFixture: Record<string, unknown> = buildMemberProfileFixture();
/** Controls what POST /auth/change-password does for the next call. */
let changePasswordBehavior: 'success' | 'wrong-current' | 'weak' | null = 'success';
let changePasswordRequestBodies: Array<{ current_password: string; new_password: string }> = [];

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
