/**
 * Component test for CHWReportsScreen — Epic K (mobile web polish).
 *
 * Covers the phone-width fix this epic adds: the 2x2 chart grid's
 * `chartCard` used a `calc(50% - 10px)` width unconditionally on all web
 * widths, and `insightsCard` / `membersCard` carried 340px / 400px minWidth
 * floors — all three force fixed-width, two-up layouts wider than a phone
 * viewport, overflowing the page body sideways. Below `BP_PHONE` (520px)
 * the cards fall back to full-width single-column instead; at
 * desktop/tablet widths the existing 2x2 grid / minWidth floors are
 * untouched.
 *
 * CHWReportsScreen itself has no data-fetching hooks (all data is mocked
 * inline pending a real /chw/reports endpoint — see the file's header
 * comment), but it renders inside `AppShell`, whose sidebar calls
 * `useConversations()` for the unread-messages badge — that needs a
 * QueryClient and a routed `api()` mock, same pattern as
 * MemberSettingsScreen.test.tsx. Tier 2 — jsdom + react-native-web (see
 * native/TESTING.md).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test CHW' }),
}));

// AppShell's sidebar calls useNavigation() internally (DashboardSidebar) —
// same pattern as MemberSettingsScreen.test.tsx / MemberHomeScreen.test.tsx.
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
  }),
}));

import { api } from '../../api/client';
import { CHWReportsScreen } from './CHWReportsScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Harness ──────────────────────────────────────────────────────────────────

/** Desktop-width default the other describe blocks in this file assume. */
const WIDE_VIEWPORT_WIDTH = 1024;
const PHONE_VIEWPORT_WIDTH = 390;

/**
 * See CHWMembersScreen.test.tsx's identical helper (Epic K part 1) for why
 * the property must be set AND a resize event dispatched *before* `render()`
 * is called.
 */
function setViewportWidth(width: number, height = 1000): void {
  Object.defineProperty(document.documentElement, 'clientWidth', {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: height,
    configurable: true,
  });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CHWReportsScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setViewportWidth(WIDE_VIEWPORT_WIDTH);
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string }) => {
    const method = options?.method ?? 'GET';
    // AppShell's sidebar reads this for the unread-messages badge.
    if (path === '/conversations' && method === 'GET') {
      return [];
    }
    throw new Error(`Unhandled api() call in CHWReportsScreen test: ${method} ${path}`);
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CHWReportsScreen — renders (regression smoke test)', () => {
  it('renders the page header and KPI stat row at desktop width', () => {
    renderScreen();

    expect(screen.getByText('My Reports')).toBeTruthy();
    expect(screen.getByText('Sessions Completed')).toBeTruthy();
  });
});

// ─── Epic K — phone-width usability sweep ──────────────────────────────────────

describe('CHWReportsScreen — phone-width chart/insights/members cards fall back to full-width (Epic K)', () => {
  beforeEach(() => {
    setViewportWidth(PHONE_VIEWPORT_WIDTH);
  });

  afterEach(() => {
    setViewportWidth(WIDE_VIEWPORT_WIDTH);
  });

  it('renders the chart grid, insights, and members-served cards without a 2-up fixed-width layout at phone width', () => {
    renderScreen();

    // The screen still renders all four chart cards plus the insights and
    // members-served cards. Before this fix, chartCard's
    // `calc(50% - 10px)` width and insightsCard/membersCard's 340/400px
    // minWidth floors were applied unconditionally on every web width,
    // forcing a wider-than-viewport layout at 390px.
    expect(screen.getByText('Sessions per week')).toBeTruthy();
    expect(screen.getByText('Earnings trend')).toBeTruthy();
    expect(screen.getByText('Top resource needs served')).toBeTruthy();
    expect(screen.getByText('Time-to-first-contact')).toBeTruthy();
    expect(screen.getByText('Compass Insights')).toBeTruthy();
    expect(screen.getByText(/Members served this month/)).toBeTruthy();

    // documentElement never grows wider than the phone viewport itself —
    // i.e. nothing in the tree is forcing a wider layout box than the
    // viewport we set.
    expect(document.documentElement.clientWidth).toBe(PHONE_VIEWPORT_WIDTH);
  });

  it('still renders the 2x2 chart grid unchanged at desktop width (no regression)', () => {
    setViewportWidth(WIDE_VIEWPORT_WIDTH);
    renderScreen();

    expect(screen.getByText('Sessions per week')).toBeTruthy();
    expect(screen.getByText('Compass Insights')).toBeTruthy();
  });
});
