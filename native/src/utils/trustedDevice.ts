/**
 * Trusted-device token storage (SMS 2FA — Spec 2, Task 8).
 *
 * After a CHW (or opted-in member) completes an SMS 2FA challenge with
 * "Remember this device" checked, the backend returns an opaque raw device
 * token whose SHA-256 it stored in `trusted_devices` with a 30-day expiry.
 * We persist the raw token here and replay it on the NEXT login as the
 * `X-Device-Token` header — a matching, unexpired hash lets the backend skip
 * the challenge for 30 days (Spec 2 §"Trusted devices").
 *
 * Storage: AsyncStorage under the fixed key `compass:trustedDeviceToken`.
 * AsyncStorage is backed by Keychain-free localStorage on web (react-native-web
 * / the package's web build) and by the platform key-value store on native, so
 * this one call site works on every platform the app targets — the same
 * fallback the rest of the app's non-secret persistence uses.
 *
 * The token is device-trust, not an access credential: it authorizes nothing
 * on its own (the backend still hashes + user-matches it and only ever uses it
 * to BYPASS a challenge, never to authenticate), so AsyncStorage (not
 * expo-secure-store) is the deliberate, spec'd home for it.
 *
 * Cleared on "logout everywhere" (server-side device revocation, surfaced to
 * the client as a forced session expiry) and on account deletion — see
 * AuthContext. A normal single-device sign-out intentionally KEEPS the token
 * so signing back in on the same device does not re-challenge within 30 days.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** Fixed AsyncStorage key for the persisted raw device-trust token. */
export const TRUSTED_DEVICE_TOKEN_KEY = 'compass:trustedDeviceToken';

/**
 * Read the stored raw device-trust token, or `null` when none is persisted
 * (or storage is unavailable / corrupted — treated as "no trusted device",
 * which fails safe by triggering a full challenge on next login).
 */
export async function getTrustedDeviceToken(): Promise<string | null> {
  try {
    const value = await AsyncStorage.getItem(TRUSTED_DEVICE_TOKEN_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Persist the raw device-trust token returned by `POST /auth/2fa/verify` when
 * the user opted to remember the device. A blank/empty token is treated as a
 * clear so we never store a meaningless value.
 */
export async function setTrustedDeviceToken(token: string): Promise<void> {
  if (!token) {
    await clearTrustedDeviceToken();
    return;
  }
  try {
    await AsyncStorage.setItem(TRUSTED_DEVICE_TOKEN_KEY, token);
  } catch {
    // Non-fatal: failing to persist only means the user is challenged again
    // next login — never a hard failure of the sign-in itself.
  }
}

/**
 * Remove any persisted device-trust token. Called on "logout everywhere" /
 * forced session expiry and account deletion so a revoked device does not keep
 * replaying a now-useless token. Best-effort; a storage error is swallowed
 * because the in-memory sign-out has already taken effect.
 */
export async function clearTrustedDeviceToken(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRUSTED_DEVICE_TOKEN_KEY);
  } catch {
    // Ignore — see docstring.
  }
}
