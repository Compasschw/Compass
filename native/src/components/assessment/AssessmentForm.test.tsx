/**
 * Component test for AssessmentForm — focused unit coverage for Epic W2
 * (per-question Skip) and Epic W3 (partial save + resume hydration via the
 * `initialAnswers` prop), plus a regression check that a normal answer tap
 * still behaves exactly as before either feature existed.
 *
 * Only the network boundary (`../../api/client`) is mocked; the real
 * component tree (including react-query, since AssessmentForm calls
 * useQueryClient()) renders and drives interactions.
 * Tier 2 — jsdom + react-native-web (see native/TESTING.md).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, api: vi.fn() };
});
import { api } from '../../api/client';
import { AssessmentForm, type AssessmentFormInitialAnswer } from './AssessmentForm';
import { colors } from '../../theme/colors';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

/**
 * lucide-react-native is stubbed (see vitest.setup.ts) to a single IconStub
 * that renders a bare `<svg>` with every prop it was given spread onto it —
 * regardless of which icon name was imported. That means we can't tell
 * CheckCircle apart from Circle by tag, but AssessmentForm passes a
 * different `color` per selected state, so reading the stub svg's `color`
 * attribute is a reliable, implementation-light way to assert selection
 * state without depending on react-native-web's (here, non-functional)
 * accessibilityState → aria-* mapping.
 */
function iconColor(optionElement: Element): string | null {
  return optionElement.querySelector('svg')?.getAttribute('color') ?? null;
}

const ASSESSMENT_ID = 'assess-1';

// A single section with three questions so progress math ("X of 3 questions")
// is easy to reason about, and so a skip on one question doesn't affect the
// answered/unanswered state of its neighbors.
const template = {
  id: 'compass_member_v1',
  name: 'Compass Member Assessment',
  total_questions: 3,
  sections: [
    { id: 'sec1', title: 'Housing & Food', part: 1, part_label: 'Part 1', category: 'sdoh' },
  ],
  questions: [
    {
      id: 'housing_situation',
      section_id: 'sec1',
      source_q_num: 1,
      text: 'Do you have stable housing?',
      category: 'sdoh',
      subcategory: 'housing',
      tags: [],
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    },
    {
      id: 'food_insecurity',
      section_id: 'sec1',
      source_q_num: 2,
      text: 'Were you worried food would run out?',
      category: 'sdoh',
      subcategory: 'food_access',
      tags: [],
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    },
    {
      id: 'transportation_barrier',
      section_id: 'sec1',
      source_q_num: 3,
      text: 'Has transportation kept you from appointments?',
      category: 'sdoh',
      subcategory: 'transportation',
      tags: [],
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    },
  ],
};

function routeApi(path: string, options?: { method?: string }): unknown {
  const method = options?.method ?? 'GET';
  if (path === `/assessments/${ASSESSMENT_ID}/responses` && method === 'POST') return {};
  if (path === `/assessments/${ASSESSMENT_ID}/complete` && method === 'POST') return {};
  throw new Error(`Unhandled api() call: ${method} ${path}`);
}

function renderForm(opts: {
  initialAnswers?: AssessmentFormInitialAnswer[];
  onComplete?: () => void;
  onPause?: () => void;
} = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onComplete = opts.onComplete ?? vi.fn();
  const onPause = opts.onPause ?? vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <AssessmentForm
        assessmentId={ASSESSMENT_ID}
        template={template as any}
        onComplete={onComplete}
        onPause={onPause}
        initialAnswers={opts.initialAnswers}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onComplete, onPause };
}

beforeEach(() => {
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string }) => routeApi(path, options));
});

afterEach(() => {
  vi.clearAllMocks();
});

function lastPostBody(): Record<string, unknown> {
  const call = mockedApi.mock.calls
    .filter((args: unknown[]) => args[0] === `/assessments/${ASSESSMENT_ID}/responses`)
    .pop();
  return JSON.parse((call as [string, { body: string }])[1].body);
}

describe('AssessmentForm — normal answer (regression)', () => {
  it('tapping an option still POSTs a real, non-skipped answer exactly as before', async () => {
    renderForm();
    await screen.findByText('Do you have stable housing?');

    fireEvent.click(screen.getAllByLabelText('Yes')[0]);

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/assessments/${ASSESSMENT_ID}/responses`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const payload = lastPostBody();
    expect(payload).toMatchObject({
      question_id: 'housing_situation',
      answer_value: 'yes',
      answer_label: 'Yes',
      skipped: false,
    });

    // Progress advances to 1 of 3.
    expect(screen.getByText(/1 of 3 questions/)).toBeTruthy();
  });
});

describe('AssessmentForm — Epic W2 per-question Skip', () => {
  it('tapping "Skip this question" persists a skipped response distinct from a real answer and advances progress', async () => {
    renderForm();
    await screen.findByText('Do you have stable housing?');

    // Sanity: progress starts at 0 of 3.
    expect(screen.getByText(/0 of 3 questions/)).toBeTruthy();

    const skipButtons = screen.getAllByLabelText('Skip this question');
    fireEvent.click(skipButtons[0]);

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/assessments/${ASSESSMENT_ID}/responses`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const payload = lastPostBody();
    expect(payload).toMatchObject({
      question_id: 'housing_situation',
      answer_value: 'skipped',
      answer_label: 'Skipped',
      skipped: true,
    });

    // Skip counts toward progress exactly like a real answer.
    await waitFor(() => expect(screen.getByText(/1 of 3 questions/)).toBeTruthy());

    // The skip row now reads "Skipped" and neither real option is selected.
    await screen.findByText('Skipped');
    const yesOption = screen.getAllByLabelText('Yes')[0];
    expect(iconColor(yesOption)).toBe(colors.mutedForeground);
  });

  it('answering a question after it was skipped overwrites the skip (un-skips it)', async () => {
    renderForm();
    await screen.findByText('Do you have stable housing?');

    fireEvent.click(screen.getAllByLabelText('Skip this question')[0]);
    await waitFor(() => expect(screen.getByText(/1 of 3 questions/)).toBeTruthy());

    fireEvent.click(screen.getAllByLabelText('No')[0]);

    await waitFor(() => {
      const payload = lastPostBody();
      expect(payload).toMatchObject({
        question_id: 'housing_situation',
        answer_value: 'no',
        skipped: false,
      });
    });

    // Still only 1 of 3 — the question moved from skipped to answered, it
    // wasn't double-counted.
    expect(screen.getByText(/1 of 3 questions/)).toBeTruthy();
  });
});

describe('AssessmentForm — Save & Close affordance (Epic W3)', () => {
  it('renders a "Save & Close" button that calls onPause without any API call', async () => {
    const onPause = vi.fn();
    renderForm({ onPause });
    await screen.findByText('Do you have stable housing?');

    expect(screen.getByText('Save & Close')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Save and close assessment'));

    expect(onPause).toHaveBeenCalledTimes(1);
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it('shows a helper caption explaining answers save automatically', async () => {
    renderForm();
    await screen.findByText('Do you have stable housing?');
    expect(screen.getByText(/save automatically/i)).toBeTruthy();
  });
});

describe('AssessmentForm — Epic W3 resume hydration via initialAnswers', () => {
  it('seeds prior answered and skipped state on mount without issuing any POSTs', async () => {
    renderForm({
      initialAnswers: [
        { questionId: 'housing_situation', value: 'yes', label: 'Yes', skipped: false },
        { questionId: 'food_insecurity', value: 'skipped', label: 'Skipped', skipped: true },
      ],
    });

    await screen.findByText('Do you have stable housing?');

    // Progress reflects both hydrated answers immediately — 2 of 3 — with
    // zero network calls (hydration is local state only).
    expect(screen.getByText(/2 of 3 questions/)).toBeTruthy();
    expect(mockedApi).not.toHaveBeenCalled();

    // Q1's "Yes" option renders as already selected.
    const yesOption = screen.getAllByLabelText('Yes')[0];
    expect(iconColor(yesOption)).toBe(colors.primary);

    // Q2 shows as skipped ("Skipped" label on its skip row).
    await screen.findByText('Skipped');
  });

  it('with no initialAnswers, the form renders blank (0 of 3) as before', async () => {
    renderForm();
    await screen.findByText('Do you have stable housing?');
    expect(screen.getByText(/0 of 3 questions/)).toBeTruthy();
    expect(mockedApi).not.toHaveBeenCalled();
  });
});

describe('AssessmentForm — retry after a failed skip', () => {
  it('retries a failed skip POST via the retry toast, not a generic answer retry', async () => {
    mockedApi.mockImplementationOnce(async () => {
      throw new Error('network down');
    });
    renderForm();
    await screen.findByText('Do you have stable housing?');

    fireEvent.click(screen.getAllByLabelText('Skip this question')[0]);

    await screen.findByText('tap to retry');

    mockedApi.mockImplementation(async (path: string, options?: { method?: string }) =>
      routeApi(path, options),
    );

    await act(async () => {
      fireEvent.click(screen.getByText('tap to retry'));
    });

    await waitFor(() => {
      const payload = lastPostBody();
      expect(payload).toMatchObject({ question_id: 'housing_situation', skipped: true });
    });
  });
});
