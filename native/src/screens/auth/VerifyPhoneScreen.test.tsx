/**
 * Component tests for VerifyPhoneScreen — post-signup "Confirm your phone"
 * step (SMS Output Spec 1 §1).
 *
 * Scope:
 *   - Renders the code input and all three actions (Confirm / Resend / skip).
 *   - Happy path: a 6-digit code POSTs /phone/confirm-verification with
 *     {phone, code} and then proceeds (navigation.goBack dismisses the step).
 *   - A 4xx from confirm (expired/wrong code) shows an inline error and does
 *     NOT navigate.
 *   - "Verify later" proceeds without any confirm call (fully skippable).
 *   - "Resend code" POSTs /phone/start-verification.
 *
 * Only the network boundary (`../../api/client`) is mocked — the two
 * verification hooks run for real against the routed `api()` mock. Navigation
 * is supplied via mock props (this screen takes route/navigation as props).
 * Tier 2 — jsdom + react-native-web (see native/TESTING.md).
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
import { VerifyPhoneScreen } from './VerifyPhoneScreen';
import type { AuthStackParamList } from '../../navigation/AppNavigator';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

type Props = NativeStackScreenProps<AuthStackParamList, 'VerifyPhone'>;

const PHONE = '+13105550188';

function buildNavigation(): Props['navigation'] {
  return {
    navigate: vi.fn(),
    goBack: vi.fn(),
    canGoBack: vi.fn(() => true),
    setParams: vi.fn(),
  } as unknown as Props['navigation'];
}

function renderScreen(phone: string = PHONE) {
  const navigation = buildNavigation();
  const route = {
    key: 'VerifyPhone',
    name: 'VerifyPhone',
    params: { phone },
  } as Props['route'];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <VerifyPhoneScreen route={route} navigation={navigation} />
    </QueryClientProvider>,
  );
  return { ...utils, navigation };
}

beforeEach(() => {
  mockedApi.mockReset();
});

describe('VerifyPhoneScreen', () => {
  it('renders the code input and Confirm / Resend / Verify-later actions', () => {
    renderScreen();
    expect(screen.getByText('Confirm your phone')).toBeTruthy();
    expect(screen.getByLabelText('Verification code')).toBeTruthy();
    expect(screen.getByLabelText('Confirm')).toBeTruthy();
    expect(screen.getByLabelText('Resend code')).toBeTruthy();
    expect(screen.getByLabelText('Skip verification')).toBeTruthy();
    // The phone the code was texted to is shown.
    expect(screen.getByText(PHONE)).toBeTruthy();
  });

  it('does not auto-send a code on mount (RegisterScreen already sent the first one)', () => {
    renderScreen();
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('posts {phone, code} to /phone/confirm-verification and proceeds on success', async () => {
    mockedApi.mockResolvedValueOnce(undefined);
    const { navigation } = renderScreen();

    fireEvent.change(screen.getByLabelText('Verification code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByLabelText('Confirm'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        '/phone/confirm-verification',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ phone: PHONE, code: '123456' }),
        }),
      );
    });
    await waitFor(() => {
      expect(navigation.goBack).toHaveBeenCalled();
    });
  });

  it('shows an inline error and does not navigate when confirm returns 4xx', async () => {
    mockedApi.mockRejectedValueOnce(
      new ApiError(410, 'No active verification code for this number.'),
    );
    const { navigation } = renderScreen();

    fireEvent.change(screen.getByLabelText('Verification code'), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByLabelText('Confirm'));

    await waitFor(() => {
      expect(screen.getByText(/no active verification code/i)).toBeTruthy();
    });
    expect(navigation.goBack).not.toHaveBeenCalled();
  });

  it('validates the code length client-side before calling confirm', () => {
    renderScreen();
    fireEvent.change(screen.getByLabelText('Verification code'), {
      target: { value: '12' },
    });
    fireEvent.click(screen.getByLabelText('Confirm'));
    expect(screen.getByText(/enter the 6-digit code we texted you/i)).toBeTruthy();
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('"Verify later" proceeds without any confirm call', () => {
    const { navigation } = renderScreen();
    fireEvent.click(screen.getByLabelText('Skip verification'));
    expect(navigation.goBack).toHaveBeenCalled();
    expect(mockedApi).not.toHaveBeenCalledWith(
      '/phone/confirm-verification',
      expect.anything(),
    );
  });

  it('"Resend code" posts to /phone/start-verification', async () => {
    mockedApi.mockResolvedValueOnce(undefined);
    renderScreen();

    fireEvent.click(screen.getByLabelText('Resend code'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        '/phone/start-verification',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ phone: PHONE }),
        }),
      );
    });
  });
});
