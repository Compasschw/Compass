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
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test CHW', logout: vi.fn() }),
}));
// See CHWCalendarScreen.test.tsx for why this needs a full literal
// replacement rather than `importOriginal`. `mockNavigate` is hoisted so
// every `useNavigation()` call across re-renders returns the SAME spy —
// needed to assert the Epic S "Back to Members" call-site params below.
const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
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

// ─── Sort fixtures (QA item ③) ──────────────────────────────────────────────
//
// Three members with distinct name / createdAt / lastContactAt so each sort
// key produces a unique, assertable order. Arranged in the roster's DEFAULT
// (backend pre-sorted) order — last_contact_at DESC — to make the
// "default order unchanged" regression test meaningful: Bob (most recent
// contact) → Amy (older contact) → Zoe (never contacted, sorts last always).
const sortMemberBob = {
  ...memberRosterFixture,
  id: 'member-bob',
  display_name: 'Bob Baker',
  masked_id: '...0001',
  created_at: '2026-01-10T12:00:00.000Z',
  last_contact_at: '2026-06-20T12:00:00.000Z', // most recent contact
};

const sortMemberAmy = {
  ...memberRosterFixture,
  id: 'member-amy',
  display_name: 'Amy Adams',
  masked_id: '...0002',
  created_at: '2026-05-01T12:00:00.000Z', // most recently created
  last_contact_at: '2026-03-15T12:00:00.000Z', // older contact than Bob
};

const sortMemberZoe = {
  ...memberRosterFixture,
  id: 'member-zoe',
  display_name: 'Zoe Chavez',
  masked_id: '...0003',
  created_at: '2025-11-01T12:00:00.000Z', // oldest created
  last_contact_at: null, // never contacted — must always sort LAST
};

const sortFixtures = [sortMemberBob, sortMemberAmy, sortMemberZoe];

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

/** Desktop-width default the other describe blocks in this file assume. */
const WIDE_VIEWPORT_WIDTH = 1024;

/**
 * See CHWMessagesScreen.test.tsx's identical helper for why the property
 * must be set AND a resize event dispatched *before* `render()` is called.
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
      <CHWMembersScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rosterResponse = [memberRosterFixture];
  mockNavigate.mockClear();
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

describe('CHWMembersScreen — Roster sort (QA item ③)', () => {
  /** Reads the current top-to-bottom row order by DOM position. */
  function currentRowOrder(): string[] {
    const rows = sortFixtures.map((f) => ({
      name: f.display_name,
      el: screen.getByLabelText(`View profile for ${f.display_name}`),
    }));
    rows.sort((a, b) => {
      const position = a.el.compareDocumentPosition(b.el);
      // eslint-disable-next-line no-bitwise
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      return 1;
    });
    return rows.map((r) => r.name);
  }

  beforeEach(() => {
    rosterResponse = sortFixtures;
  });

  it('defaults to "Sort: Last contact ↓" and preserves the backend pre-sorted order (regression)', async () => {
    renderScreen();

    await screen.findByText('Bob Baker');
    expect(screen.getByText('Sort: Last contact ↓')).toBeTruthy();

    // Backend already returns Bob (most recent contact), Amy, Zoe (never
    // contacted) in that order — the default sort must not reorder it.
    expect(currentRowOrder()).toEqual(['Bob Baker', 'Amy Adams', 'Zoe Chavez']);
  });

  it('sorting by Name orders rows A→Z, and re-tapping flips to Z→A', async () => {
    renderScreen();
    await screen.findByText('Bob Baker');

    fireEvent.click(screen.getByLabelText(/Sort: Last contact descending/));
    fireEvent.click(screen.getByLabelText('Sort by Name'));

    expect(screen.getByText('Sort: Name ↓')).toBeTruthy();
    expect(currentRowOrder()).toEqual(['Zoe Chavez', 'Bob Baker', 'Amy Adams']);

    // Re-tap the now-active "Name" option to flip direction.
    fireEvent.click(screen.getByLabelText(/Sort: Name descending/));
    fireEvent.click(screen.getByLabelText(/Name, currently sorted descending/));

    expect(screen.getByText('Sort: Name ↑')).toBeTruthy();
    expect(currentRowOrder()).toEqual(['Amy Adams', 'Bob Baker', 'Zoe Chavez']);
  });

  it('sorting by Account created orders rows by createdAt', async () => {
    renderScreen();
    await screen.findByText('Bob Baker');

    fireEvent.click(screen.getByLabelText(/Sort: Last contact descending/));
    fireEvent.click(screen.getByLabelText('Sort by Account created'));

    expect(screen.getByText('Sort: Account created ↓')).toBeTruthy();
    // Newest created first: Amy (2026-05-01) > Bob (2026-01-10) > Zoe (2025-11-01).
    expect(currentRowOrder()).toEqual(['Amy Adams', 'Bob Baker', 'Zoe Chavez']);
  });

  it('sorting by Last contact with a null lastContactAt always sorts that member LAST, in both directions', async () => {
    renderScreen();
    await screen.findByText('Bob Baker');

    // Descending (default): Bob (newest contact) > Amy > Zoe (null, last).
    expect(currentRowOrder()).toEqual(['Bob Baker', 'Amy Adams', 'Zoe Chavez']);

    // Flip to ascending by re-tapping the active "Last contact" option.
    fireEvent.click(screen.getByLabelText(/Sort: Last contact descending/));
    fireEvent.click(screen.getByLabelText(/Last contact, currently sorted descending/));

    expect(screen.getByText('Sort: Last contact ↑')).toBeTruthy();
    // Ascending: Amy (oldest contact) > Bob (more recent) > Zoe (null, STILL last).
    expect(currentRowOrder()).toEqual(['Amy Adams', 'Bob Baker', 'Zoe Chavez']);
  });

  it('the sort trigger is an accessible button and options are selectable radios reflecting the active choice', async () => {
    renderScreen();
    await screen.findByText('Bob Baker');

    const trigger = screen.getByLabelText(/Sort: Last contact descending/);
    expect(trigger.getAttribute('role')).toBe('button');

    fireEvent.click(trigger);

    // react-native-web's jsdom test rendering doesn't surface
    // accessibilityState as an aria-checked attribute for custom roles (see
    // CHWCalendarScreen.test.tsx's Resource Needs chips for the same caveat)
    // — assert via role + the visible direction-arrow/check marker instead.
    const activeOption = screen.getByLabelText(/Last contact, currently sorted descending/);
    expect(activeOption.getAttribute('role')).toBe('radio');
    expect(activeOption.textContent).toContain('↓');

    const inactiveOption = screen.getByLabelText('Sort by Name');
    expect(inactiveOption.getAttribute('role')).toBe('radio');
    expect(inactiveOption.textContent).not.toContain('↓');
    expect(inactiveOption.textContent).not.toContain('↑');
  });
});

describe('CHWMembersScreen — Member Profile origin params (Epic S "Back to …")', () => {
  it('opening a member from the roster passes backLabel "Members" / backTo "CHWMembers"', async () => {
    renderScreen();

    const row = await screen.findByLabelText(`View profile for ${MEMBER_NAME}`);
    row.click();

    expect(mockNavigate).toHaveBeenCalledWith('SessionsStack', {
      screen: 'MemberProfile',
      params: { memberId: MEMBER_ID, backLabel: 'Members', backTo: 'CHWMembers' },
    });
  });
});

// ─── Epic K — phone-width usability sweep ──────────────────────────────────────

describe('CHWMembersScreen — phone-width falls back to cards, not a clipped table (Epic K)', () => {
  beforeEach(() => {
    setViewportWidth(390);
  });

  afterEach(() => {
    setViewportWidth(WIDE_VIEWPORT_WIDTH);
  });

  it('renders card rows (not the fixed-column table) at phone width', async () => {
    renderScreen();

    const card = await screen.findByLabelText(`View profile for ${MEMBER_NAME}`);
    expect(card).toBeTruthy();

    // The web table's column headers are absent — this proves the card
    // layout rendered instead of the table just being visually squeezed.
    expect(screen.queryByText('Account Created')).toBeNull();
    expect(screen.queryByText('CIN')).toBeNull();

    // The card still surfaces the same data the table's new columns did
    // (Epic H1 parity — see MemberCard's "Joined … · CIN …" line).
    expect(screen.getByText(/Joined Mar 14, 2026/)).toBeTruthy();
    expect(screen.getByText(new RegExp(CIN))).toBeTruthy();
  });

  it('still renders the full table at tablet/desktop width (no regression)', async () => {
    setViewportWidth(1024);
    renderScreen();

    await screen.findByText(MEMBER_NAME);
    expect(screen.getByText('Account Created')).toBeTruthy();
    expect(screen.getByText('CIN')).toBeTruthy();
  });
});
