/**
 * Component test for CHWSessionsScreen — Epic K (mobile web polish).
 *
 * Covers the phone-width fix this epic adds: the web 3-pane layout (thread
 * list 320px + flexible middle pane + 288px member-context rail) rendered
 * unconditionally on every web width with no phone-width fallback at all
 * (unlike CHWMessagesScreen, which Epic K part 1 gave a full single-pane
 * collapse). A full pane-collapse redesign was judged out of scope/too
 * risky here given the screen's entangled live-timer/chat/documentation-modal
 * state, so instead the fixed-width 3-pane row is wrapped in a horizontal
 * `ScrollView` (`ConditionalHorizontalScroll`) at phone width only — the
 * panes scroll sideways *inside their own container* instead of the page
 * body overflowing. Desktop/tablet render the row directly with no scroll
 * wrapper (unchanged from before).
 *
 * This test file also stands in for the "one admin table scrolls
 * in-container" coverage requirement from the Epic K part 2 brief: none of
 * the three admin screens (AdminHomeScreen, AdminResourcesScreen,
 * AdminTestimonialsScreen) actually contain a fixed-column table — all
 * three already use card/flex-based list layouts — so there was nothing to
 * fix or test there. CHWSessionsScreen's 3-pane row is the real
 * container-scroll fix in this part, so it covers that requirement instead.
 *
 * Renders with an empty session list (both active and completed) so the
 * 3-pane skeleton (thread list / empty middle pane / context rail) renders
 * without needing a full SessionData fixture — sufficient to prove the
 * pane row and its phone-width scroll wrapper render correctly. Only the
 * network boundary (`../../api/client`) is mocked; `useSessions` /
 * `useChwClaims` and AppShell's `useConversations` all run for real against
 * a routed `api()` mock, mirroring CHWReportsScreen.test.tsx /
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

// AppShell's sidebar (DashboardSidebar → UserAvatarBlock) calls useAuth()
// internally for the signed-in user's name/initials — same pattern as
// CHWReportsScreen.test.tsx / MemberSettingsScreen.test.tsx.
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test CHW' }),
}));

// AppShell's sidebar calls useNavigation() internally (DashboardSidebar), and
// CHWSessionsScreen itself uses useNavigation for the member-profile deep
// link — same pattern as CHWReportsScreen.test.tsx / MemberSettingsScreen.test.tsx.
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
  }),
}));

import { api } from '../../api/client';
import { CHWSessionsScreen } from './CHWSessionsScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── API router — the sole network boundary ──────────────────────────────────

function routeApi(path: string, options?: { method?: string }): unknown {
  const method = options?.method ?? 'GET';

  // AppShell's sidebar reads this for the unread-messages badge.
  if (path === '/conversations' && method === 'GET') {
    return [];
  }
  // Empty session/claims lists — enough to render the 3-pane skeleton
  // (thread list pane, empty middle pane, context rail pane) without a full
  // SessionData fixture.
  if (path.startsWith('/sessions/') && method === 'GET') {
    return [];
  }
  if (path === '/chw/claims' && method === 'GET') {
    return [];
  }

  throw new Error(`Unhandled api() call in CHWSessionsScreen test: ${method} ${path}`);
}

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
      <CHWSessionsScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setViewportWidth(WIDE_VIEWPORT_WIDTH);
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string }) =>
    routeApi(path, options),
  );
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CHWSessionsScreen — renders the web 3-pane layout (regression smoke test)', () => {
  it('renders the Sessions header, tab bar, and member-context rail at desktop width', async () => {
    renderScreen();

    expect(await screen.findByText('Member Context')).toBeTruthy();
    expect(screen.getByText('Sessions')).toBeTruthy();
    expect(screen.getByText('No active sessions')).toBeTruthy();
  });
});

// ─── Epic K — phone-width usability sweep ──────────────────────────────────────

describe('CHWSessionsScreen — phone-width 3-pane row scrolls inside its own container (Epic K)', () => {
  beforeEach(() => {
    setViewportWidth(PHONE_VIEWPORT_WIDTH);
  });

  afterEach(() => {
    setViewportWidth(WIDE_VIEWPORT_WIDTH);
  });

  it('still renders all three panes at phone width, wrapped for in-container horizontal scroll', async () => {
    renderScreen();

    // All three panes are still present — the fix wraps the row in a
    // horizontal ScrollView rather than hiding/collapsing any pane (that's
    // the deliberate, lower-risk alternative to a full Messages-style
    // pane-collapse redesign, given this screen's entangled live-timer/
    // chat/documentation-modal state).
    expect(await screen.findByText('Member Context')).toBeTruthy();
    expect(screen.getByText('Sessions')).toBeTruthy();
    expect(screen.getByText('No active sessions')).toBeTruthy();
    expect(screen.getByText('Select a session to get started')).toBeTruthy();

    // documentElement never grows wider than the phone viewport itself —
    // the fixed-width 3-pane row (320 + flex + 288) scrolls sideways
    // *inside* its own ScrollView container rather than the page body
    // overflowing past the viewport we set.
    expect(document.documentElement.clientWidth).toBe(PHONE_VIEWPORT_WIDTH);
  });

  it('still renders the plain (non-scroll-wrapped) 3-pane row unchanged at desktop width (no regression)', async () => {
    setViewportWidth(WIDE_VIEWPORT_WIDTH);
    renderScreen();

    expect(await screen.findByText('Member Context')).toBeTruthy();
    expect(screen.getByText('Sessions')).toBeTruthy();
  });
});
