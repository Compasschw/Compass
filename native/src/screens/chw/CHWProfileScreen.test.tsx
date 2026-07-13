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
 *
 * Only the network boundary (`../../api/client`), auth context, and
 * navigation hook are mocked (Tier 2 — jsdom + react-native-web, see
 * native/TESTING.md) — useChwProfile, useChwAvailability, useUpdateChwProfile,
 * useUpdateChwAvailability, and useChwEarnings all run for real against a
 * routed `api()` mock, so this exercises the actual production data-fetching
 * and mutation wiring, not a hand-rolled hook mock.
 */
import React from 'react';
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
});
