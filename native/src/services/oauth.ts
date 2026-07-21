/**
 * Web OAuth provider utilities.
 *
 * Dynamically loads the Google Identity Services and Sign in with Apple JS
 * SDKs on web.  These are no-ops on native (iOS/Android) — callers gate with
 * `Platform.OS === 'web'` before calling.
 *
 * Neither function is exported for native use.  Use `isGoogleConfigured()` /
 * `isAppleConfigured()` to decide whether to render the buttons.
 */

import { Platform } from 'react-native';

// ─── Env / config guards ──────────────────────────────────────────────────────

/**
 * True when a Google OAuth client ID has been provided via the build env.
 * Returns false on native (buttons hidden on native anyway).
 */
export function isGoogleConfigured(): boolean {
  if (Platform.OS !== 'web') return false;
  const id = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? '';
  return id.trim().length > 0;
}

/**
 * True when Apple Service ID + Redirect URI have both been provided.
 * Returns false on native.
 */
export function isAppleConfigured(): boolean {
  if (Platform.OS !== 'web') return false;
  const serviceId = process.env.EXPO_PUBLIC_APPLE_SERVICE_ID ?? '';
  const redirectUri = process.env.EXPO_PUBLIC_APPLE_REDIRECT_URI ?? '';
  return serviceId.trim().length > 0 && redirectUri.trim().length > 0;
}

// ─── Typed errors ─────────────────────────────────────────────────────────────

export type OAuthErrorCode =
  | 'not_configured'
  | 'script_load_failed'
  | 'user_cancelled'
  | 'no_credential'
  | 'provider_error';

export class OAuthError extends Error {
  public readonly code: OAuthErrorCode;

  constructor(code: OAuthErrorCode, message: string) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

// ─── Script loader ────────────────────────────────────────────────────────────

/**
 * Dynamically injects a `<script>` tag and resolves when it loads.
 * Reuses an existing script tag if one with the same src is already in the DOM.
 *
 * @throws {OAuthError} with code 'script_load_failed' on network/parse error.
 */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new OAuthError('script_load_failed', `Cannot load script in non-browser context: ${src}`));
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      // Script already in DOM — it may or may not be fully loaded yet.
      // If the global it registers is present, resolve immediately.
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;

    script.onload = () => resolve();
    script.onerror = () => {
      reject(new OAuthError('script_load_failed', `Failed to load OAuth SDK from ${src}`));
    };

    document.head.appendChild(script);
  });
}

// ─── Google Identity Services types ──────────────────────────────────────────

interface GoogleCredentialResponse {
  credential: string;
  select_by: string;
  client_id: string;
}

/**
 * Result delivered to the `initCodeClient` callback for the Google
 * authorization-CODE flow (distinct from the id_token / credential flow).
 * `code` is the one-time authorization code the backend exchanges — with the
 * client secret and `redirect_uri` — for access + refresh tokens.
 */
interface GoogleCodeResponse {
  code?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * Error object passed to `initCodeClient`'s `error_callback` when the popup
 * fails to open or the user dismisses it (GIS does not route these through the
 * success `callback`).
 */
interface GoogleOAuth2ErrorResponse {
  type?: string;
  message?: string;
}

/** The client returned by `initCodeClient`; `requestCode()` opens the popup. */
interface GoogleCodeClient {
  requestCode: () => void;
}

/**
 * The `google.accounts.oauth2` namespace — the authorization-code half of GIS,
 * previously stubbed as `unknown`. `initCodeClient` builds a client for the
 * OAuth 2.0 authorization-code flow (offline access → refresh token on the
 * server), used by "Connect Google Calendar".
 */
interface GoogleOAuth2 {
  initCodeClient: (config: {
    client_id: string;
    scope: string;
    ux_mode?: 'popup' | 'redirect';
    redirect_uri?: string;
    access_type?: 'online' | 'offline';
    prompt?: string;
    callback: (response: GoogleCodeResponse) => void;
    error_callback?: (error: GoogleOAuth2ErrorResponse) => void;
  }) => GoogleCodeClient;
}

interface GoogleAccounts {
  id: {
    initialize: (config: {
      client_id: string;
      callback: (response: GoogleCredentialResponse) => void;
      auto_select?: boolean;
      cancel_on_tap_outside?: boolean;
    }) => void;
    prompt: (
      notification?: (n: { isNotDisplayed: () => boolean; isSkippedMoment: () => boolean; isDismissedMoment: () => boolean }) => void,
    ) => void;
    disableAutoSelect: () => void;
    renderButton: (
      parent: HTMLElement,
      options: {
        type?: 'standard' | 'icon';
        theme?: 'outline' | 'filled_blue' | 'filled_black';
        size?: 'large' | 'medium' | 'small';
        text?: string;
        shape?: 'rectangular' | 'pill' | 'circle' | 'square';
        logo_alignment?: 'left' | 'center';
        width?: number;
      },
    ) => void;
    revoke: (hint: string, done: (response: GoogleCodeResponse) => void) => void;
  };
  oauth2: GoogleOAuth2;
}

declare global {
  interface Window {
    google?: { accounts: GoogleAccounts };
    AppleID?: {
      auth: {
        init: (config: {
          clientId: string;
          scope: string;
          redirectURI: string;
          usePopup: boolean;
        }) => void;
        signIn: () => Promise<AppleSignInResponse>;
      };
    };
  }
}

// ─── Apple Sign-In types ──────────────────────────────────────────────────────

interface AppleSignInResponse {
  authorization: {
    id_token: string;
    code: string;
    state?: string;
  };
  user?: {
    email?: string;
    name?: {
      firstName?: string;
      lastName?: string;
    };
  };
}

// ─── Google sign-in ───────────────────────────────────────────────────────────

const GOOGLE_GSI_URL = 'https://accounts.google.com/gsi/client';

/**
 * Trigger the Google Identity Services "One Tap / popup" flow and return the
 * raw ID token (JWT) that the backend expects at POST /auth/oauth/google.
 *
 * WEB ONLY.  Call site must guard with `Platform.OS === 'web'`.
 *
 * @returns The Google ID token string.
 * @throws {OAuthError} on script load failure, user cancellation, or any
 *   GIS error (code: 'script_load_failed' | 'user_cancelled' | 'no_credential').
 */
export async function getGoogleIdToken(): Promise<string> {
  if (Platform.OS !== 'web') {
    throw new OAuthError('not_configured', 'Google OAuth is only available on web.');
  }

  const clientId = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? '';
  if (!clientId.trim()) {
    throw new OAuthError('not_configured', 'EXPO_PUBLIC_GOOGLE_CLIENT_ID is not set.');
  }

  await loadScript(GOOGLE_GSI_URL);

  // The GIS library registers synchronously on load, but give it one tick to
  // attach to window.google in case the onload callback resolves before the
  // library fully initialises its namespace.
  await new Promise<void>((r) => setTimeout(r, 0));

  if (!window.google?.accounts?.id) {
    throw new OAuthError('script_load_failed', 'Google Identity Services failed to initialise.');
  }

  return new Promise<string>((resolve, reject) => {
    window.google!.accounts.id.initialize({
      client_id: clientId,
      callback: (response: GoogleCredentialResponse) => {
        if (!response.credential) {
          reject(new OAuthError('no_credential', 'Google did not return a credential.'));
          return;
        }
        resolve(response.credential);
      },
      auto_select: false,
      cancel_on_tap_outside: true,
    });

    window.google!.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        // The prompt was suppressed (e.g. user previously dismissed it too many
        // times, or no Google session active in the browser).
        reject(new OAuthError('user_cancelled', 'Google sign-in prompt was not displayed or was skipped. Try signing in with a different method.'));
      } else if (notification.isDismissedMoment()) {
        reject(new OAuthError('user_cancelled', 'Google sign-in was cancelled.'));
      }
    });
  });
}

// ─── Apple sign-in ────────────────────────────────────────────────────────────

const APPLE_AUTH_JS_URL =
  'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';

/**
 * Trigger the Sign in with Apple JS popup and return the raw ID token (JWT)
 * that the backend expects at POST /auth/oauth/apple.
 *
 * WEB ONLY.  Call site must guard with `Platform.OS === 'web'`.
 *
 * @returns The Apple ID token string.
 * @throws {OAuthError} on script load failure, user cancellation, or
 *   any Apple error (code: 'script_load_failed' | 'user_cancelled' | 'provider_error').
 */
export async function getAppleIdToken(): Promise<string> {
  if (Platform.OS !== 'web') {
    throw new OAuthError('not_configured', 'Apple OAuth is only available on web.');
  }

  const serviceId = process.env.EXPO_PUBLIC_APPLE_SERVICE_ID ?? '';
  const redirectURI = process.env.EXPO_PUBLIC_APPLE_REDIRECT_URI ?? '';

  if (!serviceId.trim()) {
    throw new OAuthError('not_configured', 'EXPO_PUBLIC_APPLE_SERVICE_ID is not set.');
  }
  if (!redirectURI.trim()) {
    throw new OAuthError('not_configured', 'EXPO_PUBLIC_APPLE_REDIRECT_URI is not set.');
  }

  await loadScript(APPLE_AUTH_JS_URL);

  if (!window.AppleID?.auth) {
    throw new OAuthError('script_load_failed', 'Sign in with Apple JS failed to initialise.');
  }

  window.AppleID.auth.init({
    clientId: serviceId,
    scope: 'name email',
    redirectURI,
    usePopup: true,
  });

  let response: AppleSignInResponse;
  try {
    response = await window.AppleID.auth.signIn();
  } catch (err: unknown) {
    // Apple throws a plain object like { error: 'popup_closed_by_user' } on cancel.
    const errorObj = err as { error?: string } | null;
    const code = errorObj?.error ?? '';

    if (
      code === 'popup_closed_by_user' ||
      code === 'user_cancelled_authorize'
    ) {
      throw new OAuthError('user_cancelled', 'Apple sign-in was cancelled.');
    }

    throw new OAuthError(
      'provider_error',
      `Apple sign-in failed: ${code || String(err)}`,
    );
  }

  const idToken = response.authorization?.id_token;
  if (!idToken) {
    throw new OAuthError('no_credential', 'Apple did not return an ID token.');
  }

  return idToken;
}

// ─── Google Calendar authorization-code flow ──────────────────────────────────

/**
 * OAuth scope requested for calendar sync. `calendar.events` grants read/write
 * on the user's events only (not full calendar management) — the minimum needed
 * to push Compass sessions onto their Google Calendar.
 */
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/**
 * The redirect URI paired with the authorization code in the GIS `popup`
 * ux_mode. Google fixes this to the literal string `'postmessage'` for the
 * popup code flow, and the backend MUST pass the SAME value when exchanging the
 * code for tokens — otherwise the exchange fails with `redirect_uri_mismatch`.
 */
export const GOOGLE_CALENDAR_REDIRECT_URI = 'postmessage';

/**
 * Run Google's authorization-CODE flow (offline access) and return the one-time
 * auth `code` plus the `redirectUri` the backend must echo when exchanging it.
 *
 * Unlike {@link getGoogleIdToken} (which returns an id_token for sign-in), this
 * requests the calendar scope with `access_type: 'offline'` + `prompt:
 * 'consent'` so Google issues a REFRESH token to the backend on exchange —
 * required to push sessions to the calendar long after the popup closes.
 *
 * WEB ONLY. Mirrors {@link getGoogleIdToken}: throws an OAuthError with code
 * `not_configured` on native or when the client ID is unset.
 *
 * @returns `{ code, redirectUri }` on success, or `null` if the user closed the
 *   popup without granting access (a benign cancellation, not an error).
 * @throws {OAuthError} on script-load failure or a provider error
 *   (`script_load_failed` | `provider_error` | `no_credential`).
 */
export async function getGoogleCalendarAuthCode(): Promise<{ code: string; redirectUri: string } | null> {
  if (Platform.OS !== 'web') {
    throw new OAuthError('not_configured', 'Google Calendar sync is only available on web.');
  }

  const clientId = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? '';
  if (!clientId.trim()) {
    throw new OAuthError('not_configured', 'EXPO_PUBLIC_GOOGLE_CLIENT_ID is not set.');
  }

  await loadScript(GOOGLE_GSI_URL);

  // Give the library one tick to attach its namespace (see getGoogleIdToken).
  await new Promise<void>((r) => setTimeout(r, 0));

  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2?.initCodeClient) {
    throw new OAuthError('script_load_failed', 'Google Identity Services failed to initialise.');
  }

  return new Promise<{ code: string; redirectUri: string } | null>((resolve, reject) => {
    const codeClient = oauth2.initCodeClient({
      client_id: clientId,
      scope: GOOGLE_CALENDAR_SCOPE,
      ux_mode: 'popup',
      access_type: 'offline',
      prompt: 'consent',
      callback: (response: GoogleCodeResponse) => {
        if (response.error) {
          // `access_denied` fires when the user unticks the calendar scope on
          // the consent screen — treat as a benign cancellation.
          if (response.error === 'access_denied') {
            resolve(null);
            return;
          }
          reject(
            new OAuthError(
              'provider_error',
              `Google returned an error: ${response.error_description ?? response.error}`,
            ),
          );
          return;
        }
        if (!response.code) {
          reject(new OAuthError('no_credential', 'Google did not return an authorization code.'));
          return;
        }
        resolve({ code: response.code, redirectUri: GOOGLE_CALENDAR_REDIRECT_URI });
      },
      error_callback: (err: GoogleOAuth2ErrorResponse) => {
        // The popup was closed or blocked before consent — a benign cancel.
        if (err?.type === 'popup_closed' || err?.type === 'popup_failed_to_open') {
          resolve(null);
          return;
        }
        reject(
          new OAuthError('provider_error', `Google sign-in failed: ${err?.message ?? err?.type ?? 'unknown error'}`),
        );
      },
    });

    codeClient.requestCode();
  });
}
