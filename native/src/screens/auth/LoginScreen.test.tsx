/**
 * Component test for LoginScreen — forgot-password wiring regression.
 *
 * Scope: the "Forgot password?" link must route to the ResetPasswordScreen
 * (forgot-password reset flow), not MagicLinkScreen (passwordless sign-in —
 * a separate, untouched flow). Only `useAuth` and `useNavigation` are
 * mocked; the rest of the screen renders for real.
 * Tier 2 — jsdom + react-native-web (see native/TESTING.md).
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    login: vi.fn(),
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
});

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
