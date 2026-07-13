/**
 * Component test for CHWProfileScreen covering the Epic C (CHW profile edits)
 * batch of changes:
 *
 *  - C1: the "Modality" section is fully removed (no stray chips/labels).
 *  - C2: the ZIP field label reads "ZIP Code" (was "Service Area ZIPs").
 *  - C4: saving availability shows an inline "Availability saved ✓"
 *    confirmation next to the Save availability button on success —
 *    useUpdateChwAvailability (useApiQueries.ts) already has an onError alert
 *    but no user-facing success feedback, so this fills that gap. A failed
 *    save must NOT show the confirmation (covered separately).
 *  - C3: the Bio field is capped at 120 characters (maxLength on the input,
 *    plus a live "N/120" counter) — enforced here client-side; the API
 *    schema (CHWProfileUpdate.bio, backend/app/schemas/user.py) enforces the
 *    same cap server-side (see backend/tests/test_chw_profile_bio_length.py).
 *
 * Only the network boundary (`../../api/client`), auth context, and
 * navigation hook are mocked (Tier 2 — jsdom + react-native-web, see
 * native/TESTING.md) — useChwProfile, useChwAvailability, useUpdateChwProfile,
 * useUpdateChwAvailability, and useChwEarnings all run for real against a
 * routed `api()` mock, so this exercises the actual production data-fetching
 * and mutation wiring, not a hand-rolled hook mock.
 */
import React from 'react';
import { Alert } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    userName: 'Test CHW',
    logout: vi.fn(),
    clearAfterDeletion: vi.fn(),
  }),
}));
// See CHWMessagesScreen.test.tsx for why this needs a full literal
// replacement rather than `importOriginal` — @react-navigation/native's real
// barrel drags in an extension-less import that jsdom/vite-node can't
// resolve. CHWProfileScreen only uses `useNavigation` (Earnings dashboard link).
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
}));

import { api } from '../../api/client';
import { CHWProfileScreen } from './CHWProfileScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

const CHW_PROFILE_FIXTURE = {
  id: 'chw-profile-1',
  user_id: 'chw-1',
  specializations: ['food'],
  languages: ['English', 'Spanish'],
  rating: 4.8,
  years_experience: 3,
  total_sessions: 12,
  is_available: true,
  bio: 'Community health worker serving South LA.',
  zip_code: '90033',
  name: 'Test CHW',
  email: 'chw@example.com',
  phone: '(310) 555-0100',
  profile_picture_url: null,
  hipaa_training_completed: true,
  chw_certification: 'CA-CHW-12345',
  background_check_status: 'clear',
};

const AVAILABILITY_FIXTURE = {
  availability_windows: { mon: '09:00-17:00', tue: '09:00-17:00' },
};

const EARNINGS_FIXTURE = {
  pending_payout: 120.5,
  this_month: 480,
  all_time: 3200,
  sessions_this_week: 4,
};

/** Epic D — full 5-item checklist fixture, all missing by default (a fresh
 * CHW). Individual tests override via mockedApi.mockImplementation. */
const CHECKLIST_FIXTURE_ALL_MISSING = {
  can_work: false,
  missing: [
    'hipaa_training',
    'professional_service_agreement',
    'liability_insurance',
    'chw_certification',
    'background_check',
  ],
  items: [
    { code: 'hipaa_training', status: 'missing' },
    { code: 'professional_service_agreement', status: 'missing' },
    { code: 'liability_insurance', status: 'missing' },
    { code: 'chw_certification', status: 'missing' },
    { code: 'background_check', status: 'pending' },
  ],
};

/** Routes the mocked `api()` calls by path/method so every hook the screen
 * fires (profile, availability, earnings, conversations for AppShell) gets a
 * sane response instead of an unhandled rejection. */
function installApiRouter(): void {
  mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path === '/chw/profile' && method === 'GET') return CHW_PROFILE_FIXTURE;
    if (path === '/chw/profile' && method === 'PUT') return {};
    if (path === '/chw/availability' && method === 'GET') return AVAILABILITY_FIXTURE;
    if (path === '/chw/availability' && method === 'PUT') return AVAILABILITY_FIXTURE;
    if (path.startsWith('/chw/earnings')) return EARNINGS_FIXTURE;
    if (path.startsWith('/conversations')) return [];
    if (path === '/credentials/checklist' && method === 'GET') return CHECKLIST_FIXTURE_ALL_MISSING;
    return {};
  });
}

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CHWProfileScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockedApi.mockReset();
  installApiRouter();
});

describe('CHWProfileScreen — Account & Security', () => {
  it('does not render the removed "Download all my data" button', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Account & Security')).toBeTruthy());

    expect(screen.queryByText(/download all my data/i)).toBeNull();
    expect(screen.queryByLabelText(/download all my data/i)).toBeNull();

    // "Sign out of this device" and "Delete my account" must be unaffected.
    expect(screen.getByText('Sign out of this device')).toBeTruthy();
    expect(screen.getByText('Delete my account')).toBeTruthy();
  });
});

describe('CHWProfileScreen — Epic C profile edits', () => {
  it('does not render a Modality section (C1)', async () => {
    renderScreen();

    // Wait for the profile query to resolve and the form to render.
    await waitFor(() => expect(screen.getByText('Profile information')).toBeTruthy());

    expect(screen.queryByText('Modality')).toBeNull();
    expect(screen.queryByText('In Person')).toBeNull();
    expect(screen.queryByText('Virtual')).toBeNull();
    expect(screen.queryByText('Hybrid')).toBeNull();
    expect(screen.queryByLabelText('In Person')).toBeNull();
  });

  it('labels the ZIP field "ZIP Code", not "Service Area ZIPs" (C2)', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('ZIP Code')).toBeTruthy());
    expect(screen.queryByText('Service Area ZIPs')).toBeNull();

    // Entering edit mode should surface a single-ZIP placeholder, not the old
    // comma-separated multi-ZIP placeholder — confirms the field truly moved
    // to a single zip_code, not just a relabeled multi-zip input.
    fireEvent.click(screen.getByLabelText('Edit ZIP Code'));
    expect(screen.getByPlaceholderText('90033')).toBeTruthy();
  });

  it('shows an inline confirmation next to the button after Save availability succeeds (C4)', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByLabelText('Save availability')).toBeTruthy());

    expect(screen.queryByText('Availability saved ✓')).toBeNull();

    fireEvent.click(screen.getByLabelText('Save availability'));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        '/chw/availability',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );

    await waitFor(() => expect(screen.getByText('Availability saved ✓')).toBeTruthy());
  });

  it('does not show the confirmation when Save availability fails (C4 error path)', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByLabelText('Save availability')).toBeTruthy());
    expect(screen.queryByText('Availability saved ✓')).toBeNull();

    // Re-route the PUT to reject — everything else stays on the happy-path
    // fixtures so unrelated hooks (profile, earnings, conversations) don't
    // start throwing on an incidental refetch.
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (path === '/chw/availability' && method === 'PUT') {
        throw new Error('Network error');
      }
      if (path === '/chw/profile' && method === 'GET') return CHW_PROFILE_FIXTURE;
      if (path === '/chw/availability' && method === 'GET') return AVAILABILITY_FIXTURE;
      if (path.startsWith('/chw/earnings')) return EARNINGS_FIXTURE;
      if (path.startsWith('/conversations')) return [];
      return {};
    });

    fireEvent.click(screen.getByLabelText('Save availability'));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        '/chw/availability',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );

    // The mutation's onError alert (useApiQueries.ts) fires instead of the
    // local success-confirmation state — give any pending state update a
    // moment to flush, then assert the confirmation never rendered.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Availability saved ✓')).toBeNull();
  });

  it('caps the Bio input at 120 characters and shows a live "N/120" counter (C3)', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Bio')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Edit Bio'));

    const input = screen.getByLabelText('Bio') as HTMLTextAreaElement;
    expect(input.maxLength).toBe(120);

    // Initial counter reflects the fixture bio's current length.
    expect(
      screen.getByText(`${CHW_PROFILE_FIXTURE.bio.length}/120`),
    ).toBeTruthy();

    // Counter updates live as the draft changes.
    const nextBio = 'A shorter bio.';
    fireEvent.change(input, { target: { value: nextBio } });
    expect(screen.getByText(`${nextBio.length}/120`)).toBeTruthy();
  });
});

describe('CHWProfileScreen — Compliance checklist (Epic D)', () => {
  it('renders all 5 checklist items with their status chips', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Compliance')).toBeTruthy());

    expect(screen.getByText('HIPAA Training')).toBeTruthy();
    expect(screen.getByText('Professional Service Agreement')).toBeTruthy();
    expect(screen.getByText('Professional Liability Insurance')).toBeTruthy();
    expect(screen.getByText('CHW Certification')).toBeTruthy();
    expect(screen.getByText('Background Check')).toBeTruthy();

    // 4 "Missing" chips (the 4 document types) + 1 "Pending" chip (background check).
    expect(screen.getAllByText('Missing').length).toBe(4);
    expect(screen.getByText('Pending')).toBeTruthy();
  });

  it('renders verified/rejected/pending status chips correctly per item', async () => {
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (path === '/chw/profile' && method === 'GET') return CHW_PROFILE_FIXTURE;
      if (path === '/chw/availability' && method === 'GET') return AVAILABILITY_FIXTURE;
      if (path.startsWith('/chw/earnings')) return EARNINGS_FIXTURE;
      if (path.startsWith('/conversations')) return [];
      if (path === '/credentials/checklist' && method === 'GET') {
        return {
          can_work: false,
          missing: ['liability_insurance'],
          items: [
            { code: 'hipaa_training', status: 'verified' },
            { code: 'professional_service_agreement', status: 'pending' },
            { code: 'liability_insurance', status: 'rejected' },
            { code: 'chw_certification', status: 'verified' },
            { code: 'background_check', status: 'clear' },
          ],
        };
      }
      return {};
    });

    renderScreen();

    await waitFor(() => expect(screen.getByText('Compliance')).toBeTruthy());
    expect(screen.getAllByText('Verified').length).toBe(2);
    expect(screen.getByText('Rejected')).toBeTruthy();
    expect(screen.getByText('Clear')).toBeTruthy();
  });

  it('does not show an Upload button for an already-verified item', async () => {
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (path === '/chw/profile' && method === 'GET') return CHW_PROFILE_FIXTURE;
      if (path === '/chw/availability' && method === 'GET') return AVAILABILITY_FIXTURE;
      if (path.startsWith('/chw/earnings')) return EARNINGS_FIXTURE;
      if (path.startsWith('/conversations')) return [];
      if (path === '/credentials/checklist' && method === 'GET') {
        return {
          can_work: false,
          missing: [],
          items: [{ code: 'hipaa_training', status: 'verified' }],
        };
      }
      return {};
    });

    renderScreen();

    await waitFor(() => expect(screen.getByText('Compliance')).toBeTruthy());
    expect(screen.queryByLabelText('Upload HIPAA Training')).toBeNull();
  });

  it('shows a "Re-upload" button (not "Upload") for a rejected item', async () => {
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (path === '/chw/profile' && method === 'GET') return CHW_PROFILE_FIXTURE;
      if (path === '/chw/availability' && method === 'GET') return AVAILABILITY_FIXTURE;
      if (path.startsWith('/chw/earnings')) return EARNINGS_FIXTURE;
      if (path.startsWith('/conversations')) return [];
      if (path === '/credentials/checklist' && method === 'GET') {
        return {
          can_work: false,
          missing: ['hipaa_training'],
          items: [{ code: 'hipaa_training', status: 'rejected' }],
        };
      }
      return {};
    });

    renderScreen();

    const uploadBtn = await screen.findByLabelText('Upload HIPAA Training');
    expect(uploadBtn.textContent).toContain('Re-upload');
  });

  it('renders the guidance link for HIPAA training', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Compliance')).toBeTruthy());
    expect(screen.getByLabelText('Complete free HIPAA training')).toBeTruthy();
  });

  it('shows a "mobile app required" alert instead of attempting upload on web', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    renderScreen();

    const uploadBtn = await screen.findByLabelText('Upload HIPAA Training');
    fireEvent.click(uploadBtn);

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    expect(alertSpy.mock.calls[0][0]).toBe('Mobile app required');
    // No credential submit call should have been attempted.
    expect(mockedApi).not.toHaveBeenCalledWith(
      '/credentials/hipaa_training',
      expect.objectContaining({ method: 'POST' }),
    );
    alertSpy.mockRestore();
  });

  it('does not render the old self-editable background-check chip picker', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Compliance')).toBeTruthy());
    // The old UI exposed radio-role chips labelled "Not Started"/"Clear"/etc.
    // for the CHW to set their own background check status — removed because
    // it let a CHW self-approve. Only the read-only status chip should exist.
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('CHWProfileScreen — Specializations picker (Epic C5: Housing → Utilities)', () => {
  it('offers "Utilities" as a selectable specialization chip, not "Housing"', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Specializations')).toBeTruthy());

    const utilitiesChip = screen.getByLabelText('Utilities');
    expect(utilitiesChip.getAttribute('role')).toBe('checkbox');
    expect(screen.queryByLabelText('Housing')).toBeNull();
  });

  it('still renders a "Housing" chip for a CHW with a legacy housing specialization', async () => {
    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (path === '/chw/profile' && method === 'GET') {
        return { ...CHW_PROFILE_FIXTURE, specializations: ['housing', 'food'] };
      }
      if (path === '/chw/profile' && method === 'PUT') return {};
      if (path === '/chw/availability' && method === 'GET') return AVAILABILITY_FIXTURE;
      if (path === '/chw/availability' && method === 'PUT') return AVAILABILITY_FIXTURE;
      if (path.startsWith('/chw/earnings')) return EARNINGS_FIXTURE;
      if (path.startsWith('/conversations')) return [];
      if (path === '/credentials/checklist' && method === 'GET') return CHECKLIST_FIXTURE_ALL_MISSING;
      return {};
    });

    renderScreen();

    await waitFor(() => expect(screen.getByText('Specializations')).toBeTruthy());

    // The grandfathered chip does not render (ChipRow only renders `items`,
    // and 'housing' is no longer in the offered items list) — but toggling
    // an unrelated chip must not silently drop the CHW's saved 'housing'
    // specialization from the outgoing save payload.
    expect(screen.queryByLabelText('Housing')).toBeNull();

    // Wait for the profile→specializations sync effect to hydrate local
    // state (the fixture's 'food' specialization) before interacting —
    // otherwise a click can race the initial empty useState seed. ChipRow
    // (CHWProfileScreen.tsx) signals "checked" purely via style (background/
    // border/text tinted to the vertical's accent colour) — it does not
    // surface a checkmark glyph or a queryable aria-checked attribute in
    // this jsdom/react-native-web render, so assert on the inactive-chip
    // background colour being replaced.
    await waitFor(() => {
      const el = screen.getByLabelText('Food Security');
      expect(el.getAttribute('style') ?? '').not.toContain('249, 250, 251'); // #F9FAFB inactive bg
    });

    fireEvent.click(screen.getByLabelText('Transportation'));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        '/chw/profile',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );

    const putCalls = mockedApi.mock.calls.filter(
      ([path, init]) => path === '/chw/profile' && (init as RequestInit | undefined)?.method === 'PUT',
    );
    const putCall = putCalls[putCalls.length - 1];
    expect(putCall).toBeTruthy();
    const body = JSON.parse((putCall[1] as RequestInit).body as string);
    expect(body.specializations).toEqual(expect.arrayContaining(['housing', 'food', 'transportation']));
  });
});
