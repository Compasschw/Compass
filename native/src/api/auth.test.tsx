/**
 * Unit test for registerUser — the /auth/register wire builder.
 *
 * Guards the member-signup consent contract at the API boundary: when a
 * `consent` object is passed, the request body carries the two snake_case
 * booleans (`terms_accepted`, `communications_consent`) the backend requires.
 * Only the network boundary (`./client`) is mocked.
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

import { api } from './client';
import { registerUser } from './auth';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

function lastBody(): Record<string, unknown> {
  const [, options] = mockedApi.mock.calls[0];
  return JSON.parse((options as { body: string }).body);
}

beforeEach(() => {
  mockedApi.mockClear();
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
