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
// `mockLogout` is hoisted so the Sign-out confirm-modal tests (QA batch #5)
// can assert it was/wasn't called, mirroring the `mockNavigate` pattern used
// in CHWDashboardScreen.test.tsx / CHWMessagesScreen.test.tsx.
const { mockLogout } = vi.hoisted(() => ({ mockLogout: vi.fn() }));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    userName: 'Test CHW',
    logout: mockLogout,
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
  mockLogout.mockClear();
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

describe('CHWProfileScreen — Sign-out confirm modal (QA batch #5)', () => {
  it('does not call logout() immediately on tap — shows an on-brand confirm modal instead', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Sign out of this device')).toBeTruthy());
    fireEvent.click(screen.getByText('Sign out of this device'));

    expect(mockLogout).not.toHaveBeenCalled();
    expect(await screen.findByText('Sign out of this device?')).toBeTruthy();
    expect(
      screen.getByLabelText('Confirm sign out'),
    ).toBeTruthy();
    expect(screen.getByLabelText('Cancel sign out')).toBeTruthy();
  });

  it('Cancel dismisses the modal without calling logout()', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Sign out of this device')).toBeTruthy());
    fireEvent.click(screen.getByText('Sign out of this device'));

    const cancelBtn = await screen.findByLabelText('Cancel sign out');
    fireEvent.click(cancelBtn);

    await waitFor(() => expect(screen.queryByText('Sign out of this device?')).toBeNull());
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it('Confirm calls logout() and dismisses the modal', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Sign out of this device')).toBeTruthy());
    fireEvent.click(screen.getByText('Sign out of this device'));

    const confirmBtn = await screen.findByLabelText('Confirm sign out');
    fireEvent.click(confirmBtn);

    expect(mockLogout).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Sign out of this device?')).toBeNull());
  });
});

describe('CHWProfileScreen — Settings tabs Profile-only (QA batch #7)', () => {
  it('renders only the Profile tab content — no Notifications/Privacy/Language/Help sections', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Profile information')).toBeTruthy());

    expect(screen.queryByText('Notifications')).toBeNull();
    expect(screen.queryByText('Privacy & Security')).toBeNull();
    expect(screen.queryByText('Help & Support')).toBeNull();
    expect(screen.queryByText('New session reminders')).toBeNull();
    expect(screen.queryByText('Two-factor authentication')).toBeNull();
    // "Primary Language" itself is ambiguous — it's ALSO the Profile tab's
    // EditableField label (unaffected by this change) — so assert on the
    // hidden Language tab's radio-picker labels instead, which only render
    // there.
    expect(screen.queryByText('Español')).toBeNull();
    expect(screen.queryByLabelText('中文')).toBeNull();
  });

  it('does not render a tab strip with multiple tabs (single Profile tab is hidden, not shown as one pill)', async () => {
    renderScreen();

    await waitFor(() => expect(screen.getByText('Profile information')).toBeTruthy());

    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByLabelText('Notifications')).toBeNull();
    expect(screen.queryByLabelText('Language')).toBeNull();
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

  it('clicking Upload on web triggers the hidden file input rather than an Alert (QA batch #4)', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    renderScreen();

    const uploadBtn = await screen.findByLabelText('Upload HIPAA Training');
    fireEvent.click(uploadBtn);

    // No "mobile app required" (or any other) Alert should fire — the web
    // path now opens a real file picker instead of blocking.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alertSpy).not.toHaveBeenCalled();
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

describe('CHWProfileScreen — Checklist web upload flow (QA batch #4)', () => {
  // The S3 boundary (the presigned PUT itself) is mocked via global.fetch;
  // everything else (presigned-url POST, credential confirm POST) goes
  // through the same routed `api()` mock the rest of this file uses, so this
  // exercises the real production wiring end-to-end down to the S3 edge.
  const PRESIGNED_URL_FIXTURE = {
    upload_url: 'https://compass-phi-dev.s3.amazonaws.com/users/chw-1/credential/hipaa.pdf?X-Amz-Signature=abc',
    s3_key: 'users/chw-1/credential/hipaa.pdf',
  };

  function makePdfFile(name = 'hipaa-cert.pdf'): File {
    return new File(['%PDF-1.4 fake pdf bytes'], name, { type: 'application/pdf' });
  }

  it('file select -> POST /upload/presigned-url -> PUT with matching content-type -> POST /credentials/{type} confirm', async () => {
    const putCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      putCalls.push({ url: String(url), init: init as RequestInit });
      return new Response(null, { status: 200 });
    });

    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (path === '/chw/profile' && method === 'GET') return CHW_PROFILE_FIXTURE;
      if (path === '/chw/availability' && method === 'GET') return AVAILABILITY_FIXTURE;
      if (path.startsWith('/chw/earnings')) return EARNINGS_FIXTURE;
      if (path.startsWith('/conversations')) return [];
      if (path === '/credentials/checklist' && method === 'GET') return CHECKLIST_FIXTURE_ALL_MISSING;
      if (path === '/upload/presigned-url' && method === 'POST') return PRESIGNED_URL_FIXTURE;
      if (path === '/credentials/hipaa_training' && method === 'POST') {
        return { id: 'cred-1', type: 'hipaa_training', status: 'pending' };
      }
      return {};
    });

    renderScreen();

    const uploadBtn = await screen.findByLabelText('Upload HIPAA Training');
    fireEvent.click(uploadBtn);

    // The click should have focused/opened the hidden <input type="file">.
    // NOTE: ProfilePictureEditor also renders its own hidden file input
    // higher up the tree, so scope the selector to the checklist upload's
    // distinct `accept` list (application/pdf,image/jpeg,image/png) rather
    // than grabbing the first file input in the document.
    const fileInput = document.querySelector(
      'input[type="file"][accept="application/pdf,image/jpeg,image/png"]',
    ) as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    const file = makePdfFile();
    fireEvent.change(fileInput, { target: { files: [file] } });

    // 1. Presigned-url POST fired with the right purpose + content-type.
    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        '/upload/presigned-url',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const presignCall = mockedApi.mock.calls.find(([path]) => path === '/upload/presigned-url');
    expect(presignCall).toBeTruthy();
    const presignBody = JSON.parse((presignCall![1] as RequestInit).body as string);
    expect(presignBody.purpose).toBe('credential');
    expect(presignBody.content_type).toBe('application/pdf');
    expect(presignBody.filename).toBe('hipaa-cert.pdf');

    // 2. Raw PUT to the presigned URL with matching Content-Type — NOT a
    // FormData envelope (a presigned S3 PUT rejects a multipart body).
    await waitFor(() => expect(putCalls.length).toBeGreaterThan(0));
    const put = putCalls[0];
    expect(put.url).toBe(PRESIGNED_URL_FIXTURE.upload_url);
    expect(put.init.method).toBe('PUT');
    expect((put.init.headers as Record<string, string>)['Content-Type']).toBe('application/pdf');
    expect(put.init.body).toBe(file);

    // 3. Confirm/record call — attaches the returned s3_key to the checklist type.
    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        '/credentials/hipaa_training',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const confirmCall = mockedApi.mock.calls.find(([path]) => path === '/credentials/hipaa_training');
    const confirmBody = JSON.parse((confirmCall![1] as RequestInit).body as string);
    expect(confirmBody.s3_key).toBe(PRESIGNED_URL_FIXTURE.s3_key);

    fetchSpy.mockRestore();
  });

  it('shows an "Upload failed" alert and does not call the confirm endpoint when the S3 PUT fails', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(null, { status: 500 }));

    mockedApi.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (path === '/chw/profile' && method === 'GET') return CHW_PROFILE_FIXTURE;
      if (path === '/chw/availability' && method === 'GET') return AVAILABILITY_FIXTURE;
      if (path.startsWith('/chw/earnings')) return EARNINGS_FIXTURE;
      if (path.startsWith('/conversations')) return [];
      if (path === '/credentials/checklist' && method === 'GET') return CHECKLIST_FIXTURE_ALL_MISSING;
      if (path === '/upload/presigned-url' && method === 'POST') return PRESIGNED_URL_FIXTURE;
      return {};
    });

    renderScreen();

    const uploadBtn = await screen.findByLabelText('Upload HIPAA Training');
    fireEvent.click(uploadBtn);

    const fileInput = document.querySelector(
      'input[type="file"][accept="application/pdf,image/jpeg,image/png"]',
    ) as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makePdfFile()] } });

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Upload failed', expect.any(String)));
    expect(mockedApi).not.toHaveBeenCalledWith(
      '/credentials/hipaa_training',
      expect.objectContaining({ method: 'POST' }),
    );

    fetchSpy.mockRestore();
    alertSpy.mockRestore();
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
