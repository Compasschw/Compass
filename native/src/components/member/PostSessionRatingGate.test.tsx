/**
 * Component test for PostSessionRatingGate — the member-wide host for the
 * post-session star-rating prompt (Epic B2), extracted out of MemberHomeScreen
 * so the "How was your session?" modal can overlay on ANY tab the moment a CHW
 * completes the session (detected via React Query refetch), not only on Home.
 *
 * The gate is rendered here IN ISOLATION — deliberately NOT inside
 * MemberHomeScreen or any screen — which is exactly how it's mounted in
 * production (above the member tab navigator in navigation/AppNavigator.tsx).
 * These tests therefore prove the prompt fires with no Home screen present.
 *
 * Only the network boundary (`../../api/client`) is mocked; useMemberProfile,
 * useTestimonialPrompt, and useSubmitTestimonial all run for real against a
 * routed `api()` mock (Tier 2 — jsdom + react-native-web, see native/TESTING.md).
 * ApiError is kept real so PromptDialog's onError branching works as in prod.
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});

import { api, ApiError } from '../../api/client';
import { queryKeys } from '../../hooks/useApiQueries';
import { PostSessionRatingGate } from './PostSessionRatingGate';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MEMBER_USER_ID = 'member-1';
const CHW_ID = 'chw-1';
const CHW_NAME = 'Rosa Gutierrez';

function buildMemberProfileFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    user_id: MEMBER_USER_ID,
    zip_code: '90001',
    primary_language: 'English',
    primary_need: 'housing',
    rewards_balance: 40,
    name: 'Test Member',
    must_change_password: false,
    ...overrides,
  };
}

function buildTestimonialPromptFixture(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    session_id: sessionId,
    chw_id: CHW_ID,
    chw_name: CHW_NAME,
    scheduled_at: '2026-06-20T10:00:00.000Z',
    ...overrides,
  };
}

const RATING_TITLE = `How was your session with ${CHW_NAME}?`;

// ─── API router — the sole network boundary ──────────────────────────────────

let memberProfileFixture: Record<string, unknown> = buildMemberProfileFixture();
/** Controls what GET /testimonials/prompts returns (the session to rate, or null). */
let testimonialPromptResponse: unknown = null;
/** Controls what POST /sessions/{id}/testimonials does for the next call. */
let submitTestimonialBehavior: 'success' | 'error' = 'success';
let submitTestimonialRequestBodies: Array<{ rating: number; text: string | null }> = [];

function routeApi(path: string, options?: { method?: string; body?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path === '/member/profile' && method === 'GET') {
    return memberProfileFixture;
  }
  if (path === '/testimonials/prompts' && method === 'GET') {
    return testimonialPromptResponse;
  }
  if (path.endsWith('/testimonials') && method === 'POST') {
    const body = JSON.parse(options?.body ?? '{}') as { rating: number; text: string | null };
    submitTestimonialRequestBodies.push(body);
    if (submitTestimonialBehavior === 'error') {
      throw new ApiError(500, 'Could not submit your rating.');
    }
    // Mirror the backend: once rated, the session is no longer returned by
    // GET /testimonials/prompts, so the mutation's invalidation clears the
    // prompt. Flip the fixture to null so the refetch reflects that.
    testimonialPromptResponse = null;
    return {
      id: 'testimonial-1',
      chw_id: CHW_ID,
      member_id: MEMBER_USER_ID,
      session_id: 'sess-rated-1',
      rating: body.rating,
      text: body.text,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
  }

  throw new Error(`Unhandled api() call in PostSessionRatingGate test: ${method} ${path}`);
}

// ─── Harness ──────────────────────────────────────────────────────────────────

function renderGate() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <PostSessionRatingGate />
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

function selectStar(count: number): void {
  fireEvent.click(screen.getByLabelText(`${count} star${count === 1 ? '' : 's'}`));
}

beforeEach(() => {
  memberProfileFixture = buildMemberProfileFixture();
  testimonialPromptResponse = null;
  submitTestimonialBehavior = 'success';
  submitTestimonialRequestBodies = [];
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string; body?: string }) =>
    routeApi(path, options),
  );
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PostSessionRatingGate — post-session star-rating prompt (Epic B2)', () => {
  it('opens the rating modal for a completed+unrated session — with no Home screen mounted', async () => {
    // Distinct session id per test: the "Maybe later" dismissal Set is
    // module-level (cleared only on JS reload), so it persists across tests
    // within this file's single module instance.
    testimonialPromptResponse = buildTestimonialPromptFixture('gate-b2-1');

    renderGate();

    expect(await screen.findByText(RATING_TITLE)).toBeTruthy();
    expect(screen.getByLabelText('Your rating')).toBeTruthy();
    expect(screen.getByLabelText('Tell us more (optional)')).toBeTruthy();
  });

  it('renders nothing when GET /testimonials/prompts returns null', async () => {
    testimonialPromptResponse = null;

    renderGate();

    await waitFor(() => {
      expect(mockedApi.mock.calls.some(([path]) => path === '/testimonials/prompts')).toBe(true);
    });
    expect(screen.queryByText(/How was your session with/)).toBeNull();
  });

  it('submits the star rating + text to POST /sessions/{id}/testimonials, then clears', async () => {
    const sessionId = 'gate-b2-2';
    testimonialPromptResponse = buildTestimonialPromptFixture(sessionId);

    renderGate();

    await screen.findByText(RATING_TITLE);
    selectStar(5);
    fireEvent.change(screen.getByLabelText('Tell us more (optional)'), {
      target: { value: 'Really helpful session.' },
    });
    fireEvent.click(screen.getByLabelText('Submit'));

    await waitFor(() => {
      expect(submitTestimonialRequestBodies).toEqual([
        { rating: 5, text: 'Really helpful session.' },
      ]);
    });
    await waitFor(() => {
      expect(
        mockedApi.mock.calls.some(
          ([path, opts]) =>
            path === `/sessions/${sessionId}/testimonials` &&
            (opts as { method?: string })?.method === 'POST',
        ),
      ).toBe(true);
    });
    // On success the mutation invalidates the prompts query; the backend now
    // returns null (session rated), so the modal clears.
    await waitFor(() => {
      expect(screen.queryByText(RATING_TITLE)).toBeNull();
    });
  });

  it('requires a star rating before submit (does not call the API without one)', async () => {
    testimonialPromptResponse = buildTestimonialPromptFixture('gate-b2-3');

    renderGate();

    await screen.findByText(RATING_TITLE);
    fireEvent.click(screen.getByLabelText('Submit'));

    expect(await screen.findByText('Please select a star rating.')).toBeTruthy();
    expect(
      mockedApi.mock.calls.some(([path]) => path === '/sessions/gate-b2-3/testimonials'),
    ).toBe(false);
  });

  it('"Maybe later" suppresses that session for the rest of the app session (no re-open on refetch)', async () => {
    const sessionId = 'gate-b2-4';
    testimonialPromptResponse = buildTestimonialPromptFixture(sessionId);

    const { qc } = renderGate();

    await screen.findByText(RATING_TITLE);
    fireEvent.click(screen.getByLabelText('Maybe later'));

    await waitFor(() => {
      expect(screen.queryByText(RATING_TITLE)).toBeNull();
    });
    expect(
      mockedApi.mock.calls.some(([path]) => (path as string).endsWith('/testimonials') &&
        (path as string).startsWith('/sessions/')),
    ).toBe(false);

    // A refetch that still returns the SAME dismissed session must NOT re-open
    // the modal — "Maybe later" holds for this app session.
    await qc.invalidateQueries({ queryKey: queryKeys.testimonialPrompt });
    await waitFor(() => {
      expect(mockedApi.mock.calls.filter(([p]) => p === '/testimonials/prompts').length).toBeGreaterThan(1);
    });
    expect(screen.queryByText(RATING_TITLE)).toBeNull();
  });

  it('re-prompts for a DIFFERENT completed session after an earlier one was dismissed', async () => {
    testimonialPromptResponse = buildTestimonialPromptFixture('gate-b2-5a');

    const { qc } = renderGate();

    await screen.findByText(RATING_TITLE);
    fireEvent.click(screen.getByLabelText('Maybe later'));
    await waitFor(() => {
      expect(screen.queryByText(RATING_TITLE)).toBeNull();
    });

    // A NEW session completes (distinct id). The gate must offer it even
    // though an earlier session was dismissed this app session.
    testimonialPromptResponse = buildTestimonialPromptFixture('gate-b2-5b');
    await qc.invalidateQueries({ queryKey: queryKeys.testimonialPrompt });

    expect(await screen.findByText(RATING_TITLE)).toBeTruthy();
  });

  it('surfaces a non-blocking inline error on submit failure and keeps the modal open', async () => {
    testimonialPromptResponse = buildTestimonialPromptFixture('gate-b2-6');
    submitTestimonialBehavior = 'error';

    renderGate();

    await screen.findByText(RATING_TITLE);
    selectStar(3);
    fireEvent.click(screen.getByLabelText('Submit'));

    expect(await screen.findByText('Could not submit your rating.')).toBeTruthy();
    // A failed submit is not fatal/blocking — the modal stays open to retry.
    expect(screen.getByText(RATING_TITLE)).toBeTruthy();
  });

  it('the mandatory first-login password gate still suppresses the rating modal', async () => {
    memberProfileFixture = buildMemberProfileFixture({ must_change_password: true });
    testimonialPromptResponse = buildTestimonialPromptFixture('gate-b2-7');

    renderGate();

    // Wait for the profile query to resolve (it drives mustChangePassword).
    await waitFor(() => {
      expect(mockedApi.mock.calls.some(([path]) => path === '/member/profile')).toBe(true);
    });
    // The rating modal must never show while the mandatory gate is required,
    // even though GET /testimonials/prompts returned a session to prompt.
    await waitFor(() => {
      expect(screen.queryByText(RATING_TITLE)).toBeNull();
    });
  });
});
