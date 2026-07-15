/**
 * Unit tests for the trusted-device token store (SMS 2FA — Spec 2, Task 8).
 *
 * Verifies get/set/clear round-trip against a mocked AsyncStorage under the
 * fixed `compass:trustedDeviceToken` key, plus the fail-safe defaults (missing
 * → null; blank set → clear). `.test.tsx` so it runs under jsdom, matching the
 * app's AsyncStorage web resolution. Only the storage boundary is mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => store.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(async () => {
        store.clear();
      }),
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  TRUSTED_DEVICE_TOKEN_KEY,
  getTrustedDeviceToken,
  setTrustedDeviceToken,
  clearTrustedDeviceToken,
} from './trustedDevice';

beforeEach(async () => {
  await AsyncStorage.clear();
  vi.clearAllMocks();
});

describe('trustedDevice store', () => {
  it('uses the spec-mandated storage key', () => {
    expect(TRUSTED_DEVICE_TOKEN_KEY).toBe('compass:trustedDeviceToken');
  });

  it('returns null when no token is stored', async () => {
    await expect(getTrustedDeviceToken()).resolves.toBeNull();
  });

  it('round-trips a set token', async () => {
    await setTrustedDeviceToken('raw-device-token');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      TRUSTED_DEVICE_TOKEN_KEY,
      'raw-device-token',
    );
    await expect(getTrustedDeviceToken()).resolves.toBe('raw-device-token');
  });

  it('clears the token (logout-everywhere / account deletion path)', async () => {
    await setTrustedDeviceToken('raw-device-token');
    await clearTrustedDeviceToken();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(TRUSTED_DEVICE_TOKEN_KEY);
    await expect(getTrustedDeviceToken()).resolves.toBeNull();
  });

  it('treats a blank set as a clear (never stores an empty token)', async () => {
    await setTrustedDeviceToken('raw-device-token');
    await setTrustedDeviceToken('');
    await expect(getTrustedDeviceToken()).resolves.toBeNull();
  });
});
