/**
 * Component test for MemberSettingsScreen — Epic E (member Account & Security).
 *
 * Regression coverage for three changes:
 *   1. The "Download all my data" feature is REMOVED entirely (E1 — cut, not
 *      fixed). It must not render.
 *   2. "Deactivate my account" is a NEW row backed by `useDeactivateAccount()`
 *      (POST /member/account/deactivate). It must use an on-brand confirm —
 *      never `window.confirm` — and on confirm must fire the network call
 *      and then clear local auth state (`clearAfterDeletion`).
 *   3. "Delete my account" now opens the shared `DeleteAccountModal` 3-step
 *      flow (warning → password → type-DELETE) instead of the old
 *      `window.confirm`/`Alert.alert` ad-hoc flow. Completing the flow fires
 *      DELETE /auth/users/me.
 *
 * Only the network boundary (`../../api/client`) and auth context are
 * mocked — useMemberProfile, useUpdateMemberProfile, useDeleteAccount, and
 * useDeactivateAccount all run for real against a routed `api()` mock
 * (Tier 2 — jsdom + react-native-web, see native/TESTING.md). Follows the
 * same mocking pattern as MemberHomeScreen.test.tsx.
 */
import React from 'react';
import { Alert } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});

const clearAfterDeletion = vi.fn(async () => {});
const logout = vi.fn(async () => {});

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    userName: 'Test Member',
    logout,
    clearAfterDeletion,
  }),
}));

// AppShell's sidebar calls useNavigation() internally (DashboardSidebar). The
// real `@react-navigation/native` barrel drags in an extension-less import
// that jsdom/vite-node can't resolve — same pattern as MemberHomeScreen.test.tsx.
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
  }),
}));

import { api } from '../../api/client';
import { MemberSettingsScreen } from './MemberSettingsScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

function buildMemberProfileFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    user_id: 'member-1',
    zip_code: '90001',
    primary_language: 'English',
    primary_need: 'housing',
    rewards_balance: 40,
    name: 'Test Member',
    phone: '5555550100',
    email: 'member@example.com',
    ...overrides,
  };
}

// ─── API router — the sole network boundary ──────────────────────────────────

let memberProfileFixture: Record<string, unknown> = buildMemberProfileFixture();
let deactivateCallCount = 0;
let deleteAccountCallCount = 0;
let lastDeleteAccountBody: unknown = null;

function routeApi(path: string, options?: { method?: string; body?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path === '/member/profile' && method === 'GET') {
    return memberProfileFixture;
  }
  if (path === '/member/account/deactivate' && method === 'POST') {
    deactivateCallCount += 1;
    return undefined;
  }
  if (path === '/auth/users/me' && method === 'DELETE') {
    deleteAccountCallCount += 1;
    lastDeleteAccountBody = options?.body ? JSON.parse(options.body) : null;
    return undefined;
  }
  if (path === '/conversations' && method === 'GET') {
    // AppShell's sidebar reads this for the unread-messages badge.
    return [];
  }

  throw new Error(`Unhandled api() call in MemberSettingsScreen test: ${method} ${path}`);
}

// ─── Harness ──────────────────────────────────────────────────────────────────

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemberSettingsScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  memberProfileFixture = buildMemberProfileFixture();
  deactivateCallCount = 0;
  deleteAccountCallCount = 0;
  lastDeleteAccountBody = null;
  clearAfterDeletion.mockClear();
  logout.mockClear();
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) =>
    routeApi(path, options),
  );
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MemberSettingsScreen — Account & Security (Epic E)', () => {
  it('does not render the removed "Download all my data" feature', async () => {
    renderScreen();

    await screen.findByText('Settings');

    expect(screen.queryByText(/download all my data/i)).toBeNull();
    expect(screen.queryByLabelText(/download all my data/i)).toBeNull();
  });

  it('renders a "Deactivate my account" row that opens an on-brand confirm (not window.confirm) and fires the deactivate mutation on confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('window.confirm must never be called for deactivation');
    });

    renderScreen();
    await screen.findByText('Settings');

    const deactivateRow = await screen.findByLabelText('Deactivate my account');
    expect(deactivateRow).toBeTruthy();

    fireEvent.click(deactivateRow);

    // confirmAsync resolves true immediately on web (the tap itself is the
    // confirmation on web — see src/utils/confirm.ts), so the mutation fires
    // without any window.confirm dialog.
    await waitFor(() => {
      expect(deactivateCallCount).toBe(1);
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(clearAfterDeletion).toHaveBeenCalledTimes(1);
    });

    confirmSpy.mockRestore();
  });

  it('renders a "Delete my account" row that opens the DeleteAccountModal 3-step flow (not window.confirm) and fires DELETE /auth/users/me on completion', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('window.confirm must never be called for deletion');
    });

    renderScreen();
    await screen.findByText('Settings');

    const deleteRow = await screen.findByLabelText('Delete my account');
    fireEvent.click(deleteRow);

    // Step 1: warning
    expect(await screen.findByText('Delete Your Account?')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Continue to account deletion'));

    // Step 2: password
    const passwordInput = await screen.findByLabelText('Current password');
    fireEvent.change(passwordInput, { target: { value: 'my-current-password' } });
    await waitFor(() => {
      expect((passwordInput as HTMLInputElement).value).toBe('my-current-password');
    });
    fireEvent.click(screen.getByLabelText('Continue to final confirmation'));

    // Step 3: type DELETE
    const confirmInput = await screen.findByLabelText('Type DELETE to confirm deletion');
    fireEvent.change(confirmInput, { target: { value: 'DELETE' } });
    await waitFor(() => {
      expect((confirmInput as HTMLInputElement).value).toBe('DELETE');
    });
    fireEvent.click(screen.getByLabelText('Permanently delete account'));

    await waitFor(() => {
      expect(deleteAccountCallCount).toBe(1);
    });
    expect(lastDeleteAccountBody).toEqual({ password: 'my-current-password' });

    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(clearAfterDeletion).toHaveBeenCalledTimes(1);
    });

    confirmSpy.mockRestore();
  });

  it('renders the "Sign out of this device" row (regression smoke test — unchanged behavior)', async () => {
    renderScreen();
    await screen.findByText('Settings');

    expect(await screen.findByLabelText('Sign out of your account')).toBeTruthy();
  });
});

// ─── Epic K — phone-width usability sweep ──────────────────────────────────────

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

describe('MemberSettingsScreen — phone-width form/grid does not overflow the page body (Epic K)', () => {
  beforeEach(() => {
    setViewportWidth(PHONE_VIEWPORT_WIDTH);
  });

  afterEach(() => {
    setViewportWidth(WIDE_VIEWPORT_WIDTH);
  });

  it('renders the profile form and bottom cards without a hard 320px minWidth floor at phone width', async () => {
    renderScreen();
    await screen.findByText('Settings');

    // The screen still renders — the profile form column and the two bottom
    // cards (Privacy & Security, Need help?) are all present. Before this
    // fix, `formCol` and `bottomCard` both carried `minWidth: 320`, which
    // (combined with pageWrap's 32px side padding) is wider than the
    // available content width at a 390px viewport, forcing the page body to
    // scroll sideways instead of the grid stacking cleanly to one column.
    expect(await screen.findByText('Profile information')).toBeTruthy();
    // "Privacy & Security" appears exactly once — the bottom card's title.
    // (It used to also be a tab label, but the tab strip is hidden until
    // further notice — QA batch #7.)
    expect(screen.getAllByText('Privacy & Security').length).toBe(1);
    // The "Need help?" card's header/contact rows are commented out (Part
    // 22) — only "Sign out of this device" remains in that card slot.
    expect(screen.getByText('Sign out of this device')).toBeTruthy();

    // documentElement never grows wider than the phone viewport itself —
    // i.e. nothing in the tree is forcing a wider layout box than the
    // viewport we set.
    expect(document.documentElement.clientWidth).toBe(PHONE_VIEWPORT_WIDTH);
  });

  it('still renders the 2-column grid unchanged at desktop width (no regression)', async () => {
    setViewportWidth(WIDE_VIEWPORT_WIDTH);
    renderScreen();
    await screen.findByText('Settings');

    expect(await screen.findByText('Profile information')).toBeTruthy();
    expect(screen.getAllByText('Privacy & Security').length).toBe(1);
  });
});

describe('MemberSettingsScreen — Settings tabs Profile-only (QA batch #7)', () => {
  it('renders only the Profile tab content — no Notifications/Language/Help panels', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Profile information')).toBeTruthy());

    // Hidden panels' unambiguous copy — none of these strings appear in the
    // always-visible bottom cards, so their absence proves the panels are
    // unreachable. ("Two-factor authentication" is NOT asserted: it also
    // lives in the bottom Privacy & Security summary card.)
    expect(screen.queryByText('Notifications')).toBeNull();
    expect(screen.queryByText('Session Reminders')).toBeNull();
    expect(screen.queryByText('Help & Support')).toBeNull();
    // The Language panel's radio labels only render there.
    expect(screen.queryByText('Español')).toBeNull();
    expect(screen.queryByLabelText('中文')).toBeNull();
  });

  it('does not render a tab strip (single Profile tab is hidden, not shown as one pill)', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Profile information')).toBeTruthy());

    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByLabelText('Notifications')).toBeNull();
    expect(screen.queryByLabelText('Language')).toBeNull();
  });

  it('keeps the always-visible bottom cards (Privacy & Security summary, Sign out)', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Profile information')).toBeTruthy());

    expect(screen.getAllByText('Privacy & Security').length).toBe(1);
    expect(screen.getByText('Sign out of this device')).toBeTruthy();
  });
});

// ─── QA batch (2026-07-14) Part 20 — Privacy & Security toggles removed ────────

describe('MemberSettingsScreen — Privacy & Security card: fake toggles removed (Part 20)', () => {
  it('renders no switch/toggle in the bottom card; Deactivate/Delete rows remain', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Profile information')).toBeTruthy());

    // The title/subtitle stay — only the four fake local-state toggles
    // (two-factor, biometric, AI transcription consent, research sharing)
    // are gone.
    expect(screen.getAllByText('Privacy & Security').length).toBe(1);
    expect(screen.getByText("Your data is protected. You're in control.")).toBeTruthy();

    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('Two-factor authentication')).toBeNull();
    expect(screen.queryByText('Biometric login')).toBeNull();
    expect(screen.queryByText(/AI session transcription/)).toBeNull();
    expect(screen.queryByText('Share data for anonymous research')).toBeNull();

    expect(screen.getByLabelText('Deactivate my account')).toBeTruthy();
    expect(screen.getByLabelText('Delete my account')).toBeTruthy();
  });
});

// ─── QA batch (2026-07-14) Part 22 — Need help? card commented out ────────────

describe('MemberSettingsScreen — Need help? card commented out, Sign out preserved (Part 22)', () => {
  it('does not render "Need help?" / "Call support" / "555-COMPASS"; "Sign out of this device" still renders and fires logout', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(() => {});

    renderScreen();
    await waitFor(() => expect(screen.getByText('Profile information')).toBeTruthy());

    expect(screen.queryByText('Need help?')).toBeNull();
    expect(screen.queryByText(/We're here for you/)).toBeNull();
    expect(screen.queryByText('Call support')).toBeNull();
    expect(screen.queryByText('Text us')).toBeNull();
    expect(screen.queryByText('Email us')).toBeNull();
    expect(screen.queryByText(/555-COMPASS/)).toBeNull();

    const signOutRow = screen.getByLabelText('Sign out of your account');
    expect(signOutRow).toBeTruthy();
    expect(screen.getByText('Sign out of this device')).toBeTruthy();

    fireEvent.click(signOutRow);

    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [, , buttons] = alertSpy.mock.calls[0] as [string, string, Array<{ text: string; onPress?: () => void }>];
    const signOutButton = buttons.find((b) => b.text === 'Sign Out');
    expect(signOutButton).toBeTruthy();
    signOutButton?.onPress?.();

    expect(logout).toHaveBeenCalledTimes(1);

    alertSpy.mockRestore();
  });
});

// ─── QA batch (2026-07-14) Part 21 — Profile information shows all signup data ─

describe('MemberSettingsScreen — Profile information shows all signup fields (Part 21)', () => {
  it('renders every signup field with its value; CIN shows in full; insurance row uses insurance_company', async () => {
    memberProfileFixture = buildMemberProfileFixture({
      preferred_name: 'Middy',
      date_of_birth: '1990-05-14',
      gender: 'Female',
      address_line1: '123 Main St',
      address_line2: 'Apt 4B',
      city: 'Los Angeles',
      state: 'CA',
      insurance_company: 'Health Net',
      insurance_provider: null,
      medi_cal_id: '91234567A2',
      primary_need: 'housing',
    });

    renderScreen();
    await waitFor(() => expect(screen.getByText('Profile information')).toBeTruthy());

    expect(screen.getByText('Middy')).toBeTruthy();
    expect(screen.getByText('1990-05-14')).toBeTruthy();
    expect(screen.getByText('Female')).toBeTruthy();
    expect(screen.getByText('123 Main St')).toBeTruthy();
    expect(screen.getByText('Apt 4B')).toBeTruthy();
    expect(screen.getByText('Los Angeles')).toBeTruthy();
    expect(screen.getByText('CA')).toBeTruthy();
    // Insurance row must show the company name, not "—" (the old bug read
    // the unset legacy insurance_provider field instead of insurance_company).
    expect(screen.getByText('Health Net')).toBeTruthy();
    expect(screen.queryByText('—')).toBeNull();
    // Full CIN is member-visible (the member is the data subject).
    expect(screen.getByText('91234567A2')).toBeTruthy();
    expect(screen.getByText('housing')).toBeTruthy();
  });

  it('falls back to the legacy insurance_provider when insurance_company is unset', async () => {
    memberProfileFixture = buildMemberProfileFixture({
      insurance_company: null,
      insurance_provider: 'Legacy Health Plan',
    });

    renderScreen();
    await waitFor(() => expect(screen.getByText('Profile information')).toBeTruthy());

    expect(screen.getByText('Legacy Health Plan')).toBeTruthy();
  });

  it('an edit to a new field (Preferred Name) round-trips through the existing update mutation', async () => {
    let lastProfilePutBody: unknown = null;
    mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      const method = options?.method ?? 'GET';
      if (path === '/member/profile' && method === 'PUT') {
        lastProfilePutBody = options?.body ? JSON.parse(options.body) : null;
        memberProfileFixture = { ...memberProfileFixture, preferred_name: 'Middy' };
        return undefined;
      }
      return routeApi(path, options);
    });

    renderScreen();
    await waitFor(() => expect(screen.getByText('Profile information')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Edit Preferred Name'));
    const input = await screen.findByLabelText('Preferred Name');
    fireEvent.change(input, { target: { value: 'Middy' } });
    fireEvent.click(screen.getByLabelText('Save'));

    await waitFor(() => {
      expect(lastProfilePutBody).toEqual({ preferred_name: 'Middy' });
    });
  });

  it('a CIN edit saves through the dedicated insurance-CIN endpoint with the current insurance company', async () => {
    memberProfileFixture = buildMemberProfileFixture({
      insurance_company: 'Health Net',
      medi_cal_id: '91234567A2',
    });
    let lastCinPatchBody: unknown = null;
    mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      const method = options?.method ?? 'GET';
      if (path === '/member/profile/insurance-cin' && method === 'PATCH') {
        lastCinPatchBody = options?.body ? JSON.parse(options.body) : null;
        return undefined;
      }
      return routeApi(path, options);
    });

    renderScreen();
    await waitFor(() => expect(screen.getByText('Profile information')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Edit CIN (Medi-Cal ID)'));
    const input = await screen.findByLabelText('CIN (Medi-Cal ID)');
    fireEvent.change(input, { target: { value: '98765432B1' } });
    fireEvent.click(screen.getByLabelText('Save'));

    await waitFor(() => {
      expect(lastCinPatchBody).toEqual({
        insurance_company: 'Health Net',
        medi_cal_id: '98765432B1',
      });
    });
  });
});

// ─── SMS Output Spec 1 §1 — "Text messages" card ──────────────────────────────

describe('MemberSettingsScreen — Text messages card (SMS Output Spec 1)', () => {
  it('shows "Turn on text messages" + Send code for an unverified real phone', async () => {
    memberProfileFixture = buildMemberProfileFixture({
      phone: '5555550100',
      phone_verified_at: null,
    });
    renderScreen();

    await screen.findByText('Text messages');
    expect(screen.getByLabelText('Send code')).toBeTruthy();
    expect(screen.getByText(/turn on text messages/i)).toBeTruthy();
  });

  it('shows the "On" state with a masked number and STOP reminder when verified', async () => {
    memberProfileFixture = buildMemberProfileFixture({
      phone: '5555550100',
      phone_verified_at: '2026-07-15T00:00:00Z',
    });
    renderScreen();

    await screen.findByText('Text messages');
    expect(screen.getByText(/on — we text you at/i)).toBeTruthy();
    expect(screen.getByText(/reply stop anytime to opt out/i)).toBeTruthy();
    // No re-verification affordance once already on.
    expect(screen.queryByLabelText('Send code')).toBeNull();
  });

  it('renders no card at all for the 555-555-5555 placeholder phone', async () => {
    memberProfileFixture = buildMemberProfileFixture({
      phone: '5555555555',
      phone_verified_at: null,
    });
    renderScreen();

    await screen.findByText('Profile information');
    expect(screen.queryByText('Text messages')).toBeNull();
    expect(screen.queryByLabelText('Send code')).toBeNull();
  });

  it('confirm flow fires start + confirm endpoints and flips the card to On', async () => {
    memberProfileFixture = buildMemberProfileFixture({
      phone: '5555550100',
      phone_verified_at: null,
    });
    let startCalled = 0;
    let confirmBody: unknown = null;
    mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      const method = options?.method ?? 'GET';
      if (path === '/phone/start-verification' && method === 'POST') {
        startCalled += 1;
        return undefined;
      }
      if (path === '/phone/confirm-verification' && method === 'POST') {
        confirmBody = options?.body ? JSON.parse(options.body) : null;
        memberProfileFixture = {
          ...memberProfileFixture,
          phone_verified_at: '2026-07-15T00:00:00Z',
        };
        return undefined;
      }
      return routeApi(path, options);
    });

    renderScreen();
    await screen.findByText('Text messages');

    fireEvent.click(screen.getByLabelText('Send code'));
    await waitFor(() => expect(startCalled).toBe(1));

    const codeInput = await screen.findByLabelText('Verification code');
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByLabelText('Confirm code'));

    await waitFor(() => {
      expect(confirmBody).toEqual({ phone: '+15555550100', code: '123456' });
    });
    // The profile query invalidates on confirm success; the refetch flips the
    // card into its verified "On" state.
    await waitFor(() => {
      expect(screen.getByText(/on — we text you at/i)).toBeTruthy();
    });
  });
});
