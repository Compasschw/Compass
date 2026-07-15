/**
 * Unit tests for the /auth wire builders (registerUser + loginUser).
 *
 * registerUser: guards the member-signup consent contract at the API boundary.
 * loginUser (SMS 2FA — Spec 2): guards the trusted-device `X-Device-Token`
 * header behaviour and the 2FA-challenge branch (no tokens persisted). Only the
 * network boundary (`./client`) and the device-token store (`../utils/
 * trustedDevice`) are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({
  api: vi.fn(async () => ({
    access_token: 'a',
    refresh_token: 'r',
    role: 'member',
    name: 'Jordan Rivera',
  })),
  setTokens: vi.fn(async () => undefined),
}));

const { mockGetTrustedDeviceToken } = vi.hoisted(() => ({
  mockGetTrustedDeviceToken: vi.fn<() => Promise<string | null>>(),
}));
vi.mock('../utils/trustedDevice', () => ({
  getTrustedDeviceToken: mockGetTrustedDeviceToken,
}));

import { api, setTokens } from './client';
import { loginUser, registerUser } from './auth';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;
const mockedSetTokens = setTokens as unknown as ReturnType<typeof vi.fn>;

function lastBody(): Record<string, unknown> {
  const [, options] = mockedApi.mock.calls[0];
  return JSON.parse((options as { body: string }).body);
}

function lastOptions(): { headers?: Record<string, string> } {
  const [, options] = mockedApi.mock.calls[0];
  return options as { headers?: Record<string, string> };
}

beforeEach(() => {
  mockedApi.mockClear();
  mockedSetTokens.mockClear();
  mockGetTrustedDeviceToken.mockReset();
  mockGetTrustedDeviceToken.mockResolvedValue(null);
});

describe('registerUser — signup consent', () => {
  it('sends both consent booleans when consent is provided', async () => {
    await registerUser(
      'jordan@example.com',
      'temp-pass-1234',
      'Jordan Rivera',
      'member',
      undefined,
      { date_of_birth: '1993-01-05' },
      { termsAccepted: true, communicationsConsent: true },
    );
    const body = lastBody();
    expect(body.terms_accepted).toBe(true);
    expect(body.communications_consent).toBe(true);
    expect(body.role).toBe('member');
  });

  it('omits consent keys for a CHW signup (no consent object)', async () => {
    await registerUser('chw@example.com', 'temp-pass-1234', 'Casey Worker', 'chw');
    const body = lastBody();
    expect(body).not.toHaveProperty('terms_accepted');
    expect(body).not.toHaveProperty('communications_consent');
  });
});

describe('loginUser — trusted-device header + 2FA challenge (Spec 2)', () => {
  it('sends the X-Device-Token header when a device token is stored', async () => {
    mockGetTrustedDeviceToken.mockResolvedValue('device-token-abc');
    await loginUser('jordan@example.com', 'pw');
    expect(lastOptions().headers).toEqual({ 'X-Device-Token': 'device-token-abc' });
  });

  it('sends NO device header when nothing is stored', async () => {
    mockGetTrustedDeviceToken.mockResolvedValue(null);
    await loginUser('jordan@example.com', 'pw');
    // No headers object at all — an absent header must never be an empty string.
    expect(lastOptions().headers).toBeUndefined();
  });

  it('returns the challenge and does NOT persist tokens when 2FA is required', async () => {
    mockedApi.mockResolvedValueOnce({
      two_fa_required: true,
      pending_token: 'pending-xyz',
      phone_verification_required: false,
      phone_last4: '4821',
    });
    const result = await loginUser('cw@example.com', 'pw');
    expect(result).toMatchObject({ two_fa_required: true, pending_token: 'pending-xyz' });
    expect(mockedSetTokens).not.toHaveBeenCalled();
  });

  it('persists tokens on a normal (non-challenge) login response', async () => {
    const result = await loginUser('jordan@example.com', 'pw');
    expect(result).toMatchObject({ role: 'member', name: 'Jordan Rivera' });
    expect(mockedSetTokens).toHaveBeenCalledWith('a', 'r');
  });
});
