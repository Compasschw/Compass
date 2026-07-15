/**
 * Component tests for RegisterScreen — self-service member signup.
 *
 * Scope (Epic F — Add Member / consent, batch plan):
 *   - F1: the Sex picker offers only Male/Female (no "Other").
 *   - F2: "Terms of Service" / "Privacy Policy" in the consent block are real
 *     tappable links that navigate to the in-app Legal route.
 *   - F3: the communications-consent copy conveys call/text/email/in-person
 *     communication via the CompassCHW platform, and no-cost insurance billing.
 *   - Regression: the required consent gate (both boxes) still blocks submit.
 *
 * Tier 2 (jsdom + react-native-web, see native/TESTING.md). Only the network
 * boundary (`register`, via a mocked AuthContext) and navigation are mocked —
 * the form's own validation/gating logic runs for real.
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// RegisterScreen now uses useStartPhoneVerification (a react-query mutation)
// which calls api() best-effort on the member verify-at-signup path. Stub the
// network boundary so that fire-and-forget send never hits the wire; ApiError
// is preserved for the existing 409/422 banner tests.
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn().mockResolvedValue(undefined) };
});

// react-native-svg's real entry (used here only for the Google/Apple social
// icons, which never render in this test env — no EXPO_PUBLIC_* OAuth client
// IDs are set) does a bare `import ... from 'react-native'` internally that
// resolves to the *real* react-native package under plain Node/jsdom (Vitest
// externalizes node_modules, bypassing the react-native → react-native-web
// alias) and fails to parse react-native's Flow `import typeof` syntax. Same
// class of problem vitest.setup.ts already documents + stubs for
// lucide-react-native. RegisterScreen is the first tested surface that pulls
// in react-native-svg, so the stub lives here rather than growing the global
// setup file for a module only one screen currently uses.
vi.mock('react-native-svg', () => {
  const StubSvg = (props: Record<string, unknown>): React.ReactElement =>
    React.createElement('svg', props);
  const StubPath = (props: Record<string, unknown>): React.ReactElement =>
    React.createElement('path', props);
  return { __esModule: true, default: StubSvg, Path: StubPath };
});

const mockRegister = vi.fn().mockResolvedValue(undefined);
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    register: mockRegister,
    signInWithGoogle: vi.fn(),
    signInWithApple: vi.fn(),
  }),
}));

// `mockNavigate` is hoisted so every `useNavigation()` call across re-renders
// returns the SAME spy (mirrors CHWCalendarScreen.test.tsx's pattern — a
// literal replacement avoids @react-navigation/native's real barrel, which
// drags in an extension-less import jsdom/vite-node can't resolve).
const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
}));

import { ApiError } from '../../api/client';
import { RegisterScreen } from './RegisterScreen';

const COMMUNICATIONS_LABEL =
  'I consent to receive communication — by call, text, email, or in person — from my Community Health Worker via the CompassCHW platform, and for Compass to bill my insurance for covered services, always at no cost to me.';

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RegisterScreen />
    </QueryClientProvider>,
  );
}

/** Fills every field required to reach canSubmit === true for the default
 * (member) role, without touching the two consent checkboxes. */
function fillRequiredMemberFields(): void {
  fireEvent.change(screen.getByPlaceholderText('First name'), {
    target: { value: 'Jordan' },
  });
  fireEvent.change(screen.getByPlaceholderText('Last name'), {
    target: { value: 'Rivera' },
  });
  fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
    target: { value: 'jordan@example.com' },
  });
  fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), {
    target: { value: 'Temp-Pass1234' },
  });
  fireEvent.change(screen.getByPlaceholderText('MM/DD/YYYY'), {
    target: { value: '04/12/1990' },
  });
  fireEvent.click(screen.getByLabelText('Select sex'));
  fireEvent.click(screen.getByText('Female'));
  fireEvent.click(screen.getByLabelText('Select primary insurance company'));
  fireEvent.click(screen.getByText('Health Net'));
  fireEvent.change(screen.getByPlaceholderText('e.g. 91234567A2'), {
    target: { value: '12345678A' },
  });
  fireEvent.change(screen.getByPlaceholderText('90031'), {
    target: { value: '90001' },
  });
}

beforeEach(() => {
  mockRegister.mockClear();
  mockNavigate.mockClear();
});

describe('RegisterScreen — Sex options (F1)', () => {
  it('offers only Male and Female in the Sex picker (no "Other")', () => {
    renderScreen();
    fireEvent.click(screen.getByLabelText('Select sex'));
    expect(screen.getByText('Male')).toBeTruthy();
    expect(screen.getByText('Female')).toBeTruthy();
    expect(screen.queryByText('Other')).toBeNull();
  });
});

describe('RegisterScreen — Terms of Service / Privacy Policy links (F2)', () => {
  it('navigates to the Legal terms page when "Terms of Service" is tapped', () => {
    renderScreen();
    fireEvent.click(screen.getByText('Terms of Service'));
    expect(mockNavigate).toHaveBeenCalledWith('Legal', { page: 'terms' });
  });

  it('navigates to the Legal privacy page when "Privacy Policy" is tapped', () => {
    renderScreen();
    fireEvent.click(screen.getByText('Privacy Policy'));
    expect(mockNavigate).toHaveBeenCalledWith('Legal', { page: 'privacy' });
  });
});

describe('RegisterScreen — communications consent copy (F3)', () => {
  it('conveys call/text/email/in-person communication via the CompassCHW platform, and no-cost insurance billing', () => {
    renderScreen();
    expect(screen.getByText(COMMUNICATIONS_LABEL)).toBeTruthy();
  });
});

describe('RegisterScreen — inline password feedback (QA batch item 1)', () => {
  /** Role = CHW keeps the fixture minimal: canSubmit only needs
   * accountBasicsOk (no DOB/insurance/CIN/consent required). */
  function fillChwBasics(): void {
    fireEvent.click(screen.getByText("I'm a CHW"));
    fireEvent.change(screen.getByPlaceholderText('First name'), {
      target: { value: 'Jordan' },
    });
    fireEvent.change(screen.getByPlaceholderText('Last name'), {
      target: { value: 'Rivera' },
    });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'jordan@example.com' },
    });
  }

  it('shows no inline error while the password field is empty', () => {
    renderScreen();
    fillChwBasics();
    expect(screen.queryByText(/^Password needs/)).toBeNull();
  });

  it('shows the specific unmet-rule message for a password missing a special character, and keeps submit disabled', () => {
    renderScreen();
    fillChwBasics();
    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), {
      target: { value: 'Zoro1234' },
    });

    expect(screen.getByText('Password needs a special character.')).toBeTruthy();
    const submit = screen.getByLabelText('Create account');
    expect(submit.getAttribute('aria-disabled')).toBe('true');
  });

  it('clears the inline error and enables submit once the password satisfies the full policy', () => {
    renderScreen();
    fillChwBasics();
    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), {
      target: { value: 'Zoro123!' },
    });

    expect(screen.queryByText(/^Password needs/)).toBeNull();
    const submit = screen.getByLabelText('Create account');
    expect(submit.getAttribute('aria-disabled')).not.toBe('true');
  });
});

describe('RegisterScreen — clean 422 banner text (QA batch item 2)', () => {
  it('renders a mocked register() rejection message as-is in the error banner (no JSON blob)', async () => {
    // By the time an error reaches RegisterScreen it has already passed
    // through the api/client.ts parser (see client.test.ts for that
    // transformation), so this pins the display contract: whatever clean
    // string the parser produced is shown verbatim, never re-wrapped or
    // re-stringified into a raw Pydantic-shaped blob.
    mockRegister.mockRejectedValueOnce(
      new Error('Password must contain at least one special character'),
    );
    renderScreen();
    fireEvent.click(screen.getByText("I'm a CHW"));
    fireEvent.change(screen.getByPlaceholderText('First name'), {
      target: { value: 'Jordan' },
    });
    fireEvent.change(screen.getByPlaceholderText('Last name'), {
      target: { value: 'Rivera' },
    });
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'jordan@example.com' },
    });
    fireEvent.change(screen.getByPlaceholderText('At least 8 characters'), {
      target: { value: 'Zoro123!' },
    });

    fireEvent.click(screen.getByLabelText('Create account'));

    const banner = await screen.findByText(
      'Password must contain at least one special character',
    );
    expect(banner).toBeTruthy();
    expect(screen.queryByText(/^\{.*\}$/)).toBeNull();
    expect(screen.queryByText(/"loc"/)).toBeNull();
  });
});

describe('RegisterScreen — required consent gate (regression)', () => {
  it('keeps "Create account" disabled until BOTH consent boxes are checked', () => {
    renderScreen();
    fillRequiredMemberFields();

    const submit = screen.getByLabelText('Create account');
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(submit);
    expect(mockRegister).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('consent-terms'));
    expect(submit.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(screen.getByTestId('consent-communications'));
    expect(submit.getAttribute('aria-disabled')).not.toBe('true');
  });
});

// QA feedback batch (2026-07-14), Part 4 — a 409 whose detail mentions the
// CIN is shown inline under the CIN field (in addition to being surfaced by
// `register`'s rejection), not only as the generic top banner.
describe('RegisterScreen — duplicate CIN 409 (Part 4)', () => {
  function submitMemberSignup(): void {
    fillRequiredMemberFields();
    fireEvent.click(screen.getByTestId('consent-terms'));
    fireEvent.click(screen.getByTestId('consent-communications'));
    fireEvent.click(screen.getByLabelText('Create account'));
  }

  it('shows the backend duplicate-CIN message inline under the CIN field', async () => {
    mockRegister.mockRejectedValueOnce(
      new ApiError(409, 'Another member already has this CIN (Medi-Cal ID).'),
    );
    renderScreen();
    submitMemberSignup();

    await waitFor(() =>
      expect(
        screen.getByText('Another member already has this CIN (Medi-Cal ID).'),
      ).toBeTruthy(),
    );
  });

  it('falls back to the generic top banner for a non-CIN error', async () => {
    mockRegister.mockRejectedValueOnce(new Error('Network error. Please try again.'));
    renderScreen();
    submitMemberSignup();

    await waitFor(() =>
      expect(screen.getByText('Network error. Please try again.')).toBeTruthy(),
    );
  });
});

// ─── SMS Output Spec 1 §1 — verify-at-signup navigation ───────────────────────
describe('RegisterScreen — verify-at-signup navigation (SMS Output Spec 1)', () => {
  function fillPhone(value: string): void {
    fireEvent.change(screen.getByPlaceholderText('(555) 123-4567'), {
      target: { value },
    });
  }
  function submitMemberSignup(): void {
    fillRequiredMemberFields();
    fireEvent.click(screen.getByTestId('consent-terms'));
    fireEvent.click(screen.getByTestId('consent-communications'));
    fireEvent.click(screen.getByLabelText('Create account'));
  }

  it('routes a member with a real phone to the VerifyPhone step (E.164-normalised)', async () => {
    renderScreen();
    fillPhone('(310) 555-0188');
    submitMemberSignup();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('VerifyPhone', { phone: '+13105550188' });
    });
  });

  it('does NOT route a member whose phone is the 555-555-5555 placeholder to VerifyPhone', async () => {
    renderScreen();
    fillPhone('555-555-5555');
    submitMemberSignup();

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledTimes(1);
    });
    expect(mockNavigate).not.toHaveBeenCalledWith('VerifyPhone', expect.anything());
  });
});
