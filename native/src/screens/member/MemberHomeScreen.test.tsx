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
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { api } from '../../api/client';
import { MemberHomeScreen } from './MemberHomeScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MEMBER_USER_ID = 'member-1';
const CHW_ID = 'chw-1';
const CHW_NAME = 'Rosa Gutierrez';

const memberProfileFixture = {
  id: 'profile-1',
  user_id: MEMBER_USER_ID,
  zip_code: '90001',
  primary_language: 'English',
  primary_need: 'housing',
  rewards_balance: 40,
  name: 'Test Member',
};

// ─── API router — the sole network boundary ──────────────────────────────────

let assignedChwResponse: unknown = null;
let sessionsResponse: unknown[] = [];

function routeApi(path: string, options?: { method?: string }): unknown {
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
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string }) =>
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
