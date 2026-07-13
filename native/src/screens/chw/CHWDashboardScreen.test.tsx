/**
 * Component test for CHWDashboardScreen's "Member satisfaction" snapshot box.
 *
 * Regression coverage for Epic B1 (plan: cosmic-swinging-tiger.md): the box
 * used to render a hardcoded "4.9" regardless of the CHW's actual reviews.
 * It now sources the real average + count from the Testimonial system via
 * GET /chws/{chw_id}/testimonials/summary (useTestimonialSummary, keyed by
 * the CHW's own userId from useChwProfile), and must NEVER fabricate a
 * number — "No ratings yet" when ratingCount is 0/null.
 *
 * Only the network boundary (`../../api/client`), auth context, and
 * navigation hooks are mocked — every data hook (useSessions, useRequests,
 * useChwEarnings, useChwClaims, useChwMembers, useCHWIntake, useChwProfile,
 * useTestimonialSummary) runs for real against a routed `api()` mock
 * (Tier 2 — jsdom + react-native-web, see native/TESTING.md).
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
  useAuth: () => ({ userName: 'Test CHW' }),
}));
// See CHWMessagesScreen.test.tsx for why this needs a full literal
// replacement rather than `importOriginal` — @react-navigation/native's real
// barrel drags in an extension-less import that jsdom/vite-node can't
// resolve. CHWDashboardScreen only uses `useNavigation` from this package.
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
}));

import { api } from '../../api/client';
import { CHWDashboardScreen } from './CHWDashboardScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CHW_USER_ID = 'chw-user-1';

const chwProfileFixture = {
  id: 'chw-profile-1',
  user_id: CHW_USER_ID,
  specializations: ['Utilities'],
  languages: ['English'],
  rating: 0,
  years_experience: 5,
  total_sessions: 12,
  is_available: true,
  bio: 'Community Health Worker bio.',
  zip_code: '90001',
  name: 'Test CHW',
};

const earningsFixture = {
  this_month: 500,
  all_time: 5000,
  avg_rating: 0,
  sessions_this_week: 2,
  pending_payout: 100,
  earnings_this_period: 500,
  paid_this_period: 400,
  pending_in_transit: true,
  next_payout_date: null,
};

/** Mutable per-test so each `it()` controls the testimonial-summary response. */
let testimonialSummaryFixture: { rating_avg: number | null; rating_count: number } = {
  rating_avg: null,
  rating_count: 0,
};

function routeApi(path: string, options?: { method?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path === '/chw/profile' && method === 'GET') {
    return chwProfileFixture;
  }

  if (path === `/chws/${CHW_USER_ID}/testimonials/summary` && method === 'GET') {
    return testimonialSummaryFixture;
  }

  if (path.startsWith('/chw/earnings') && method === 'GET') {
    return earningsFixture;
  }

  if (path === '/chw/claims' && method === 'GET') {
    return [];
  }

  if (path === '/chw/members' && method === 'GET') {
    return [];
  }

  if (path === '/chw/intake' && method === 'GET') {
    return {};
  }

  if (path === '/sessions/' && method === 'GET') {
    return [];
  }

  if (path === '/requests/' && method === 'GET') {
    return [];
  }

  throw new Error(`Unhandled api() call in CHWDashboardScreen test: ${method} ${path}`);
}

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CHWDashboardScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  testimonialSummaryFixture = { rating_avg: null, rating_count: 0 };
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string }) =>
    routeApi(path, options),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CHWDashboardScreen — Member satisfaction snapshot box', () => {
  it('never renders the old hardcoded "4.9" literal, regardless of the real rating', async () => {
    testimonialSummaryFixture = { rating_avg: 4.6, rating_count: 8 };
    renderScreen();

    await waitFor(() => expect(screen.getByText('4.6')).toBeTruthy());
    expect(screen.queryByText('4.9')).toBeNull();
  });

  it('renders the real average rating with its review count when ratings exist', async () => {
    testimonialSummaryFixture = { rating_avg: 4.6, rating_count: 8 };
    renderScreen();

    await waitFor(() => expect(screen.getByText('4.6')).toBeTruthy());
    expect(screen.getByText(/8 reviews/)).toBeTruthy();
  });

  it('renders a singular "review" (not "reviews") when the count is exactly 1', async () => {
    testimonialSummaryFixture = { rating_avg: 5.0, rating_count: 1 };
    renderScreen();

    await waitFor(() => expect(screen.getByText('5.0')).toBeTruthy());
    expect(screen.getByText(/1 review\b/)).toBeTruthy();
    expect(screen.queryByText(/1 reviews/)).toBeNull();
  });

  it('shows "No ratings yet" — never a fabricated number — when ratingCount is 0', async () => {
    testimonialSummaryFixture = { rating_avg: null, rating_count: 0 };
    renderScreen();

    await waitFor(() => expect(screen.getByText('No ratings yet')).toBeTruthy());
    expect(screen.queryByText('4.9')).toBeNull();
    expect(screen.queryByText('4.6')).toBeNull();
  });

  it('shows "No ratings yet" when ratingAvg is present but ratingCount is 0 (defensive)', async () => {
    testimonialSummaryFixture = { rating_avg: 3.1, rating_count: 0 };
    renderScreen();

    await waitFor(() => expect(screen.getByText('No ratings yet')).toBeTruthy());
    expect(screen.queryByText('3.1')).toBeNull();
  });
});
