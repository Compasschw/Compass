/**
 * Component test for MemberFacingCHWProfileScreen's "Member Rating" stat tile.
 *
 * Regression coverage for Epic B1 (plan: cosmic-swinging-tiger.md): the tile
 * used to render a hardcoded "4.9" regardless of the CHW's actual reviews.
 * It now sources the real average + count from the Testimonial system via
 * GET /chws/{chw_id}/testimonials/summary (useTestimonialSummary), and must
 * NEVER fabricate a number — "No ratings yet" when ratingCount is 0/null.
 *
 * Only the network boundary (`../../api/client`), auth context, and
 * navigation hooks are mocked — useMemberFacingCHWProfile, useSessions, and
 * useTestimonialSummary all run for real against a routed `api()` mock
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
  useAuth: () => ({ userName: 'Test Member' }),
}));
// See CHWMessagesScreen.test.tsx for why this needs a full literal
// replacement rather than `importOriginal` — @react-navigation/native's real
// barrel drags in an extension-less import that jsdom/vite-node can't
// resolve. This screen only uses `useNavigation` and `useRoute` (plus the
// type-only `RouteProp`, erased at compile time) from this package.
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
    goBack: vi.fn(),
    canGoBack: () => true,
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
  useRoute: () => ({ params: {} }),
}));

import { api } from '../../api/client';
import { MemberFacingCHWProfileScreen } from './MemberFacingCHWProfileScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CHW_ID = 'chw-1';

const chwProfileFixture = {
  id: CHW_ID,
  first_name: 'Maria',
  last_name_initial: 'S.',
  primary_language: 'English',
  additional_languages: [] as string[],
  primary_specialization: 'Utilities',
  years_experience: '5 years',
  ca_chw_certified: true,
  modality: 'in_person',
  service_area_zips: ['90001'],
  available_days: ['mon', 'wed'],
  availability_windows: {},
  shared_session_count: 3,
  profile_picture_url: null,
};

/** Mutable per-test so each `it()` controls the testimonial-summary response. */
let testimonialSummaryFixture: { rating_avg: number | null; rating_count: number } = {
  rating_avg: null,
  rating_count: 0,
};

function routeApi(path: string, options?: { method?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path === `/member/chws/${CHW_ID}` && method === 'GET') {
    return chwProfileFixture;
  }

  if (path === `/chws/${CHW_ID}/testimonials/summary` && method === 'GET') {
    return testimonialSummaryFixture;
  }

  if (path.startsWith('/sessions/') && method === 'GET') {
    return [];
  }

  throw new Error(`Unhandled api() call in MemberFacingCHWProfileScreen test: ${method} ${path}`);
}

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemberFacingCHWProfileScreen chwId={CHW_ID} hideBack />
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

describe('MemberFacingCHWProfileScreen — Member Rating stat tile', () => {
  it('never renders the old hardcoded "4.9" literal, regardless of the real rating', async () => {
    testimonialSummaryFixture = { rating_avg: 4.7, rating_count: 23 };
    renderScreen();

    await waitFor(() => expect(screen.getByText('4.7')).toBeTruthy());
    expect(screen.queryByText('4.9')).toBeNull();
  });

  it('renders the real average rating with its review count when ratings exist', async () => {
    testimonialSummaryFixture = { rating_avg: 4.7, rating_count: 23 };
    renderScreen();

    await waitFor(() => expect(screen.getByText('4.7')).toBeTruthy());
    expect(screen.getByText(/23 reviews/)).toBeTruthy();
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
    expect(screen.queryByText('4.7')).toBeNull();
  });

  it('shows "No ratings yet" when ratingAvg is present but ratingCount is 0 (defensive)', async () => {
    // Defensive case: a malformed/edge-case backend response shouldn't ever
    // let a number through without at least one contributing review.
    testimonialSummaryFixture = { rating_avg: 3.2, rating_count: 0 };
    renderScreen();

    await waitFor(() => expect(screen.getByText('No ratings yet')).toBeTruthy());
    expect(screen.queryByText('3.2')).toBeNull();
  });
});

describe('MemberFacingCHWProfileScreen — QA2 #11: sparse-profile crash regression', () => {
  it('renders (no error boundary) when the CHW profile is nearly empty', async () => {
    // Reproduces the prod "Something went wrong" crash on /member/my-chw:
    // a CHW with a barely-filled profile returned undefined/absent fields and
    // the derivation code indexed/spread them (firstName[0],
    // ...additionalLanguages). Every field below is intentionally missing or
    // null except the id.
    mockedApi.mockImplementation(async (path: string, options?: { method?: string }) => {
      const method = options?.method ?? 'GET';
      if (path === `/member/chws/${CHW_ID}` && method === 'GET') {
        return {
          id: CHW_ID,
          first_name: null,
          last_name_initial: null,
          primary_language: null,
          additional_languages: null, // not even an array
          primary_specialization: null,
          years_experience: null,
          ca_chw_certified: null,
          modality: null,
          service_area_zips: null,
          available_days: null,
          availability_windows: null,
          shared_session_count: null,
          profile_picture_url: null,
        };
      }
      if (path === `/chws/${CHW_ID}/testimonials/summary` && method === 'GET') {
        return { rating_avg: null, rating_count: 0 };
      }
      if (path.startsWith('/sessions/') && method === 'GET') return [];
      if (path.startsWith('/conversations')) return []; // AppShell unread badge
      return {};
    });

    renderScreen();

    // The screen must settle into a rendered state — the ?? fallback initials
    // and the ratings empty state prove the happy render path completed.
    await waitFor(() => expect(screen.getByText('No ratings yet')).toBeTruthy());
    expect(screen.getByText('??')).toBeTruthy();
  });
});
