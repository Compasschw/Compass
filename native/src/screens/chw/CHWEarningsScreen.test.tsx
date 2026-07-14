/**
 * Component test for CHWEarningsScreen's Stripe payout CTA work gate
 * (QA batch #2, Wave-2 B1).
 *
 * The "Update bank account" / "Set up payouts with Stripe" CTA in the header
 * must disable when the backend CHW work gate is live (`gateEnabled`) AND
 * this CHW currently fails the compliance checklist (`canWork === false`) —
 * mirroring the identical flag-conditional 403 the backend enforces on
 * POST /payments/connect-onboarding. Read-only earnings summaries (the rest
 * of this screen) are never gated — this mirrors the backend leaving
 * GET /account-status ungated.
 *
 * Only the network boundary (`../../api/client`), auth context, and
 * navigation hook are mocked (Tier 2 — jsdom + react-native-web, see
 * native/TESTING.md) — every data hook runs for real against a routed
 * `api()` mock.
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test CHW' }),
}));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
}));

import { api } from '../../api/client';
import { CHWEarningsScreen } from './CHWEarningsScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

const EARNINGS_FIXTURE = {
  this_month: 480,
  all_time: 3200,
  avg_rating: 4.8,
  sessions_this_week: 4,
  pending_payout: 120.5,
  earnings_this_period: 480,
  paid_this_period: 359.5,
  pending_in_transit: false,
  next_payout_date: null,
};

let checklistResponse: {
  can_work: boolean;
  missing: string[];
  items: Array<{ code: string; status: string }>;
  gate_enabled: boolean;
} = { can_work: true, missing: [], items: [], gate_enabled: false };

function routeApi(path: string, options?: { method?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path === '/credentials/checklist' && method === 'GET') return checklistResponse;
  if (path.startsWith('/chw/earnings/sessions')) return [];
  if (path.startsWith('/chw/payouts')) return [];
  if (path.startsWith('/chw/earnings')) return EARNINGS_FIXTURE;
  if (path === '/payments/account-status' && method === 'GET') {
    return {
      account_id: null,
      payouts_enabled: false,
      details_submitted: false,
      requirements_currently_due: ['onboarding not started'],
    };
  }
  if (path.startsWith('/conversations')) return [];

  throw new Error(`Unhandled api() call in CHWEarningsScreen test: ${method} ${path}`);
}

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CHWEarningsScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  checklistResponse = { can_work: true, missing: [], items: [], gate_enabled: false };
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string }) =>
    routeApi(path, options),
  );
});

describe('CHWEarningsScreen — Stripe payouts CTA work gate (QA batch #2)', () => {
  it('CTA stays enabled when the work gate is off, even if can_work is false', async () => {
    checklistResponse = { can_work: false, missing: ['hipaa_training'], items: [], gate_enabled: false };
    renderScreen();

    const btn = await screen.findByLabelText('Set up payouts with Stripe');
    expect(btn.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('CTA stays enabled when can_work is true, even if gate_enabled is true', async () => {
    checklistResponse = { can_work: true, missing: [], items: [], gate_enabled: true };
    renderScreen();

    const btn = await screen.findByLabelText('Set up payouts with Stripe');
    expect(btn.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('CTA is disabled when gate_enabled is true AND can_work is false', async () => {
    checklistResponse = { can_work: false, missing: ['hipaa_training'], items: [], gate_enabled: true };
    renderScreen();

    const btn = await screen.findByLabelText(
      'Set up payouts with Stripe (disabled until your compliance checklist is complete)',
    );
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });

  it('clicking the gated CTA does not call POST /payments/connect-onboarding', async () => {
    checklistResponse = { can_work: false, missing: ['hipaa_training'], items: [], gate_enabled: true };
    renderScreen();

    const btn = await screen.findByLabelText(
      'Set up payouts with Stripe (disabled until your compliance checklist is complete)',
    );
    btn.click();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockedApi).not.toHaveBeenCalledWith(
      '/payments/connect-onboarding',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('read-only earnings summaries still render while the CTA is gated', async () => {
    checklistResponse = { can_work: false, missing: ['hipaa_training'], items: [], gate_enabled: true };
    renderScreen();

    await waitFor(() => expect(screen.getByText('$480.00')).toBeTruthy());
  });
});
