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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
