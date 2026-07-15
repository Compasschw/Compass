/**
 * Component test for LoginScreen — forgot-password wiring regression + SMS 2FA
 * challenge routing (Spec 2).
 *
 * Scope:
 *   - The "Forgot password?" link routes to ResetPasswordScreen (not MagicLink).
 *   - When login() resolves a `two_fa_required` outcome, the screen navigates
 *     to TwoFactor with the pending-token params; a plain authenticated outcome
 *     does not.
 * Only `useAuth` and `useNavigation` are mocked; the rest renders for real.
 * Tier 2 — jsdom + react-native-web (see native/TESTING.md).
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same react-native-svg stub as RegisterScreen.test.tsx — LoginScreen pulls
// in the Google/Apple SVG icons, which never render in this test env (no
// EXPO_PUBLIC_* OAuth client IDs set), but the module is still imported.
vi.mock('react-native-svg', () => {
  const StubSvg = (props: Record<string, unknown>): React.ReactElement =>
    React.createElement('svg', props);
  const StubPath = (props: Record<string, unknown>): React.ReactElement =>
    React.createElement('path', props);
  return { __esModule: true, default: StubSvg, Path: StubPath };
});

const { mockLogin } = vi.hoisted(() => ({ mockLogin: vi.fn() }));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    login: mockLogin,
    signInWithGoogle: vi.fn(),
    signInWithApple: vi.fn(),
  }),
}));

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
}));

import { LoginScreen } from './LoginScreen';

beforeEach(() => {
  mockNavigate.mockClear();
  mockLogin.mockReset();
});

function signIn(): void {
  fireEvent.change(screen.getByPlaceholderText('maria@example.com'), {
    target: { value: 'casey@example.com' },
  });
  fireEvent.change(screen.getByPlaceholderText('••••••••'), {
    target: { value: 'pw' },
  });
  fireEvent.click(screen.getByLabelText('Sign in'));
}

describe('LoginScreen — forgot-password wiring', () => {
  it('navigates to ResetPassword (not MagicLink) when "Forgot password?" is tapped', () => {
    render(<LoginScreen />);

    fireEvent.click(screen.getByText('Forgot password?'));

    expect(mockNavigate).toHaveBeenCalledWith('ResetPassword');
    expect(mockNavigate).not.toHaveBeenCalledWith('MagicLink');
  });

  it('exposes an accessible label describing the reset action', () => {
    render(<LoginScreen />);
    expect(
      screen.getByLabelText('Forgot password? Reset your password'),
    ).toBeTruthy();
  });
});

describe('LoginScreen — SMS 2FA challenge routing (Spec 2)', () => {
  it('navigates to TwoFactor with the pending-token params when a challenge is returned', async () => {
    mockLogin.mockResolvedValue({
      status: 'two_fa_required',
      pendingToken: 'pending-xyz',
      phoneLast4: '4821',
      phoneVerificationRequired: false,
    });
    render(<LoginScreen />);
    signIn();

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('TwoFactor', {
        pendingToken: 'pending-xyz',
        phoneLast4: '4821',
        phoneVerificationRequired: false,
      }),
    );
  });

  it('does NOT navigate to TwoFactor on a plain authenticated result', async () => {
    mockLogin.mockResolvedValue({ status: 'authenticated' });
    render(<LoginScreen />);
    signIn();

    await waitFor(() => expect(mockLogin).toHaveBeenCalled());
    expect(mockNavigate).not.toHaveBeenCalledWith('TwoFactor', expect.anything());
  });
});
