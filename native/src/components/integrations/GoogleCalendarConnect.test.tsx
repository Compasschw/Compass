/**
 * Component tests for GoogleCalendarConnect — the web-only "Connect Google
 * Calendar" card shown in member Settings and CHW profile.
 *
 * Scope:
 *   - Not-connected state renders the Connect button; a successful auth-code
 *     flow POSTs /integrations/google-calendar/connect with {code, redirect_uri}
 *     and then flips the card to the connected state.
 *   - Connected state renders "Connected as {email}" + a Disconnect button that
 *     POSTs /integrations/google-calendar/disconnect and flips back.
 *   - Renders nothing on native (Platform.OS !== 'web').
 *   - A provider error from the auth-code flow shows an inline error and never
 *     POSTs /connect.
 *
 * Two boundaries are mocked: the network (`../../api/client`) and the Google
 * Identity Services code client (`window.google.accounts.oauth2`). The real
 * hooks and the real getGoogleCalendarAuthCode run against them. Tier 2 — jsdom
 * + react-native-web (see native/TESTING.md).
 */
import React from 'react';
import { Platform } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});

import { api } from '../../api/client';
import { GOOGLE_CALENDAR_SCOPE } from '../../services/oauth';
import { GoogleCalendarConnect } from './GoogleCalendarConnect';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

const GSI_SRC = 'https://accounts.google.com/gsi/client';
const STATUS_PATH = '/integrations/google-calendar/status';
const CONNECT_PATH = '/integrations/google-calendar/connect';
const DISCONNECT_PATH = '/integrations/google-calendar/disconnect';

interface CodeResponse {
  code?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}
interface ErrorResponse {
  type?: string;
  message?: string;
}
type CodeClientBehavior = (
  callback: (resp: CodeResponse) => void,
  errorCallback?: (err: ErrorResponse) => void,
) => void;

/**
 * Install a fake GIS `oauth2.initCodeClient` on window whose `requestCode()`
 * drives the supplied behaviour. Also pre-injects the GSI <script> so the real
 * `loadScript` resolves immediately (jsdom never fires a script onload).
 */
function installCodeClient(behavior: CodeClientBehavior): ReturnType<typeof vi.fn> {
  if (!document.querySelector(`script[src="${GSI_SRC}"]`)) {
    const s = document.createElement('script');
    s.src = GSI_SRC;
    document.head.appendChild(s);
  }
  const initCodeClient = vi.fn((config: {
    callback: (resp: CodeResponse) => void;
    error_callback?: (err: ErrorResponse) => void;
  }) => ({
    requestCode: vi.fn(() => behavior(config.callback, config.error_callback)),
  }));
  (window as unknown as { google: unknown }).google = {
    accounts: { id: {}, oauth2: { initCodeClient } },
  };
  return initCodeClient;
}

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GoogleCalendarConnect />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedApi.mockReset();
  process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
  (Platform as { OS: string }).OS = 'web';
  delete (window as unknown as { google?: unknown }).google;
});

afterEach(() => {
  (Platform as { OS: string }).OS = 'web';
});

describe('GoogleCalendarConnect', () => {
  it('shows Connect, then POSTs {code, redirect_uri} and flips to connected on success', async () => {
    let statusResp: { connected: boolean; google_email: string | null } = {
      connected: false,
      google_email: null,
    };
    let connectBody: string | undefined;

    mockedApi.mockImplementation(async (path: string, opts?: { body?: string }) => {
      if (path === STATUS_PATH) return statusResp;
      if (path === CONNECT_PATH) {
        connectBody = opts?.body;
        // The backend now holds a refresh token — subsequent status reads flip.
        statusResp = { connected: true, google_email: 'user@example.com' };
        return { connected: true };
      }
      throw new Error(`unexpected api path: ${path}`);
    });

    const initCodeClient = installCodeClient((cb) =>
      cb({ code: 'auth-code-xyz', scope: GOOGLE_CALENDAR_SCOPE }),
    );

    renderCard();

    const connectBtn = await screen.findByLabelText('Connect Google Calendar');
    expect(connectBtn).toBeTruthy();

    fireEvent.click(connectBtn);

    await waitFor(() => expect(screen.getByLabelText('Google Calendar connected')).toBeTruthy());
    expect(screen.getByText('Connected as user@example.com')).toBeTruthy();

    // The auth-code flow requested the calendar scope with offline access.
    expect(initCodeClient).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: GOOGLE_CALENDAR_SCOPE,
        access_type: 'offline',
        ux_mode: 'popup',
        prompt: 'consent',
      }),
    );

    // The exact backend contract: {code, redirect_uri} (snake_case on the wire).
    expect(connectBody).toBeDefined();
    expect(JSON.parse(connectBody as string)).toEqual({
      code: 'auth-code-xyz',
      redirect_uri: 'postmessage',
    });
  });

  it('renders connected state with the email and disconnects on demand', async () => {
    let statusResp: { connected: boolean; google_email: string | null } = {
      connected: true,
      google_email: 'chw@example.com',
    };
    let disconnectCalled = false;

    mockedApi.mockImplementation(async (path: string) => {
      if (path === STATUS_PATH) return statusResp;
      if (path === DISCONNECT_PATH) {
        disconnectCalled = true;
        statusResp = { connected: false, google_email: null };
        return { connected: false };
      }
      throw new Error(`unexpected api path: ${path}`);
    });

    renderCard();

    expect(await screen.findByText('Connected as chw@example.com')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Disconnect Google Calendar'));

    await waitFor(() => expect(screen.getByLabelText('Connect Google Calendar')).toBeTruthy());
    expect(disconnectCalled).toBe(true);
  });

  it('renders nothing on native (Platform.OS !== web) and never calls the API', () => {
    (Platform as { OS: string }).OS = 'ios';
    mockedApi.mockResolvedValue({ connected: false, google_email: null });

    const { container } = renderCard();

    expect(container.firstChild).toBeNull();
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('shows an inline error when the auth-code flow fails, and does not POST connect', async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === STATUS_PATH) return { connected: false, google_email: null };
      throw new Error(`unexpected api path: ${path}`);
    });

    installCodeClient((cb) => cb({ error: 'invalid_scope', error_description: 'bad scope' }));

    renderCard();

    fireEvent.click(await screen.findByLabelText('Connect Google Calendar'));

    await waitFor(() => expect(screen.getByLabelText('Google Calendar error')).toBeTruthy());

    // Never advanced to the connect POST — status was the only call.
    expect(mockedApi).not.toHaveBeenCalledWith(CONNECT_PATH, expect.anything());
    // Still in the not-connected state.
    expect(screen.getByLabelText('Connect Google Calendar')).toBeTruthy();
  });
});
