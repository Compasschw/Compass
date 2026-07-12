/**
 * Hook test for useAssessmentBootstrap — the shared "fetch the SDOH template
 * + start/resume the assessment for a session" scaffolding used by
 * InlineSdohPanel. Only the network boundary (`../api/client`) is mocked;
 * the real react-query orchestration runs.
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  useAssessmentBootstrap,
  SDOH_ASSESSMENT_TEMPLATE_ID,
} from './useAssessmentBootstrap';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, api: vi.fn() };
});
import { api } from '../api/client';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

const SESSION_ID = 'sess-1';
const ASSESSMENT_ID = 'assess-1';

const templateFixture = {
  id: SDOH_ASSESSMENT_TEMPLATE_ID,
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
  template_id: SDOH_ASSESSMENT_TEMPLATE_ID,
  session_id: SESSION_ID,
  member_id: 'member-1',
};

function setup(sessionId: string = SESSION_ID) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(({ sid }: { sid: string }) => useAssessmentBootstrap(sid), {
    wrapper,
    initialProps: { sid: sessionId },
  });
}

beforeEach(() => {
  mockedApi.mockReset();
});

describe('useAssessmentBootstrap', () => {
  it('fetches the template and starts/resumes the assessment, landing on state "ready"', async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === `/assessment-templates/${SDOH_ASSESSMENT_TEMPLATE_ID}`) return templateFixture;
      if (path === `/sessions/${SESSION_ID}/assessments`) return startAssessmentFixture;
      throw new Error(`unexpected path ${path}`);
    });

    const { result } = setup();

    expect(result.current.state).toBe('loading');

    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.template).toEqual(templateFixture);
    expect(result.current.assessmentId).toBe(ASSESSMENT_ID);
    expect(result.current.errorMessage).toBeNull();
  });

  it('sends the correct payload to start/resume the assessment', async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === `/assessment-templates/${SDOH_ASSESSMENT_TEMPLATE_ID}`) return templateFixture;
      if (path === `/sessions/${SESSION_ID}/assessments`) return startAssessmentFixture;
      throw new Error(`unexpected path ${path}`);
    });

    setup();

    await waitFor(() => {
      expect(mockedApi).toHaveBeenCalledWith(
        `/sessions/${SESSION_ID}/assessments`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ template_id: SDOH_ASSESSMENT_TEMPLATE_ID }),
        }),
      );
    });
  });

  it('surfaces state "error" when the template fetch fails', async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === `/assessment-templates/${SDOH_ASSESSMENT_TEMPLATE_ID}`) {
        throw new Error('network down');
      }
      throw new Error(`unexpected path ${path}`);
    });

    const { result } = setup();

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorMessage).toBe('Failed to load the questionnaire. Please try again.');
    expect(result.current.assessmentId).toBeNull();
  });

  it('surfaces state "error" when starting/resuming the assessment fails', async () => {
    mockedApi.mockImplementation(async (path: string) => {
      if (path === `/assessment-templates/${SDOH_ASSESSMENT_TEMPLATE_ID}`) return templateFixture;
      if (path === `/sessions/${SESSION_ID}/assessments`) throw new Error('boom');
      throw new Error(`unexpected path ${path}`);
    });

    const { result } = setup();

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorMessage).toBe('Failed to start assessment. Please try again.');
    expect(result.current.assessmentId).toBeNull();
  });
});
