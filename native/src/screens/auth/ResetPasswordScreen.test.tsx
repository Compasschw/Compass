/**
 * Component tests for ResetPasswordScreen — forgot-password reset flow.
 *
 * Scope:
 *   - Request mode: posts the email to /auth/password-reset/request and shows
 *     the neutral "check your email" confirmation. The confirmation copy must
 *     never leak whether the account exists (the backend always returns 202).
 *   - Confirm mode (token present): client-side validation (short password,
 *     mismatch) blocks submit with an inline error and fires no network call;
 *     a valid submit POSTs `{token, new_password}`; success renders a panel
 *     with a button to Login; a 401 from the confirm endpoint shows the
 *     expired/used error with a "request a new one" affordance.
 *   - Loading states disable the submit button to prevent double-submit.
 *
 * Only the network boundary (`../../api/client`) is mocked — navigation is
 * supplied directly via mock props (this screen takes `route`/`navigation`
 * as props, not via the `useNavigation`/`useRoute` hooks), matching how
 * MagicLinkScreen is wired. Tier 2 — jsdom + react-native-web (see
 * native/TESTING.md).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});

import { api, ApiError } from '../../api/client';
import { ResetPasswordScreen } from './ResetPasswordScreen';
import type { AuthStackParamList } from '../../navigation/AppNavigator';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

type Props = NativeStackScreenProps<AuthStackParamList, 'ResetPassword'>;

function buildNavigation(): Props['navigation'] {
  return {
    navigate: vi.fn(),
    goBack: vi.fn(),
    canGoBack: vi.fn(() => true),
    setParams: vi.fn(),
    // Unused by the screen but present on the real navigation object type.
  } as unknown as Props['navigation'];
}

function renderScreen(token?: string) {
  const navigation = buildNavigation();
  const route = { key: 'ResetPassword', name: 'ResetPassword', params: token ? { token } : undefined } as Props['route'];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ResetPasswordScreen route={route} navigation={navigation} />
    </QueryClientProvider>,
  );
  return { ...utils, navigation };
}

beforeEach(() => {
  mockedApi.mockReset();
});

// ─── Request mode ─────────────────────────────────────────────────────────────

describe('ResetPasswordScreen — request mode', () => {
  it('posts the email to /auth/password-reset/request and shows the neutral confirmation', async () => {
    mockedApi.mockResolvedValueOnce(undefined);
    renderScreen();

    expect(screen.getByText('Reset your password')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'maria@example.com' },
    });
    fireEvent.click(screen.getByLabelText('Send reset link'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        '/auth/password-reset/request',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ email: 'maria@example.com' }),
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Check your email')).toBeTruthy();
    });
    // Neutral copy — must not imply the account definitely exists.
    expect(screen.getByText(/if an account exists/i)).toBeTruthy();
    expect(screen.getByText(/expires in 30 minutes/i)).toBeTruthy();
    expect(screen.queryByText(/no account/i)).toBeNull();
  });

  it('shows a "Back to sign in" link in request mode', () => {
    renderScreen();
    expect(screen.getByLabelText('Back to sign in')).toBeTruthy();
  });

  it('navigates to Login when "Back to sign in" is tapped', () => {
    const { navigation } = renderScreen();
    fireEvent.click(screen.getByLabelText('Back to sign in'));
    expect(navigation.navigate).toHaveBeenCalledWith('Login');
  });

  it('disables the submit button while the request is in flight (no double-submit)', async () => {
    let resolveRequest: () => void = () => {};
    mockedApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = () => resolve(undefined);
        }),
    );
    renderScreen();

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'maria@example.com' },
    });
    const submit = screen.getByLabelText('Send reset link');
    fireEvent.click(submit);

    await waitFor(() => {
      expect(submit.getAttribute('aria-disabled')).toBe('true');
    });
    expect(mockedApi).toHaveBeenCalledTimes(1);

    resolveRequest();
    await waitFor(() => {
      expect(screen.getByText('Check your email')).toBeTruthy();
    });
  });
});

// ─── Confirm mode: client-side validation ────────────────────────────────────

describe('ResetPasswordScreen — confirm mode validation', () => {
  it('shows the heading "Choose a new password" when a token is present', () => {
    renderScreen('reset-token-abc');
    expect(screen.getByText('Choose a new password')).toBeTruthy();
  });

  // The short-password case is covered in more detail below (QA batch item
  // 1 — inline complexity feedback names every unmet rule, not just length).

  it('blocks submit with an inline mismatch error, firing no POST', () => {
    renderScreen('reset-token-abc');

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'LongEnoughPass1!' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'DifferentPass1!' },
    });
    fireEvent.click(screen.getByLabelText('Reset password'));

    expect(screen.getByText(/do not match/i)).toBeTruthy();
    expect(mockedApi).not.toHaveBeenCalled();
  });
});

// ─── Confirm mode: inline complexity feedback (QA batch item 1, same bug ────
// class as RegisterScreen — shared `validatePasswordComplexity` util) ───────

describe('ResetPasswordScreen — inline password-policy feedback', () => {
  it('names every unmet rule for a weak password (short, no uppercase, no special character), firing no POST', () => {
    renderScreen('reset-token-abc');

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'short1' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'short1' },
    });
    fireEvent.click(screen.getByLabelText('Reset password'));

    expect(
      screen.getByText(
        'Password needs at least 8 characters, an uppercase letter and a special character.',
      ),
    ).toBeTruthy();
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('names only the special-character rule when every other requirement is met, firing no POST', () => {
    renderScreen('reset-token-abc');

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'Zoro1234' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'Zoro1234' },
    });
    fireEvent.click(screen.getByLabelText('Reset password'));

    expect(screen.getByText('Password needs a special character.')).toBeTruthy();
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('allows submit once the password satisfies the full policy', async () => {
    mockedApi.mockResolvedValueOnce({ ok: true });
    renderScreen('reset-token-abc');

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'Zoro123!' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'Zoro123!' },
    });
    fireEvent.click(screen.getByLabelText('Reset password'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        '/auth/password-reset/confirm',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ token: 'reset-token-abc', new_password: 'Zoro123!' }),
        }),
      );
    });
  });
});

// ─── Confirm mode: successful submit ─────────────────────────────────────────

describe('ResetPasswordScreen — confirm mode success', () => {
  it('posts {token, new_password} on valid submit and renders a success panel with a Login button', async () => {
    mockedApi.mockResolvedValueOnce({ ok: true });
    const { navigation } = renderScreen('reset-token-abc');

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'brandNewPass123!' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'brandNewPass123!' },
    });
    fireEvent.click(screen.getByLabelText('Reset password'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        '/auth/password-reset/confirm',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ token: 'reset-token-abc', new_password: 'brandNewPass123!' }),
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Password updated')).toBeTruthy();
    });
    expect(screen.getByText(/sign in with your new password/i)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Go to sign in'));
    expect(navigation.navigate).toHaveBeenCalledWith('Login');
  });

  it('disables the submit button while the confirm request is in flight (no double-submit)', async () => {
    let resolveConfirm: () => void = () => {};
    mockedApi.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConfirm = () => resolve({ ok: true });
        }),
    );
    renderScreen('reset-token-abc');

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'brandNewPass123!' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'brandNewPass123!' },
    });
    const submit = screen.getByLabelText('Reset password');
    fireEvent.click(submit);

    await waitFor(() => {
      expect(submit.getAttribute('aria-disabled')).toBe('true');
    });
    expect(mockedApi).toHaveBeenCalledTimes(1);

    resolveConfirm();
    await waitFor(() => {
      expect(screen.getByText('Password updated')).toBeTruthy();
    });
  });
});

// ─── Confirm mode: expired/used token (401) ──────────────────────────────────

describe('ResetPasswordScreen — expired or already-used token', () => {
  it('shows the expired/used error with a request-again affordance on 401, and clears the token on retry', async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(401, 'Invalid or expired token.'));
    const { navigation } = renderScreen('stale-token');

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'brandNewPass123!' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'brandNewPass123!' },
    });
    fireEvent.click(screen.getByLabelText('Reset password'));

    await waitFor(() => {
      expect(
        screen.getByText(/this link has expired or was already used/i),
      ).toBeTruthy();
    });

    const retryButton = screen.getByLabelText('Request a new reset link');
    expect(retryButton).toBeTruthy();
    fireEvent.click(retryButton);

    expect(navigation.setParams).toHaveBeenCalledWith({ token: undefined });
    // Back in request mode.
    await waitFor(() => {
      expect(screen.getByText('Reset your password')).toBeTruthy();
    });
  });

  it('shows an inline error (not a crash) on a 422 from the confirm endpoint', async () => {
    mockedApi.mockRejectedValueOnce(new ApiError(422, 'Password too short.'));
    renderScreen('reset-token-abc');

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'LongEnoughPass1!' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'LongEnoughPass1!' },
    });
    fireEvent.click(screen.getByLabelText('Reset password'));

    await waitFor(() => {
      expect(screen.getByText('Password must be at least 8 characters.')).toBeTruthy();
    });
  });

  it('shows an inline error (not a crash) on a network failure from the confirm endpoint', async () => {
    mockedApi.mockRejectedValueOnce(new Error('Network request failed'));
    renderScreen('reset-token-abc');

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'LongEnoughPass1!' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'LongEnoughPass1!' },
    });
    fireEvent.click(screen.getByLabelText('Reset password'));

    await waitFor(() => {
      expect(screen.getByText(/could not reset your password/i)).toBeTruthy();
    });
  });
});
