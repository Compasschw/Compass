/**
 * Component test for InlineSdohPanel — the SDOH / Health Screening panel
 * surfaced inside CHW Messages instead of navigating to a separate screen.
 * Only the network boundary (`../../api/client`) is mocked; the real
 * useAssessmentBootstrap hook and the real, unmodified AssessmentForm render
 * and drive persistence — proving this panel reuses the exact same
 * questionnaire engine (and therefore the exact same Screening Results
 * outcome) as the legacy full-screen flow.
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
import { InlineSdohPanel } from './InlineSdohPanel';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

const SESSION_ID = 'sess-1';
const ASSESSMENT_ID = 'assess-1';

const templateFixture = {
  id: 'compass_member_v1',
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

const startAssessmentFixture = {
  id: ASSESSMENT_ID,
  status: 'in_progress',
  template_id: 'compass_member_v1',
  session_id: SESSION_ID,
  member_id: 'member-1',
};

function routeApi(path: string, options?: { method?: string }): unknown {
  const method = options?.method ?? 'GET';
  if (path === '/assessment-templates/compass_member_v1') return templateFixture;
  if (path === `/sessions/${SESSION_ID}/assessments` && method === 'POST') return startAssessmentFixture;
  if (path === `/assessments/${ASSESSMENT_ID}/responses` && method === 'POST') return {};
  if (path === `/assessments/${ASSESSMENT_ID}/complete` && method === 'POST') return {};
  throw new Error(`Unhandled api() call: ${method} ${path}`);
}

function renderPanel(props: Partial<React.ComponentProps<typeof InlineSdohPanel>> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <InlineSdohPanel
        sessionId={SESSION_ID}
        memberName="Rosa Gutierrez"
        onClose={onClose}
        variant="pane"
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onClose };
}

beforeEach(() => {
  mockedApi.mockReset();
  mockedApi.mockImplementation(async (path: string, options?: { method?: string }) => routeApi(path, options));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('InlineSdohPanel', () => {
  it('renders the questionnaire for an active session (pane variant)', async () => {
    renderPanel({ variant: 'pane' });

    expect(screen.getByText('SDOH / Health Screening')).toBeTruthy();
    expect(screen.getByText('For Rosa Gutierrez')).toBeTruthy();

    await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });
    expect(screen.getByLabelText('Yes')).toBeTruthy();
    expect(screen.getByLabelText('No')).toBeTruthy();
  });

  it('renders the questionnaire for an active session (sheet variant, narrow/native fallback)', async () => {
    renderPanel({ variant: 'sheet' });

    await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });
    // Sheet variant shows a dismissible backdrop.
    expect(screen.getByLabelText('Close SDOH panel')).toBeTruthy();
  });

  it('answering a question calls the persistence hook with the correct payload', async () => {
    renderPanel();
    await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });

    fireEvent.click(screen.getByLabelText('No'));

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/assessments/${ASSESSMENT_ID}/responses`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const call = mockedApi.mock.calls.find(
      (args: unknown[]) => args[0] === `/assessments/${ASSESSMENT_ID}/responses`,
    );
    const payload = JSON.parse((call as [string, { body: string }])[1].body);
    expect(payload).toMatchObject({
      question_id: 'q1',
      question_text: 'Do you have stable housing?',
      answer_value: 'no',
      answer_label: 'No',
      category: 'housing',
      subcategory: 'stability',
    });
  });

  it('shows an on-brand success confirmation (not a browser alert) after completing, and "Done" calls onClose', async () => {
    const { onClose } = renderPanel();
    await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });

    fireEvent.click(screen.getByLabelText('Yes'));
    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/assessments/${ASSESSMENT_ID}/responses`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Complete assessment'));
    });

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/assessments/${ASSESSMENT_ID}/complete`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    await screen.findByText('Assessment Complete');
    expect(
      screen.getByText(/answers have been saved.*Screening Results/i),
    ).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Done'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('"Pause for now" closes the panel without completing the assessment', async () => {
    const { onClose } = renderPanel();
    await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });

    fireEvent.click(screen.getByLabelText('Pause assessment for now'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockedApi).not.toHaveBeenCalledWith(
      `/assessments/${ASSESSMENT_ID}/complete`,
      expect.anything(),
    );
  });

  it('the X close button calls onClose', async () => {
    const { onClose } = renderPanel();
    await screen.findByText('Do you have stable housing?', {}, { timeout: 3000 });

    fireEvent.click(screen.getByLabelText('Close SDOH panel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows an error state with a Close action when the template fails to load', async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === '/assessment-templates/compass_member_v1') throw new Error('network down');
      throw new Error(`unexpected path ${path}`);
    });
    const { onClose } = renderPanel();

    await screen.findByText('Something went wrong', {}, { timeout: 3000 });
    fireEvent.click(screen.getByLabelText('Close SDOH panel'));
    expect(onClose).toHaveBeenCalled();
  });
});
