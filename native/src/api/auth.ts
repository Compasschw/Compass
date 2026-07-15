/**
 * Auth API endpoints.
 *
 * login, register, logout, OAuth sign-in, and member onboarding against
 * /auth/* routes.  Tokens are persisted by the caller via setTokens().
 */

import { api, setTokens } from './client';
import { getTrustedDeviceToken } from '../utils/trustedDevice';

// ─── Response types ───────────────────────────────────────────────────────────

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  /** 'chw' | 'member' */
  role: string;
  name: string;
}

/**
 * SMS 2FA challenge (Spec 2). Returned by `POST /auth/login` — INSTEAD OF an
 * `AuthResponse` — when the user requires 2FA (a CHW while the flag is on, or a
 * member who opted in with a verified, non-sentinel phone) and no valid
 * trusted-device header accompanied the request. Deliberately carries NO
 * access/refresh tokens: the caller must complete `/auth/2fa/verify` first.
 */
export interface TwoFactorChallenge {
  two_fa_required: true;
  /** Single-purpose JWT accepted only by the two `/auth/2fa/*` endpoints. */
  pending_token: string;
  /** True on enrollment/recovery — the user must supply a phone before a code
   *  can be sent (no verified number on file yet). */
  phone_verification_required: boolean;
  /** Last 4 digits of the verified phone the code will be texted to, or null
   *  when enrollment is required. */
  phone_last4: string | null;
}

/** Discriminated result of a login attempt: real session OR a 2FA challenge. */
export type LoginResult = AuthResponse | TwoFactorChallenge;

/** Narrow a {@link LoginResult} to the 2FA-challenge branch. */
export function isTwoFactorChallenge(
  result: LoginResult,
): result is TwoFactorChallenge {
  return (result as TwoFactorChallenge).two_fa_required === true;
}

/** Response from `POST /auth/2fa/send-code`. */
export interface SendCodeResponse {
  sent: boolean;
  /** Last 4 of the number the code was texted to (echoed for display). */
  phone_last4: string;
}

/**
 * Response from `POST /auth/2fa/verify`. Identical to a normal login response,
 * plus `device_token` — the raw device-trust token, present only when the
 * caller passed `remember_device: true`.
 */
export interface VerifyTwoFactorResponse extends AuthResponse {
  device_token?: string;
}

/**
 * Response from POST /auth/oauth/google and POST /auth/oauth/apple.
 * Extends AuthResponse with the `needs_onboarding` flag that is true for
 * brand-new social sign-ups who still need to complete their member profile.
 */
export interface OAuthResponse extends AuthResponse {
  /**
   * True when the account was just created via OAuth and the member profile
   * fields required by Pear Suite (DOB, gender, insurance, etc.) are still
   * absent.  The UI should gate on this flag and show CompleteProfileScreen
   * before allowing access to the member tabs.
   */
  needs_onboarding: boolean;
}

/**
 * Payload for POST /auth/complete-member-onboarding.
 * Mirrors the Pear Suite-required fields that aren't collected during
 * OAuth sign-up.
 */
export interface CompleteMemberOnboardingPayload {
  /** ISO 8601 date (YYYY-MM-DD). */
  date_of_birth: string;
  /** Pear sex enum. */
  gender: 'Male' | 'Female' | 'Other';
  /** Curated 6-carrier dropdown display label. */
  insurance_company: string;
  /** Medi-Cal CIN — PHI, encrypted at rest on the backend. */
  medi_cal_id: string;
  /** 5-digit ZIP code. */
  zip_code: string;
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

/**
 * Authenticate with email and password.
 *
 * Sends the stored trusted-device token (Spec 2) as `X-Device-Token` when one
 * is present, so a remembered device can bypass the SMS 2FA challenge for 30
 * days. Returns EITHER a normal {@link AuthResponse} (tokens persisted to
 * secure storage as a side-effect, exactly as before) OR a
 * {@link TwoFactorChallenge} — in the challenge case NO tokens are issued or
 * stored, and the caller must drive the `/auth/2fa/*` flow. Use
 * {@link isTwoFactorChallenge} to discriminate.
 */
export async function loginUser(
  email: string,
  password: string,
): Promise<LoginResult> {
  const deviceToken = await getTrustedDeviceToken();

  const response = await api<LoginResult>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
    skipAuth: true,
    // Only attach the header when a token exists — an absent header must never
    // be sent as an empty string (the backend treats "no header" as "untrusted
    // device", which is the correct fail-safe default).
    ...(deviceToken ? { headers: { 'X-Device-Token': deviceToken } } : {}),
  });

  if (isTwoFactorChallenge(response)) {
    // Challenge: no access/refresh tokens exist yet — do NOT touch storage.
    return response;
  }

  await setTokens(response.access_token, response.refresh_token);

  return response;
}

/**
 * Send an SMS 2FA one-time code (Spec 2). Authorized by the single-purpose
 * `pendingToken` from the login challenge (NOT a Bearer access token, hence
 * `skipAuth`). `phone` is supplied ONLY on the enrollment/recovery path where
 * the user has no verified number on file yet.
 *
 * @throws {ApiError} 401 bad/expired pending · 422 sentinel/invalid phone ·
 *   409 duplicate phone · 429 rate-limited.
 */
export async function sendTwoFactorCode(
  pendingToken: string,
  phone?: string,
): Promise<SendCodeResponse> {
  const body: Record<string, unknown> = { pending_token: pendingToken };
  if (phone) body.phone = phone;
  return api<SendCodeResponse>('/auth/2fa/send-code', {
    method: 'POST',
    body: JSON.stringify(body),
    skipAuth: true,
  });
}

/**
 * Verify an SMS 2FA one-time code (Spec 2). On success the backend issues the
 * real token pair (identical shape to a normal login) and, when
 * `rememberDevice` is true, also returns a raw `device_token` to persist for
 * the 30-day trusted-device bypass.
 *
 * Tokens are NOT persisted here — the caller (AuthContext, via
 * `signInWithTokens`) owns storing them so the auth-state flip and token
 * persistence stay in one place.
 *
 * @throws {ApiError} 401 bad pending · 410 expired/exhausted code ·
 *   422 wrong code (attempts decrement) · 409 duplicate phone (enrollment).
 */
export async function verifyTwoFactorCode(
  pendingToken: string,
  code: string,
  rememberDevice: boolean,
): Promise<VerifyTwoFactorResponse> {
  return api<VerifyTwoFactorResponse>('/auth/2fa/verify', {
    method: 'POST',
    body: JSON.stringify({
      pending_token: pendingToken,
      code,
      remember_device: rememberDevice,
    }),
    skipAuth: true,
  });
}

/**
 * Optional member-only signup payload. All fields are individually optional
 * at the API layer (only Full Name / DOB / Sex are gated client-side).
 * Snake-case keys because /auth/register accepts the wire shape directly.
 */
export interface MemberSignupExtras {
  /** ISO 8601 date (YYYY-MM-DD) — Pear Suite's expected dob format. */
  date_of_birth?: string;
  /** Pear sex enum: "Male" | "Female" | "Other". */
  gender?: 'Male' | 'Female' | 'Other';
  address_line1?: string;
  address_line2?: string;
  city?: string;
  /** US state 2-letter code (CA, NY, ...). */
  state?: string;
  /** 5-digit ZIP. ZIP+4 lookup deferred. */
  zip_code?: string;
  /** Curated 6-carrier dropdown value. */
  insurance_company?: string;
  /** Medi-Cal CIN — PHI, encrypted at rest on the backend. */
  medi_cal_id?: string;
}

/**
 * Required member-signup consent. Both booleans must be true for the backend
 * to accept a member registration (documented opt-in + HIPAA consent audit).
 * Sent as snake_case (`terms_accepted`, `communications_consent`) on the wire.
 */
export interface MemberSignupConsent {
  /** Member agreed to the Terms of Service + Privacy Policy. */
  termsAccepted: boolean;
  /** Member consented to calls/SMS + insurance billing for covered services. */
  communicationsConsent: boolean;
}

/**
 * Register a new user account.
 * Persists tokens to secure storage as a side-effect.
 *
 * ``memberExtras`` is only meaningful when ``role === "member"``; passed
 * fields are written onto the new MemberProfile row at registration time
 * and a background Pear-sync task fires after the response is returned.
 * The signup is NOT blocked on Pear succeeding.
 */
export async function registerUser(
  email: string,
  password: string,
  name: string,
  role: string,
  phone?: string,
  memberExtras?: MemberSignupExtras,
  consent?: MemberSignupConsent,
): Promise<AuthResponse> {
  const body: Record<string, unknown> = { email, password, name, role };
  if (phone) body.phone = phone;
  if (memberExtras) {
    for (const [key, value] of Object.entries(memberExtras)) {
      if (value !== undefined && value !== '') {
        body[key] = value;
      }
    }
  }
  // Required signup consent for members (A2P 10DLC documented opt-in + HIPAA
  // audit). Sent as snake_case booleans; the backend enforces both === true
  // for member signups (422 otherwise) and stamps the consent timestamps.
  if (consent) {
    body.terms_accepted = consent.termsAccepted;
    body.communications_consent = consent.communicationsConsent;
  }

  const response = await api<AuthResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(body),
    skipAuth: true,
  });

  await setTokens(response.access_token, response.refresh_token);

  return response;
}

/**
 * Invalidate the current session server-side.
 * Tokens should be cleared from storage by the caller (AuthContext.logout).
 */
export async function logoutUser(refreshToken: string): Promise<void> {
  await api<void>('/auth/logout', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

/**
 * Exchange a Google ID token for a Compass JWT pair.
 *
 * Works for both existing accounts (sign-in) and brand-new social sign-ups
 * (sign-up — member-only, per product rules).  The backend creates a member
 * account on first call and returns `needs_onboarding: true` so the UI can
 * gate on CompleteProfileScreen.
 *
 * Tokens are NOT persisted here — the caller (AuthContext.signInWithGoogle)
 * is responsible for calling setTokens() via signInWithTokens().
 *
 * @throws {ApiError} 401 on invalid token, 503/400 if provider not configured.
 */
export async function oauthGoogle(idToken: string): Promise<OAuthResponse> {
  return api<OAuthResponse>('/auth/oauth/google', {
    method: 'POST',
    body: JSON.stringify({ id_token: idToken }),
    skipAuth: true,
  });
}

/**
 * Exchange an Apple ID token for a Compass JWT pair.
 *
 * Same semantics as oauthGoogle — sign-in or member sign-up depending on
 * whether the Apple sub is already associated with an account.
 *
 * @throws {ApiError} 401 on invalid token, 503/400 if provider not configured.
 */
export async function oauthApple(idToken: string): Promise<OAuthResponse> {
  return api<OAuthResponse>('/auth/oauth/apple', {
    method: 'POST',
    body: JSON.stringify({ id_token: idToken }),
    skipAuth: true,
  });
}

/**
 * Complete the onboarding profile for a member who signed up via OAuth.
 *
 * Called after the user fills in the required Pear Suite fields on
 * CompleteProfileScreen.  Requires a valid Bearer token (the caller is
 * already authenticated after the OAuth exchange).
 *
 * On success the server clears the `needs_onboarding` flag so subsequent
 * profile/me calls return `needs_onboarding: false`.
 *
 * @throws {ApiError} on validation failure or auth error.
 */
export async function completeMemberOnboarding(
  payload: CompleteMemberOnboardingPayload,
): Promise<void> {
  await api<void>('/auth/complete-member-onboarding', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
