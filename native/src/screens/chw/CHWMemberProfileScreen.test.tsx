/**
 * Component test for CHWMemberProfileScreen's dynamic "Back to …" web
 * header link (Epic S).
 *
 * The link used to be hard-wired to "Back to Members" → the CHWMembers tab
 * regardless of where the CHW navigated from (Map, Dashboard, Messages,
 * …). It now reads `backLabel`/`backTo` route params (set by the calling
 * screen — see CHWMembersScreen.test.tsx / CHWMapScreen.test.tsx /
 * CHWDashboardScreen.test.tsx for the call-site assertions) and falls back
 * to the original "Back to Members" → CHWMembers behavior when either is
 * absent, so every existing/not-yet-updated entry path (including
 * CHWMessagesScreen, out of scope for this change) keeps working exactly
 * as before.
 *
 * Only the network boundary (`../../api/client`), auth context, and
 * navigation hooks (`useNavigation`/`useRoute`) are mocked — the member
 * profile's own data hooks (useMemberDetail, useAssessmentLatest,
 * useMemberServicesConsent, useMemberBillingStatus, useFlagNote,
 * useChwBillableUnits, useJourneyTemplates, useMemberJourneys,
 * useMemberRewardsBalance, useCaseNotes, useSessionNotes,
 * useMemberDocuments) all run for real against a routed `api()` mock —
 * Tier 2 (jsdom + react-native-web, see native/TESTING.md).
 *
 * Also covers Wave-2 #25 — the Screening Results card/modal now hosts an
 * EDITABLE AssessmentForm (seeded via useAssessmentBootstrap's session-less
 * resume) instead of a read-only response list, with a "Start screening"
 * path when no assessment exists yet.
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ userName: 'Test CHW', logout: vi.fn() }),
}));
// See CHWMessagesScreen.test.tsx for why this needs a full literal
// replacement rather than `importOriginal` — @react-navigation/native's real
// barrel drags in an extension-less import that jsdom/vite-node can't
// resolve. CHWMemberProfileScreen only uses `useNavigation`, `useRoute`
// (plus the type-only `RouteProp`, erased at compile time) from this
// package. `mockNavigate` is hoisted so every `useNavigation()` call
// returns the SAME spy, and `routeParams` is a mutable module-level object
// each test overwrites before rendering, so `useRoute()` reflects whatever
// params that test wants to simulate the caller having passed.
const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
let routeParams: Record<string, unknown> = {};
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
  useRoute: () => ({ params: routeParams }),
}));

import { api } from '../../api/client';
import { CHWMemberProfileScreen } from './CHWMemberProfileScreen';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MEMBER_ID = 'member-1';
const MEMBER_NAME = 'Maria Lopez';

const memberDetailFixture = {
  id: MEMBER_ID,
  first_name: 'Maria',
  last_name: 'Lopez',
  profile_picture_url: null,
  preferred_name: null,
  phone_e164: '+15551234567',
  email: 'maria@example.com',
  primary_language: 'English',
  additional_languages: [],
  address: '123 Main St',
  city: 'Fresno',
  zip_code: '93701',
  mco: null,
  address_line1: '123 Main St',
  address_line2: null,
  city_name: 'Fresno',
  state: 'CA',
  ecm_eligible: false,
  primary_categories: [],
  resource_needs: [],
  resource_need_levels: [],
  billing_units: {
    today_used: 0,
    today_remaining: 4,
    yearly_used: 0,
    yearly_remaining: 200,
  },
  session_count: 0,
  last_session_at: null,
  open_goals: [],
  open_followups: [],
  consent_status: { ai_transcription: 'none', session_recording: 'none' },
  recent_sessions: [],
  date_of_birth: '1990-01-01',
  gender: 'Female',
  medi_cal_id: null,
  closure_status: null,
  closure_reason: null,
  closed_at: null,
};

// Mutable per-test override for the closure-review POST — lets individual
// tests simulate success (default) vs. failure without a new mock harness.
let closureReviewResponder: (body: unknown) => unknown = () => ({
  id: 'testimonial-b3-1',
  member_id: MEMBER_ID,
  chw_id: 'chw-1',
  text: 'ok',
  status: 'pending',
  source: 'account_closure',
  created_at: '2026-07-13T00:00:00Z',
});

// ─── Wave-2 #25/#26 — Screening Results fixtures ───────────────────────────

const ASSESSMENT_ID = 'assess-1';
const TEMPLATE_ID = 'compass_member_v1';

const assessmentTemplateFixture = {
  id: TEMPLATE_ID,
  name: 'Compass Member Assessment',
  total_questions: 1,
  sections: [{ id: 'sec1', title: 'Housing', part: 1, part_label: 'Part 1', category: 'housing' }],
  questions: [
    {
      id: 'q1',
      section_id: 'sec1',
      source_q_num: 1,
      text: 'Do you have stable housing?',
      category: 'housing',
      subcategory: 'stability',
      tags: [],
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    },
  ],
};

// Mutable per-test override for GET /chw/members/{id}/assessments/latest —
// null (the default) means "no completed assessment yet" (404), matching
// the pre-existing fixture behavior. Set to an object to simulate an
// existing completed assessment with saved answers.
let assessmentLatestResponder: () => unknown = () => null;

// Mutable per-test override for POST /chw/members/{id}/assessments (the
// Wave-2 #26 session-less start/resume endpoint) — lets tests simulate
// resuming prior in_progress answers via `responses`.
let memberAssessmentStartResponder: () => unknown = () => ({
  id: ASSESSMENT_ID,
  status: 'in_progress',
  template_id: TEMPLATE_ID,
  session_id: null,
  member_id: MEMBER_ID,
});

function routeApi(path: string, options?: { method?: string; body?: string }): unknown {
  const method = options?.method ?? 'GET';

  if (path === `/chw/members/${MEMBER_ID}` && method === 'GET') {
    return memberDetailFixture;
  }
  if (path === `/chw/members/${MEMBER_ID}/close` && method === 'POST') {
    return {
      member_id: MEMBER_ID,
      closure_status: 'closed_successful',
      closure_reason: 'successfully_completed',
      closed_at: '2026-07-13T00:00:00Z',
    };
  }
  if (path === `/chw/members/${MEMBER_ID}/closure-review` && method === 'POST') {
    const body = options?.body ? JSON.parse(options.body) : {};
    return closureReviewResponder(body);
  }
  if (path === `/chw/members/${MEMBER_ID}/assessments/latest` && method === 'GET') {
    const latest = assessmentLatestResponder();
    if (latest == null) {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    }
    return latest;
  }
  if (path === `/assessment-templates/${TEMPLATE_ID}` && method === 'GET') {
    return assessmentTemplateFixture;
  }
  // Wave-2 #26 — session-less start/resume, called when the CHW taps
  // "Start screening" / "Edit answers" on the profile's Screening Results card.
  if (path === `/chw/members/${MEMBER_ID}/assessments` && method === 'POST') {
    return memberAssessmentStartResponder();
  }
  if (path === `/assessments/${ASSESSMENT_ID}/responses` && method === 'POST') {
    return {};
  }
  if (path === `/assessments/${ASSESSMENT_ID}/complete` && method === 'POST') {
    return {};
  }
  if (path === `/member/services-consent?member_id=${MEMBER_ID}` && method === 'GET') {
    return { value: null, changed_at: null, last_changed_by: null };
  }
  if (path === `/members/${MEMBER_ID}/billing-status` && method === 'GET') {
    return { is_billable: true, changed_at: null, changed_by: null };
  }
  if (path === `/members/${MEMBER_ID}/flag-note` && method === 'GET') {
    return null;
  }
  if (path === `/chw/members/${MEMBER_ID}/billable-units` && method === 'GET') {
    return {
      daily: { used: 0, limit: 4, remaining: 4 },
      yearly: { used: 0, limit: 200, remaining: 200 },
      as_of_la_local_date: '2026-07-12',
    };
  }
  if (path === '/journeys/templates' && method === 'GET') {
    return [];
  }
  if (path === `/members/${MEMBER_ID}/journeys` && method === 'GET') {
    return [];
  }
  if (path === `/members/${MEMBER_ID}/rewards/balance` && method === 'GET') {
    return {
      member_id: MEMBER_ID,
      current_balance: 0,
      earned_lifetime: 0,
      redeemed_lifetime: 0,
      next_unlock_item: null,
      points_to_next: 0,
    };
  }
  if (path.startsWith(`/members/${MEMBER_ID}/case-notes`) && method === 'GET') {
    return { items: [], total: 0, limit: 50, offset: 0 };
  }
  if (path === `/chw/members/${MEMBER_ID}/session-notes` && method === 'GET') {
    return [];
  }
  if (path.startsWith(`/members/${MEMBER_ID}/documents`) && method === 'GET') {
    return { items: [], total: 0, page: 1, page_size: 50 };
  }

  throw new Error(`Unhandled api() call in CHWMemberProfileScreen test: ${method} ${path}`);
}

// ─── Harness ──────────────────────────────────────────────────────────────────

function renderScreen() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CHWMemberProfileScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  routeParams = { memberId: MEMBER_ID };
  mockNavigate.mockClear();
  mockedApi.mockReset();
  closureReviewResponder = () => ({
    id: 'testimonial-b3-1',
    member_id: MEMBER_ID,
    chw_id: 'chw-1',
    text: 'ok',
    status: 'pending',
    source: 'account_closure',
    created_at: '2026-07-13T00:00:00Z',
  });
  assessmentLatestResponder = () => null;
  memberAssessmentStartResponder = () => ({
    id: ASSESSMENT_ID,
    status: 'in_progress',
    template_id: TEMPLATE_ID,
    session_id: null,
    member_id: MEMBER_ID,
  });
  mockedApi.mockImplementation(
    async (path: string, options?: { method?: string; body?: string }) => routeApi(path, options),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CHWMemberProfileScreen — dynamic "Back to …" link (Epic S)', () => {
  it('defaults to "Back to Members" and navigates to CHWMembers when no backLabel/backTo params are passed', async () => {
    // No backLabel/backTo — mirrors an entry path that hasn't been updated
    // (e.g. Messages, out of scope for this change) or any caller that
    // simply omits them.
    routeParams = { memberId: MEMBER_ID };
    renderScreen();

    await waitFor(() => expect(screen.getByText(MEMBER_NAME)).toBeTruthy());

    const backLink = screen.getByLabelText('Back to Members');
    expect(backLink).toBeTruthy();
    expect(screen.getByText('Back to Members')).toBeTruthy();

    backLink.click();
    expect(mockNavigate).toHaveBeenCalledWith('CHWMembers');
  });

  it('renders "Back to Map" and navigates to Map when backLabel="Map"/backTo="Map" are passed', async () => {
    routeParams = { memberId: MEMBER_ID, backLabel: 'Map', backTo: 'Map' };
    renderScreen();

    await waitFor(() => expect(screen.getByText(MEMBER_NAME)).toBeTruthy());

    expect(screen.queryByText('Back to Members')).toBeNull();
    const backLink = screen.getByLabelText('Back to Map');
    expect(backLink).toBeTruthy();
    expect(screen.getByText('Back to Map')).toBeTruthy();

    backLink.click();
    expect(mockNavigate).toHaveBeenCalledWith('Map');
  });

  it('renders "Back to Dashboard" and navigates to DashboardStack when backLabel="Dashboard"/backTo="DashboardStack" are passed', async () => {
    routeParams = { memberId: MEMBER_ID, backLabel: 'Dashboard', backTo: 'DashboardStack' };
    renderScreen();

    await waitFor(() => expect(screen.getByText(MEMBER_NAME)).toBeTruthy());

    const backLink = screen.getByLabelText('Back to Dashboard');
    expect(backLink).toBeTruthy();

    backLink.click();
    expect(mockNavigate).toHaveBeenCalledWith('DashboardStack');
  });

  // Regression (QA batch 2026-07-14, Part 5): "Back to Dashboard" used to be
  // a dead button because `backTo="Dashboard"` doesn't match the registered
  // `DashboardStack` route, so `navigate()` silently no-op'd. Stale
  // params/deep links may still carry the legacy value — the alias in
  // CHWMemberProfileScreen must translate it so the button always works.
  it('aliases legacy backTo="Dashboard" to DashboardStack (regression: dead "Back to Dashboard" button)', async () => {
    routeParams = { memberId: MEMBER_ID, backLabel: 'Dashboard', backTo: 'Dashboard' };
    renderScreen();

    await waitFor(() => expect(screen.getByText(MEMBER_NAME)).toBeTruthy());

    const backLink = screen.getByLabelText('Back to Dashboard');
    expect(backLink).toBeTruthy();

    backLink.click();
    expect(mockNavigate).toHaveBeenCalledWith('DashboardStack');
  });
});

// ─── Epic B3: post-close member review capture ────────────────────────────────

/** Drives the Confirm Close modal to completion: opens it, picks a status +
 * reason, and clicks Confirm. Returns once the close POST has resolved and
 * the modal has dismissed (i.e. right as the closure-review prompt should
 * appear).
 */
async function closeMemberViaModal(): Promise<void> {
  fireEvent.click(screen.getByLabelText(`Close ${MEMBER_NAME}`));

  fireEvent.click(screen.getByLabelText('Status: Select Status…'));
  fireEvent.click(screen.getByLabelText('Closed - Successful'));

  fireEvent.click(screen.getByLabelText('Reason: Select Reason…'));
  fireEvent.click(screen.getByLabelText('Successfully Completed'));

  fireEvent.click(screen.getByLabelText('Confirm close'));

  await waitFor(() =>
    expect(mockedApi).toHaveBeenCalledWith(
      `/chw/members/${MEMBER_ID}/close`,
      expect.objectContaining({ method: 'POST' }),
    ),
  );
}

describe('CHWMemberProfileScreen — post-close parting feedback prompt (Epic B3)', () => {
  it('shows the closure-review prompt with a 120-char-capped field after a successful close', async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByText(MEMBER_NAME)).toBeTruthy());

    await closeMemberViaModal();

    await waitFor(() =>
      expect(
        screen.getByLabelText(
          "Member's parting feedback about their experience with their CHW — optional",
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByLabelText('Save feedback')).toBeTruthy();
    expect(screen.getByLabelText('Skip')).toBeTruthy();

    const field = screen.getByLabelText(
      "Member's parting feedback about their experience with their CHW — optional",
    ) as HTMLTextAreaElement;
    expect(field.maxLength).toBe(120);
  });

  it('Save posts the entered text to the closure-review endpoint and dismisses the prompt', async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByText(MEMBER_NAME)).toBeTruthy());

    await closeMemberViaModal();

    const field = await screen.findByLabelText(
      "Member's parting feedback about their experience with their CHW — optional",
    );
    fireEvent.change(field, { target: { value: 'My CHW was wonderful.' } });
    fireEvent.click(screen.getByLabelText('Save feedback'));

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        `/chw/members/${MEMBER_ID}/closure-review`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ text: 'My CHW was wonderful.' }),
        }),
      ),
    );

    await waitFor(() =>
      expect(
        screen.queryByLabelText(
          "Member's parting feedback about their experience with their CHW — optional",
        ),
      ).toBeNull(),
    );
  });

  it('Skip closes the prompt without ever calling the closure-review endpoint', async () => {
    renderScreen();
    await waitFor(() => expect(screen.getByText(MEMBER_NAME)).toBeTruthy());

    await closeMemberViaModal();

    await screen.findByLabelText(
      "Member's parting feedback about their experience with their CHW — optional",
    );
    fireEvent.click(screen.getByLabelText('Skip'));

    await waitFor(() =>
      expect(
        screen.queryByLabelText(
          "Member's parting feedback about their experience with their CHW — optional",
        ),
      ).toBeNull(),
    );
    expect(mockedApi).not.toHaveBeenCalledWith(
      `/chw/members/${MEMBER_ID}/closure-review`,
      expect.anything(),
    );
  });

  it('shows a non-blocking inline error on a failed save, without re-opening/blocking the (already closed) member', async () => {
    closureReviewResponder = () => {
      throw Object.assign(new Error('Internal Server Error'), { status: 500 });
    };
    renderScreen();
    await waitFor(() => expect(screen.getByText(MEMBER_NAME)).toBeTruthy());

    await closeMemberViaModal();

    const field = await screen.findByLabelText(
      "Member's parting feedback about their experience with their CHW — optional",
    );
    fireEvent.change(field, { target: { value: 'Feedback that will fail to save' } });
    fireEvent.click(screen.getByLabelText('Save feedback'));

    await waitFor(() =>
      expect(screen.getByText('Could not save feedback. You can retry or skip.')).toBeTruthy(),
    );
    // The prompt stays open (not blocking navigation/other actions) so the
    // CHW can retry or skip — it does NOT re-trigger or undo the close.
    expect(
      screen.getByLabelText(
        "Member's parting feedback about their experience with their CHW — optional",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText('Skip')).toBeTruthy();
  });
});

// ─── Wave-2 #25 — editable Screening Results from the profile ─────────────────

describe('CHWMemberProfileScreen — Screening Results card (Wave-2 #25/#26)', () => {
  it('"Start screening" when no assessment exists starts one via the session-less endpoint and renders the form', async () => {
    // Default assessmentLatestResponder returns null (404) — no assessment yet.
    renderScreen();
    await waitFor(() => expect(screen.getByText(MEMBER_NAME)).toBeTruthy());

    fireEvent.click(screen.getByText('Screening Results'));
    await screen.findByText('No screening completed for this member yet.');

    fireEvent.click(screen.getByLabelText('Start screening'));

    // Bootstraps via the member-scoped (session-less) start endpoint, then
    // renders the real AssessmentForm — proves the "Start screening" path
    // uses the same session-less mechanism as the Messages panel.
    await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });
    expect(mockedApi).toHaveBeenCalledWith(
      `/chw/members/${MEMBER_ID}/assessments`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('renders a compact read-only summary strip + editable form seeded with the member\'s saved answers, and saves', async () => {
    assessmentLatestResponder = () => ({
      id: ASSESSMENT_ID,
      completed_at: '2026-07-10T12:00:00Z',
      response_counts: {},
      responses: [
        {
          question_id: 'q1',
          question_text: 'Do you have stable housing?',
          answer_value: 'yes',
          answer_label: 'Yes',
        },
      ],
    });
    memberAssessmentStartResponder = () => ({
      id: ASSESSMENT_ID,
      status: 'in_progress',
      template_id: TEMPLATE_ID,
      session_id: null,
      member_id: MEMBER_ID,
      responses: [
        {
          id: 'resp-1',
          question_id: 'q1',
          answer_value: 'yes',
          answer_label: 'Yes',
          skipped: false,
          captured_at: '2026-07-10T12:00:00Z',
        },
      ],
    });

    renderScreen();
    await waitFor(() => expect(screen.getByText(MEMBER_NAME)).toBeTruthy());

    fireEvent.click(screen.getByText('Screening Results'));

    // Compact read-only summary strip up top.
    await screen.findByText(/1 answered · last updated/);

    // Editing seeds the form with the prior answer via resume hydration —
    // proves the same initialAnswers mechanism InlineSdohPanel uses.
    fireEvent.click(screen.getByLabelText('Edit answers'));
    await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });
    expect(mockedApi).toHaveBeenCalledWith(
      `/chw/members/${MEMBER_ID}/assessments`,
      expect.objectContaining({ method: 'POST' }),
    );

    // The prior answer ('Yes') is pre-selected — changing it to 'No' still
    // posts through the same persistence endpoint AssessmentForm always used.
    const noOption = screen.getByLabelText('No');
    fireEvent.click(noOption);

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/assessments/${ASSESSMENT_ID}/responses`,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"answer_value":"no"'),
        }),
      );
    });
  });

  // QA batch (2026-07-14) Part 10 — regression. Before the fix, the backend
  // 404'd for an in_progress-only assessment, so this exact fixture used to
  // render "No screening completed for this member yet." even though the
  // CHW had already saved a partial answer. It must now render the
  // answered-so-far responses with an "In progress · N answered" strip and
  // a "Continue screening" action, never the "No screening completed" copy.
  it('renders answered-so-far responses + "Continue screening" for an in_progress assessment (never "No screening completed")', async () => {
    assessmentLatestResponder = () => ({
      id: ASSESSMENT_ID,
      status: 'in_progress',
      completed_at: null,
      response_counts: {},
      responses: [
        {
          question_id: 'q1',
          question_text: 'Do you have stable housing?',
          answer_value: 'yes',
          answer_label: 'Yes',
        },
      ],
    });

    renderScreen();
    await waitFor(() => expect(screen.getByText(MEMBER_NAME)).toBeTruthy());

    fireEvent.click(screen.getByText('Screening Results'));

    await screen.findByText('In progress · 1 answered');
    expect(screen.queryByText('No screening completed for this member yet.')).toBeNull();
    expect(screen.getByText('Do you have stable housing?')).toBeTruthy();
    expect(screen.getByText('Yes')).toBeTruthy();

    const continueButton = screen.getByLabelText('Continue screening');
    expect(continueButton).toBeTruthy();
    expect(screen.queryByLabelText('Edit answers')).toBeNull();

    // "Continue screening" resumes via the same session-less bootstrap.
    fireEvent.click(continueButton);
    await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });
    expect(mockedApi).toHaveBeenCalledWith(
      `/chw/members/${MEMBER_ID}/assessments`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
