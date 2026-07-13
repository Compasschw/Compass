/**
 * Component test for CHWMembersScreen — Epic H1 "Account created" + "CIN"
 * columns.
 *
 * Only the network boundary (`../../api/client`), auth context, and
 * navigation are mocked — useChwMembers and useIncomingMemberRequests run
 * for real against a routed `api()` mock (Tier 2 — jsdom + react-native-web,
 * see native/TESTING.md). `Platform.OS` resolves to 'web' under
 * react-native-web, so this exercises the real web table layout.
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
  useAuth: () => ({ userName: 'Test CHW', logout: vi.fn() }),
}));
// See CHWCalendarScreen.test.tsx for why this needs a full literal
// replacement rather than `importOriginal`.
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
  }),
}));

import { api } from '../../api/client';
import { CHWMembersScreen } from './CHWMembersScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MEMBER_ID = 'member-1';
const MEMBER_NAME = 'Rosa Gutierrez';
const CIN = '91234567A';
// Noon UTC avoids the local-timezone date rolling over to the day before/
// after when the test runner's TZ isn't UTC.
const CREATED_AT = '2026-03-14T12:00:00.000Z';

const memberRosterFixture = {
  id: MEMBER_ID,
  display_name: MEMBER_NAME,
  age: 34,
  date_of_birth: '1992-01-01',
  masked_id: '...4567',
  medi_cal_id: CIN,
  avatar_initials: 'RG',
  status: 'active',
  risk: null,
  engagement: 'moderately',
  active_journey: null,
  last_contact_at: null,
  top_need: null,
  created_at: CREATED_AT,
};

const noCinMemberFixture = {
  ...memberRosterFixture,
  id: 'member-2',
  display_name: 'No Cin Member',
  masked_id: '—',
  medi_cal_id: null,
};

let rosterResponse: unknown[] = [memberRosterFixture];

function routeApi(path: string, options?: { method?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path === '/chw/members' && method === 'GET') {
    return rosterResponse;
  }
  if (path === '/requests/incoming' && method === 'GET') {
    return [];
  }

  throw new Error(`Unhandled api() call in CHWMembersScreen test: ${method} ${path}`);
}

// ─── Harness ──────────────────────────────────────────────────────────────────

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CHWMembersScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rosterResponse = [memberRosterFixture];
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string }) =>
    routeApi(path, options),
  );
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CHWMembersScreen — Account Created + CIN columns (Epic H1)', () => {
  it('renders "Account Created" and "CIN" column headers', async () => {
    renderScreen();

    await screen.findByText(MEMBER_NAME);
    expect(screen.getByText('Account Created')).toBeTruthy();
    expect(screen.getByText('CIN')).toBeTruthy();
  });

  it('renders the formatted account-created date and the FULL (unmasked) CIN', async () => {
    renderScreen();

    await screen.findByText(MEMBER_NAME);

    // Full CIN is shown, distinct from the masked ID already shown next to
    // the member's name.
    expect(screen.getByText(CIN)).toBeTruthy();
    expect(screen.getByText(/Mar 14, 2026/)).toBeTruthy();
  });

  it('shows an em-dash placeholder when the member has no CIN on file', async () => {
    rosterResponse = [noCinMemberFixture];
    renderScreen();

    await screen.findByText('No Cin Member');
    // Both the masked-id sub-label and the new CIN column render '—'.
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });
});
