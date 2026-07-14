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
// Epic D compliance banner persists "dismissed today" in AsyncStorage — an
// in-memory mock keeps the test deterministic and avoids depending on the
// real native module's jsdom shim (there isn't one).
vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => store.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(async () => {
        store.clear();
      }),
    },
  };
});
// See CHWMessagesScreen.test.tsx for why this needs a full literal
// replacement rather than `importOriginal` — @react-navigation/native's real
// barrel drags in an extension-less import that jsdom/vite-node can't
// resolve. CHWDashboardScreen only uses `useNavigation` from this package.
// `mockNavigate` is hoisted so every `useNavigation()` call (including the
// one inside the local `DashboardMemberLink` helper — Epic S) returns the
// SAME spy, needed to assert its "Back to …" origin params below.
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
import AsyncStorageMock from '@react-native-async-storage/async-storage';
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

// ─── Today's Schedule fixture (Epic S — "Back to …" origin params) ──────────
//
// Empty by default (matches the pre-existing tests above, which don't care
// about the schedule list) — set per-test via `sessionsResponse` so only the
// Epic S describe block below pays the cost of a scheduled session.
const SCHEDULED_MEMBER_ID = 'member-today-1';
const SCHEDULED_MEMBER_NAME = 'Rosa Gutierrez';

/** Always "today" — computed fresh so the fixture never goes stale. */
function todayAt(hour: number): string {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

const scheduledTodaySessionFixture = {
  id: 'sess-today-1',
  request_id: 'req-today-1',
  chw_id: CHW_USER_ID,
  member_id: SCHEDULED_MEMBER_ID,
  member_name: SCHEDULED_MEMBER_NAME,
  vertical: 'housing',
  status: 'scheduled',
  mode: 'in_person',
  scheduled_at: todayAt(14),
};

let sessionsResponse: unknown[] = [];

/** Epic D — compliance checklist fixture. Fully compliant by default (empty
 * `missing`) so pre-existing tests that don't care about the banner never
 * see it render unexpectedly. Tests exercising the banner itself override
 * this per-test. */
let checklistResponse: {
  can_work: boolean;
  missing: string[];
  items: Array<{ code: string; status: string }>;
} = {
  can_work: true,
  missing: [],
  items: [],
};

function routeApi(path: string, options?: { method?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path === '/chw/profile' && method === 'GET') {
    return chwProfileFixture;
  }

  if (path === '/credentials/checklist' && method === 'GET') {
    return checklistResponse;
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
    return sessionsResponse;
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
  sessionsResponse = [];
  checklistResponse = { can_work: true, missing: [], items: [] };
  mockNavigate.mockClear();
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string }) =>
    routeApi(path, options),
  );
  void AsyncStorageMock.clear();
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

describe('CHWDashboardScreen — Compliance banner (Epic D)', () => {
  it('does not render the banner when the checklist is fully compliant (missing=[])', async () => {
    checklistResponse = { can_work: true, missing: [], items: [] };
    renderScreen();

    await waitFor(() => expect(screen.getByText(/sessions today/i)).toBeTruthy());
    expect(screen.queryByText('Finish your compliance checklist')).toBeNull();
  });

  it('renders the banner listing missing items in plain language when can_work is false', async () => {
    checklistResponse = {
      can_work: false,
      missing: ['hipaa_training', 'background_check'],
      items: [],
    };
    renderScreen();

    await waitFor(() =>
      expect(screen.getByText('Finish your compliance checklist')).toBeTruthy(),
    );
    expect(screen.getByText(/Upload your HIPAA training certificate/)).toBeTruthy();
    expect(screen.getByText(/background check is still in review/)).toBeTruthy();
  });

  it('navigates to the Profile screen when "Go to Profile" is pressed', async () => {
    checklistResponse = { can_work: false, missing: ['hipaa_training'], items: [] };
    renderScreen();

    const link = await screen.findByLabelText('Go to compliance checklist');
    link.click();

    expect(mockNavigate).toHaveBeenCalledWith('Profile');
  });

  it('dismisses the banner for the day and does not re-render it on remount the same day', async () => {
    checklistResponse = { can_work: false, missing: ['hipaa_training'], items: [] };
    const { unmount } = renderScreen();

    await waitFor(() =>
      expect(screen.getByText('Finish your compliance checklist')).toBeTruthy(),
    );

    const dismissBtn = screen.getByLabelText('Dismiss compliance reminder for today');
    dismissBtn.click();

    await waitFor(() =>
      expect(screen.queryByText('Finish your compliance checklist')).toBeNull(),
    );
    // Let the fire-and-forget AsyncStorage.setItem write settle before
    // unmounting, so its resolution doesn't land as an out-of-act update.
    await waitFor(() => expect(AsyncStorageMock.setItem).toHaveBeenCalled());

    unmount();

    // Remount — same simulated "day" (AsyncStorage mock persists across
    // renders within this test) — banner must stay dismissed.
    renderScreen();
    await waitFor(() => expect(screen.getByText(/sessions today/i)).toBeTruthy());
    expect(screen.queryByText('Finish your compliance checklist')).toBeNull();
  });
});

describe('CHWDashboardScreen — AlertsSection (QA batch #12)', () => {
  function memberFixture(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'member-new-1',
      display_name: 'Jordan Diaz',
      age: 34,
      date_of_birth: '1991-01-01',
      masked_id: '...1234',
      medi_cal_id: null,
      avatar_initials: 'JD',
      status: 'active',
      risk: null,
      engagement: 'moderately',
      active_journey: null,
      last_contact_at: null,
      top_need: null,
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  it('shows a "New member account created" alert for a roster member created within 48h', async () => {
    const members = [memberFixture({ id: 'm1', display_name: 'Jordan Diaz' })];
    mockedApi.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === '/chw/members' && (options?.method ?? 'GET') === 'GET') return members;
      return routeApi(path, options);
    });
    renderScreen();

    await waitFor(() => expect(screen.getByText('New member account created')).toBeTruthy());
    expect(screen.getByText('Jordan Diaz')).toBeTruthy();
  });

  it('does not show an alert for a roster member created more than 48h ago', async () => {
    const oldCreatedAt = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const members = [memberFixture({ id: 'm-old', display_name: 'Old Member', created_at: oldCreatedAt })];
    mockedApi.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === '/chw/members' && (options?.method ?? 'GET') === 'GET') return members;
      return routeApi(path, options);
    });
    renderScreen();

    await waitFor(() => expect(screen.getByText(/sessions today/i)).toBeTruthy());
    expect(screen.queryByText('New member account created')).toBeNull();
  });

  it('stacks the compliance banner AND a new-member alert together without overlap (both visible)', async () => {
    checklistResponse = { can_work: false, missing: ['hipaa_training'], items: [] };
    const members = [memberFixture({ id: 'm2', display_name: 'Sam Rivera' })];
    mockedApi.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === '/chw/members' && (options?.method ?? 'GET') === 'GET') return members;
      return routeApi(path, options);
    });
    renderScreen();

    await waitFor(() => expect(screen.getByText('Finish your compliance checklist')).toBeTruthy());
    expect(screen.getByText('New member account created')).toBeTruthy();
    expect(screen.getByText('Sam Rivera')).toBeTruthy();
  });

  it('dismissing a new-member alert persists per-member-id and survives remount', async () => {
    const members = [memberFixture({ id: 'm3', display_name: 'Casey Lee' })];
    mockedApi.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === '/chw/members' && (options?.method ?? 'GET') === 'GET') return members;
      return routeApi(path, options);
    });
    const { unmount } = renderScreen();

    await waitFor(() => expect(screen.getByText('Casey Lee')).toBeTruthy());

    const dismissBtn = screen.getByLabelText('Dismiss new member alert for Casey Lee');
    dismissBtn.click();

    await waitFor(() => expect(screen.queryByText('Casey Lee')).toBeNull());
    await waitFor(() =>
      expect(AsyncStorageMock.setItem).toHaveBeenCalledWith(
        'chw_new_member_alert_dismissed_m3',
        '1',
      ),
    );

    unmount();
    renderScreen();

    await waitFor(() => expect(screen.getByText(/sessions today/i)).toBeTruthy());
    expect(screen.queryByText('Casey Lee')).toBeNull();
  });

  it('a DIFFERENT new member still gets its own alert after another member was dismissed', async () => {
    const members = [
      memberFixture({ id: 'm-dismissed', display_name: 'Dismissed Member' }),
      memberFixture({ id: 'm-fresh', display_name: 'Fresh Member' }),
    ];
    mockedApi.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === '/chw/members' && (options?.method ?? 'GET') === 'GET') return members;
      return routeApi(path, options);
    });
    void AsyncStorageMock.setItem('chw_new_member_alert_dismissed_m-dismissed', '1');

    renderScreen();

    await waitFor(() => expect(screen.getByText('Fresh Member')).toBeTruthy());
    expect(screen.queryByText('Dismissed Member')).toBeNull();
  });
});

describe('CHWDashboardScreen — Add New Member gate (QA batch #2)', () => {
  it('Add New Member stays enabled when the work gate is off, even if can_work is false', async () => {
    checklistResponse = { can_work: false, missing: ['hipaa_training'], items: [] };
    // gate_enabled omitted -> transformKeys yields undefined, treated as
    // "not gated" (matches the backend's own default-False semantics).
    renderScreen();

    const btn = await screen.findByLabelText('Add a new member');
    expect(btn.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('Add New Member stays enabled when can_work is true, even if gate_enabled is true', async () => {
    checklistResponse = {
      can_work: true,
      missing: [],
      items: [],
      // @ts-expect-error -- test fixture augments the mocked response shape
      gate_enabled: true,
    };
    renderScreen();

    const btn = await screen.findByLabelText('Add a new member');
    expect(btn.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('Add New Member is disabled when gate_enabled is true AND can_work is false', async () => {
    checklistResponse = {
      can_work: false,
      missing: ['hipaa_training'],
      items: [],
      // @ts-expect-error -- test fixture augments the mocked response shape
      gate_enabled: true,
    };
    renderScreen();

    const btn = await screen.findByLabelText(
      'Add a new member (disabled until your compliance checklist is complete)',
    );
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('CHWDashboardScreen — Member Profile origin params (Epic S "Back to …")', () => {
  it('opening a member from Today\'s Schedule passes backLabel "Dashboard" / backTo "Dashboard"', async () => {
    sessionsResponse = [scheduledTodaySessionFixture];
    renderScreen();

    // ScheduleRow wraps BOTH the avatar and the member name in their own
    // DashboardMemberLink (same accessibility label) — grab the first.
    const memberLinks = await screen.findAllByLabelText(`Open ${SCHEDULED_MEMBER_NAME}'s profile`);
    expect(memberLinks.length).toBeGreaterThanOrEqual(1);
    memberLinks[0].click();

    expect(mockNavigate).toHaveBeenCalledWith('SessionsStack', {
      screen: 'MemberProfile',
      params: { memberId: SCHEDULED_MEMBER_ID, backLabel: 'Dashboard', backTo: 'Dashboard' },
    });
  });
});
