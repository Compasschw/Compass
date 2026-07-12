/**
 * useAssessmentBootstrap — fetches the SDOH/Health-Screening template and
 * starts/resumes the in-progress assessment for a session.
 *
 * This is the "scaffolding" layer around the questionnaire — it does NOT own
 * answer persistence. Answer submission and completion (POST
 * `/assessments/{id}/responses`, POST `/assessments/{id}/complete`) live
 * entirely inside `AssessmentForm` (src/components/assessment/AssessmentForm.tsx),
 * which is the single source of truth for that logic and is reused unmodified
 * by every caller of this hook — this file must never duplicate it.
 *
 * Used by `InlineSdohPanel` (the in-Messages panel). The legacy full-screen
 * `CHWMemberAssessmentScreen` keeps its own historical bootstrap code path —
 * see that file's header comment for why it was left untouched.
 *
 * HIPAA: no PHI (question/answer content) is fetched or logged here — only
 * template metadata and assessment/session identifiers.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '../api/client';

// ─── Types ────────────────────────────────────────────────────────────────────

export const SDOH_ASSESSMENT_TEMPLATE_ID = 'compass_member_v1';

export interface AssessmentTemplateOption {
  value: string;
  label: string;
}

export interface AssessmentTemplateQuestion {
  id: string;
  section_id: string;
  source_q_num: number;
  text: string;
  category: string;
  subcategory: string;
  tags: string[];
  options: AssessmentTemplateOption[];
}

export interface AssessmentTemplateSection {
  id: string;
  title: string;
  part: number;
  part_label: string;
  category: string;
}

export interface AssessmentTemplate {
  id: string;
  name: string;
  total_questions: number;
  sections: AssessmentTemplateSection[];
  questions: AssessmentTemplateQuestion[];
}

interface StartOrResumeAssessmentResponse {
  id: string;
  status: string;
  template_id: string;
  session_id: string;
  member_id: string;
}

export type AssessmentBootstrapState = 'loading' | 'ready' | 'error';

export interface UseAssessmentBootstrapResult {
  state: AssessmentBootstrapState;
  template: AssessmentTemplate | undefined;
  assessmentId: string | null;
  errorMessage: string | null;
}

// ─── API calls ────────────────────────────────────────────────────────────────

async function fetchAssessmentTemplate(templateId: string): Promise<AssessmentTemplate> {
  return api<AssessmentTemplate>(`/assessment-templates/${templateId}`);
}

async function startOrResumeAssessment(sessionId: string): Promise<StartOrResumeAssessmentResponse> {
  return api<StartOrResumeAssessmentResponse>(`/sessions/${sessionId}/assessments`, {
    method: 'POST',
    body: JSON.stringify({ template_id: SDOH_ASSESSMENT_TEMPLATE_ID }),
  });
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Fetches the SDOH template (cached 5 min — templates rarely change) and
 * starts/resumes the in_progress assessment for `sessionId` on mount.
 *
 * Callers should mount a fresh instance per session (e.g. via a React `key`)
 * rather than passing a changing `sessionId` into a long-lived instance.
 */
export function useAssessmentBootstrap(sessionId: string): UseAssessmentBootstrapResult {
  const [assessmentId, setAssessmentId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState<boolean>(true);

  const {
    data: template,
    isLoading: templateLoading,
    error: templateError,
  } = useQuery({
    queryKey: ['assessment-template', SDOH_ASSESSMENT_TEMPLATE_ID],
    queryFn: () => fetchAssessmentTemplate(SDOH_ASSESSMENT_TEMPLATE_ID),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (templateLoading) return;
    if (templateError) return; // surfaced via the derived `state` below

    let cancelled = false;
    setStarting(true);
    setStartError(null);

    startOrResumeAssessment(sessionId)
      .then((assessment) => {
        if (cancelled) return;
        setAssessmentId(assessment.id);
        setStarting(false);
      })
      .catch(() => {
        if (cancelled) return;
        setStartError('Failed to start assessment. Please try again.');
        setStarting(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionId is stable per mounted instance (caller remounts via `key`)
  }, [sessionId, templateLoading, templateError]);

  const errorMessage = templateError
    ? 'Failed to load the questionnaire. Please try again.'
    : startError;

  const state: AssessmentBootstrapState =
    errorMessage != null
      ? 'error'
      : templateLoading || starting || !template || !assessmentId
      ? 'loading'
      : 'ready';

  return { state, template, assessmentId, errorMessage };
}
