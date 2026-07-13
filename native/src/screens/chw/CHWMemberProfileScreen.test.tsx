/**
 * Component test for CHWMemberProfileScreen's dynamic "Back to …" web
 * header link (Epic S).
 *
 * The link used to be hard-wired to "Back to Members" → the CHWMembers tab
 * regardless of where the CHW navigated from (Map, Dashboard, Messages,
 * …). It now reads `backLabel`/`backTo` route params (set by the calling
 * screen — see CHWMembersScreen.test.tsx / CHWMapScreen.test.tsx /
 * CHWDashboardScreen.test.tsx for the call-site assertions) and falls back
 * to the original "Back to Members" → CHWMembers behavior when either is
 * absent, so every existing/not-yet-updated entry path (including
 * CHWMessagesScreen, out of scope for this change) keeps working exactly
 * as before.
 *
 * Only the network boundary (`../../api/client`), auth context, and
 * navigation hooks (`useNavigation`/`useRoute`) are mocked — the member
 * profile's own data hooks (useMemberDetail, useAssessmentLatest,
 * useMemberServicesConsent, useMemberBillingStatus, useFlagNote,
 * useChwBillableUnits, useJourneyTemplates, useMemberJourneys,
 * useMemberRewardsBalance, useCaseNotes, useSessionNotes,
 * useMemberDocuments) all run for real against a routed `api()` mock —
 * Tier 2 (jsdom + react-native-web, see native/TESTING.md).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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
// resolve. CHWMemberProfileScreen only uses `useNavigation`, `useRoute`
// (plus the type-only `RouteProp`, erased at compile time) from this
// package. `mockNavigate` is hoisted so every `useNavigation()` call
// returns the SAME spy, and `routeParams` is a mutable module-level object
// each test overwrites before rendering, so `useRoute()` reflects whatever
// params that test wants to simulate the caller having passed.
const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
let routeParams: Record<string, unknown> = {};
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
  useRoute: () => ({ params: routeParams }),
}));

import { api } from '../../api/client';
import { CHWMemberProfileScreen } from './CHWMemberProfileScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MEMBER_ID = 'member-1';
const MEMBER_NAME = 'Maria Lopez';

const memberDetailFixture = {
  id: MEMBER_ID,
  first_name: 'Maria',
  last_name: 'Lopez',
  profile_picture_url: null,
  preferred_name: null,
  phone_e164: '+15551234567',
  email: 'maria@example.com',
  primary_language: 'English',
  additional_languages: [],
  address: '123 Main St',
  city: 'Fresno',
  zip_code: '93701',
  mco: null,
  address_line1: '123 Main St',
  address_line2: null,
  city_name: 'Fresno',
  state: 'CA',
  ecm_eligible: false,
  primary_categories: [],
  resource_needs: [],
  resource_need_levels: [],
  billing_units: {
    today_used: 0,
    today_remaining: 4,
    yearly_used: 0,
    yearly_remaining: 200,
  },
  session_count: 0,
  last_session_at: null,
  open_goals: [],
  open_followups: [],
  consent_status: { ai_transcription: 'none', session_recording: 'none' },
  recent_sessions: [],
  date_of_birth: '1990-01-01',
  gender: 'Female',
  medi_cal_id: null,
  closure_status: null,
  closure_reason: null,
  closed_at: null,
};

function routeApi(path: string, options?: { method?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path === `/chw/members/${MEMBER_ID}` && method === 'GET') {
    return memberDetailFixture;
  }
  if (path === `/chw/members/${MEMBER_ID}/assessments/latest` && method === 'GET') {
    throw Object.assign(new Error('Not Found'), { status: 404 });
  }
  if (path === `/member/services-consent?member_id=${MEMBER_ID}` && method === 'GET') {
    return { value: null, changed_at: null, last_changed_by: null };
  }
  if (path === `/members/${MEMBER_ID}/billing-status` && method === 'GET') {
    return { is_billable: true, changed_at: null, changed_by: null };
  }
  if (path === `/members/${MEMBER_ID}/flag-note` && method === 'GET') {
    return null;
  }
  if (path === `/chw/members/${MEMBER_ID}/billable-units` && method === 'GET') {
    return {
      daily: { used: 0, limit: 4, remaining: 4 },
      yearly: { used: 0, limit: 200, remaining: 200 },
      as_of_la_local_date: '2026-07-12',
    };
  }
  if (path === '/journeys/templates' && method === 'GET') {
    return [];
  }
  if (path === `/members/${MEMBER_ID}/journeys` && method === 'GET') {
    return [];
  }
  if (path === `/members/${MEMBER_ID}/rewards/balance` && method === 'GET') {
    return {
      member_id: MEMBER_ID,
      current_balance: 0,
      earned_lifetime: 0,
      redeemed_lifetime: 0,
      next_unlock_item: null,
      points_to_next: 0,
    };
  }
  if (path.startsWith(`/members/${MEMBER_ID}/case-notes`) && method === 'GET') {
    return { items: [], total: 0, limit: 50, offset: 0 };
  }
  if (path === `/chw/members/${MEMBER_ID}/session-notes` && method === 'GET') {
    return [];
  }
  if (path.startsWith(`/members/${MEMBER_ID}/documents`) && method === 'GET') {
    return { items: [], total: 0, page: 1, page_size: 50 };
  }

  throw new Error(`Unhandled api() call in CHWMemberProfileScreen test: ${method} ${path}`);
}

// ─── Harness ──────────────────────────────────────────────────────────────────

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CHWMemberProfileScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  routeParams = { memberId: MEMBER_ID };
  mockNavigate.mockClear();
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string }) =>
    routeApi(path, options),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CHWMemberProfileScreen — dynamic "Back to …" link (Epic S)', () => {
  it('defaults to "Back to Members" and navigates to CHWMembers when no backLabel/backTo params are passed', async () => {
    // No backLabel/backTo — mirrors an entry path that hasn't been updated
    // (e.g. Messages, out of scope for this change) or any caller that
    // simply omits them.
    routeParams = { memberId: MEMBER_ID };
    renderScreen();

    await waitFor(() => expect(screen.getByText(MEMBER_NAME)).toBeTruthy());

    const backLink = screen.getByLabelText('Back to Members');
    expect(backLink).toBeTruthy();
    expect(screen.getByText('Back to Members')).toBeTruthy();

    backLink.click();
    expect(mockNavigate).toHaveBeenCalledWith('CHWMembers');
  });

  it('renders "Back to Map" and navigates to Map when backLabel="Map"/backTo="Map" are passed', async () => {
    routeParams = { memberId: MEMBER_ID, backLabel: 'Map', backTo: 'Map' };
    renderScreen();

    await waitFor(() => expect(screen.getByText(MEMBER_NAME)).toBeTruthy());

    expect(screen.queryByText('Back to Members')).toBeNull();
    const backLink = screen.getByLabelText('Back to Map');
    expect(backLink).toBeTruthy();
    expect(screen.getByText('Back to Map')).toBeTruthy();

    backLink.click();
    expect(mockNavigate).toHaveBeenCalledWith('Map');
  });

  it('renders "Back to Dashboard" and navigates to Dashboard when backLabel="Dashboard"/backTo="Dashboard" are passed', async () => {
    routeParams = { memberId: MEMBER_ID, backLabel: 'Dashboard', backTo: 'Dashboard' };
    renderScreen();

    await waitFor(() => expect(screen.getByText(MEMBER_NAME)).toBeTruthy());

    const backLink = screen.getByLabelText('Back to Dashboard');
    expect(backLink).toBeTruthy();

    backLink.click();
    expect(mockNavigate).toHaveBeenCalledWith('Dashboard');
  });
});
