/**
 * Component tests for TwoFactorScreen — SMS 2FA challenge (Spec 2, Task 7).
 *
 * Scope:
 *   - Code variant auto-sends the first code on mount and renders code entry +
 *     a "Remember this device" checkbox that defaults CHECKED.
 *   - Happy path: verify POSTs /auth/2fa/verify, persists the returned device
 *     token (when remember is checked), and completes sign-in via
 *     signInWithTokens.
 *   - Remember unchecked → remember_device:false and NO device token stored.
 *   - Wrong code (422) shows an inline error and does not sign in.
 *   - Expired pending token (401) routes back to Login.
 *   - Enrollment variant renders phone entry, does NOT auto-send, and sends the
 *     code to the entered (E.164-normalised) number before showing code entry.
 *   - Resend is throttled (30s cooldown) after a send.
 *
 * Only the network boundary (`../../api/client`), the device-token store, and
 * AuthContext are mocked; the screen's own state machine runs for real.
 * Navigation is supplied via mock props. Tier 2 — jsdom + react-native-web.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});

const { mockSetTrustedDeviceToken } = vi.hoisted(() => ({
  mockSetTrustedDeviceToken: vi.fn(async () => undefined),
}));
vi.mock('../../utils/trustedDevice', () => ({
  setTrustedDeviceToken: mockSetTrustedDeviceToken,
  getTrustedDeviceToken: vi.fn(async () => null),
  clearTrustedDeviceToken: vi.fn(async () => undefined),
}));

const { mockSignInWithTokens } = vi.hoisted(() => ({
  mockSignInWithTokens: vi.fn(async () => undefined),
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ signInWithTokens: mockSignInWithTokens }),
}));

import { api, ApiError } from '../../api/client';
import { TwoFactorScreen } from './TwoFactorScreen';
import type { AuthStackParamList } from '../../navigation/AppNavigator';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

type Props = NativeStackScreenProps<AuthStackParamList, 'TwoFactor'>;

function buildNavigation(): Props['navigation'] {
  return {
    navigate: vi.fn(),
    goBack: vi.fn(),
    canGoBack: vi.fn(() => true),
    setParams: vi.fn(),
  } as unknown as Props['navigation'];
}

function renderScreen(
  params: AuthStackParamList['TwoFactor'] = {
    pendingToken: 'pending-abc',
    phoneLast4: '4821',
    phoneVerificationRequired: false,
  },
) {
  const navigation = buildNavigation();
  const route = { key: 'TwoFactor', name: 'TwoFactor', params } as Props['route'];
  const utils = render(<TwoFactorScreen route={route} navigation={navigation} />);
  return { ...utils, navigation };
}

/** Parse the JSON body of the api() call made to `path`. */
function bodyForPath(path: string): Record<string, unknown> {
  const call = mockedApi.mock.calls.find(([p]) => p === path);
  if (!call) throw new Error(`no api() call to ${path}`);
  return JSON.parse((call[1] as { body: string }).body);
}

beforeEach(() => {
  mockedApi.mockReset();
  mockSetTrustedDeviceToken.mockClear();
  mockSignInWithTokens.mockClear();
});

describe('TwoFactorScreen — code variant', () => {
  it('auto-sends the first code on mount and renders code entry + the remember control', async () => {
    mockedApi.mockResolvedValue({ sent: true, phone_last4: '4821' });
    renderScreen();

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        '/auth/2fa/send-code',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(bodyForPath('/auth/2fa/send-code')).toEqual({ pending_token: 'pending-abc' });

    expect(screen.getByLabelText('Verification code')).toBeTruthy();
    // The "Remember this device" control renders; its DEFAULT-CHECKED state is
    // proven behaviourally by the happy-path test below, which sends
    // remember_device: true without any interaction with this control.
    expect(screen.getByLabelText('Remember this device for 30 days')).toBeTruthy();
  });

  it('verifies, stores the returned device token, and completes sign-in (remember checked)', async () => {
    mockedApi
      .mockResolvedValueOnce({ sent: true, phone_last4: '4821' }) // mount send
      .mockResolvedValueOnce({
        access_token: 'AT',
        refresh_token: 'RT',
        role: 'chw',
        name: 'Casey Worker',
        device_token: 'DEVTOK',
      }); // verify
    renderScreen();

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith('/auth/2fa/send-code', expect.anything()),
    );

    fireEvent.change(screen.getByLabelText('Verification code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByLabelText('Verify'));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith('/auth/2fa/verify', expect.anything()),
    );
    expect(bodyForPath('/auth/2fa/verify')).toEqual({
      pending_token: 'pending-abc',
      code: '123456',
      remember_device: true,
    });
    await waitFor(() =>
      expect(mockSetTrustedDeviceToken).toHaveBeenCalledWith('DEVTOK'),
    );
    expect(mockSignInWithTokens).toHaveBeenCalledWith({
      accessToken: 'AT',
      refreshToken: 'RT',
      role: 'chw',
      name: 'Casey Worker',
    });
  });

  it('sends remember_device:false and stores no device token when unchecked', async () => {
    mockedApi
      .mockResolvedValueOnce({ sent: true, phone_last4: '4821' })
      .mockResolvedValueOnce({
        access_token: 'AT',
        refresh_token: 'RT',
        role: 'chw',
        name: 'Casey Worker',
      }); // no device_token when remember_device is false
    renderScreen();

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith('/auth/2fa/send-code', expect.anything()),
    );

    fireEvent.click(screen.getByLabelText('Remember this device for 30 days')); // uncheck
    fireEvent.change(screen.getByLabelText('Verification code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByLabelText('Verify'));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith('/auth/2fa/verify', expect.anything()),
    );
    expect(bodyForPath('/auth/2fa/verify').remember_device).toBe(false);
    await waitFor(() => expect(mockSignInWithTokens).toHaveBeenCalled());
    expect(mockSetTrustedDeviceToken).not.toHaveBeenCalled();
  });

  it('shows an inline error and does not sign in when the code is wrong (422)', async () => {
    mockedApi
      .mockResolvedValueOnce({ sent: true, phone_last4: '4821' })
      .mockRejectedValueOnce(new ApiError(422, 'That code is not correct.'));
    renderScreen();

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith('/auth/2fa/send-code', expect.anything()),
    );

    fireEvent.change(screen.getByLabelText('Verification code'), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByLabelText('Verify'));

    await waitFor(() => expect(screen.getByText(/that code is not correct/i)).toBeTruthy());
    expect(mockSignInWithTokens).not.toHaveBeenCalled();
  });

  it('routes back to Login when the pending token is expired (401)', async () => {
    mockedApi
      .mockResolvedValueOnce({ sent: true, phone_last4: '4821' })
      .mockRejectedValueOnce(new ApiError(401, 'Pending token expired.'));
    const { navigation } = renderScreen();

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith('/auth/2fa/send-code', expect.anything()),
    );

    fireEvent.change(screen.getByLabelText('Verification code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByLabelText('Verify'));

    await waitFor(() => expect(navigation.navigate).toHaveBeenCalledWith('Login'));
    expect(mockSignInWithTokens).not.toHaveBeenCalled();
  });

  it('disables Resend after a send (30s cooldown engaged)', async () => {
    mockedApi.mockResolvedValue({ sent: true, phone_last4: '4821' });
    renderScreen();

    await waitFor(() =>
      expect(screen.getByText('Code sent — check your messages')).toBeTruthy(),
    );
    expect(
      screen.getByLabelText('Resend code').getAttribute('aria-disabled'),
    ).toBe('true');
  });
});

describe('TwoFactorScreen — enrollment (phone) variant', () => {
  const enrollParams: AuthStackParamList['TwoFactor'] = {
    pendingToken: 'pending-enroll',
    phoneLast4: null,
    phoneVerificationRequired: true,
  };

  it('renders phone entry and does NOT auto-send on mount', () => {
    renderScreen(enrollParams);
    expect(screen.getByLabelText('Mobile phone number')).toBeTruthy();
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('sends the code to the entered E.164 number, then shows code entry', async () => {
    mockedApi.mockResolvedValue({ sent: true, phone_last4: '0188' });
    renderScreen(enrollParams);

    fireEvent.change(screen.getByLabelText('Mobile phone number'), {
      target: { value: '(310) 555-0188' },
    });
    fireEvent.click(screen.getByLabelText('Send code'));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith('/auth/2fa/send-code', expect.anything()),
    );
    expect(bodyForPath('/auth/2fa/send-code')).toEqual({
      pending_token: 'pending-enroll',
      phone: '+13105550188',
    });
    await waitFor(() => expect(screen.getByLabelText('Verification code')).toBeTruthy());
  });
});
