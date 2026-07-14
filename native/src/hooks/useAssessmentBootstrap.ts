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
 * Epic W3 (partial save + resume): the start/resume endpoint is idempotent —
 * when an in_progress assessment already exists for this session's member +
 * template, the backend returns that SAME assessment (HTTP 200) with its
 * prior `responses` included (both real answers and Epic-W2 skips). This
 * hook reduces that array down to the latest response per question_id (a
 * question may have been re-answered) and exposes it as `initialAnswers`,
 * which `InlineSdohPanel` passes straight into `AssessmentForm`'s
 * `initialAnswers` prop to hydrate the form on reopen instead of showing a
 * blank questionnaire.
 *
 * Wave-2 #26 (session-less screenings): the CHW may open the SDOH panel with
 * NO active session (e.g. a phone check-in). `useAssessmentBootstrap` now
 * accepts either `{ sessionId }` (existing session-scoped start, POST
 * `/sessions/{sessionId}/assessments`) or `{ memberId }` (new member-scoped
 * start, POST `/chw/members/{memberId}/assessments`, `session_id` left
 * NULL). Both branches are idempotent and — per the backend's cross-context
 * resume invariant — share the SAME in_progress assessment for a given
 * member+template regardless of which context started it, so switching
 * between "in a session" and "no session" never loses progress. Callers
 * (`InlineSdohPanel`, the Member Profile screening card) pick whichever
 * target they have; `AssessmentForm` itself is unaware of the distinction —
 * it only ever sees the resulting `assessmentId`.
 *
 * Used by `InlineSdohPanel` (the in-Messages panel) and, as of Wave-2 #25/#26,
 * `CHWMemberProfileScreen`'s Screening Results card. The legacy full-screen
 * `CHWMemberAssessmentScreen` keeps its own historical bootstrap code path —
 * see that file's header comment for why it was left untouched (it does not
 * currently wire resume hydration).
 *
 * HIPAA: no PHI (question/answer content) is fetched or logged here — only
 * template metadata and assessment/session identifiers. `initialAnswers`
 * does flow PHI-adjacent answer values into React state (same as
 * `AssessmentForm` already does for freshly-typed answers) but, per the
 * existing HIPAA contract, none of it is ever logged.
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

/** Mirrors backend AssessmentResponseOut (see app/schemas/assessment.py). */
interface AssessmentResponseHydration {
  id: string;
  question_id: string;
  answer_value: string;
  answer_label: string;
  skipped: boolean;
  captured_at: string;
}

interface StartOrResumeAssessmentResponse {
  id: string;
  status: string;
  template_id: string;
  /** NULL for an assessment started via the session-less (member-scoped) endpoint. */
  session_id: string | null;
  member_id: string;
  /**
   * Present (and populated) on the idempotent "resume" branch — the
   * backend's `_load_responses` call — but absent/empty on a freshly
   * created (201) assessment. Ordered by captured_at ascending.
   */
  responses?: AssessmentResponseHydration[];
}

/**
 * The assessment target: either an existing session (session-scoped start,
 * the original/only mode before Wave-2 #26) or a bare member id (session-less
 * start, new in Wave-2 #26). Exactly one of the two must be provided —
 * enforced by the discriminated union rather than a runtime check.
 */
export type AssessmentBootstrapTarget =
  | { sessionId: string; memberId?: undefined }
  | { memberId: string; sessionId?: undefined };

export type AssessmentBootstrapState = 'loading' | 'ready' | 'error';

/** A prior answer/skip to seed AssessmentForm with on reopen (Epic W3). */
export interface AssessmentInitialAnswer {
  questionId: string;
  value: string;
  label: string;
  skipped: boolean;
}

export interface UseAssessmentBootstrapResult {
  state: AssessmentBootstrapState;
  template: AssessmentTemplate | undefined;
  assessmentId: string | null;
  errorMessage: string | null;
  /**
   * Prior answers/skips for this assessment, one entry per question_id (the
   * LATEST response wins if a question was answered more than once — same
   * "current answer" semantics used elsewhere for this table). Empty array
   * for a brand-new assessment.
   */
  initialAnswers: AssessmentInitialAnswer[];
}

/**
 * Reduce the raw (potentially re-answered) response history down to one
 * entry per question_id, keeping the latest by captured_at. `responses` is
 * already ordered captured_at ascending by the backend, so a plain
 * left-to-right reduce naturally keeps "last wins".
 */
function toInitialAnswers(
  responses: AssessmentResponseHydration[] | undefined,
): AssessmentInitialAnswer[] {
  const byQuestionId = new Map<string, AssessmentInitialAnswer>();
  for (const r of responses ?? []) {
    byQuestionId.set(r.question_id, {
      questionId: r.question_id,
      value: r.answer_value,
      label: r.answer_label,
      skipped: r.skipped,
    });
  }
  return Array.from(byQuestionId.values());
}

// ─── API calls ────────────────────────────────────────────────────────────────

async function fetchAssessmentTemplate(templateId: string): Promise<AssessmentTemplate> {
  return api<AssessmentTemplate>(`/assessment-templates/${templateId}`);
}

/**
 * POST the appropriate start/resume endpoint for `target`:
 *   - `{ sessionId }` → POST /sessions/{sessionId}/assessments (existing)
 *   - `{ memberId }`  → POST /chw/members/{memberId}/assessments (Wave-2 #26)
 *
 * Both are idempotent on the backend and share the same in_progress
 * assessment per (member, template) regardless of which one is called —
 * see this file's header comment.
 */
async function startOrResumeAssessment(
  target: AssessmentBootstrapTarget,
): Promise<StartOrResumeAssessmentResponse> {
  const path =
    target.sessionId !== undefined
      ? `/sessions/${target.sessionId}/assessments`
      : `/chw/members/${target.memberId}/assessments`;
  return api<StartOrResumeAssessmentResponse>(path, {
    method: 'POST',
    body: JSON.stringify({ template_id: SDOH_ASSESSMENT_TEMPLATE_ID }),
  });
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Fetches the SDOH template (cached 5 min — templates rarely change) and
 * starts/resumes the in_progress assessment for `target` on mount.
 *
 * `target` is either `{ sessionId }` (in-session, the original behavior) or
 * `{ memberId }` (session-less, Wave-2 #26) — see `AssessmentBootstrapTarget`.
 *
 * Callers should mount a fresh instance per target (e.g. via a React `key`
 * on `sessionId`/`memberId`) rather than passing a changing target into a
 * long-lived instance.
 */
export function useAssessmentBootstrap(
  target: AssessmentBootstrapTarget,
): UseAssessmentBootstrapResult {
  const [assessmentId, setAssessmentId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState<boolean>(true);
  const [initialAnswers, setInitialAnswers] = useState<AssessmentInitialAnswer[]>([]);

  // Stable primitive key for the effect below — targets are objects so a
  // fresh reference on every render would otherwise re-fire the start call.
  const targetKey = target.sessionId ?? target.memberId ?? '';

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
    if (!targetKey) return; // no valid target yet (e.g. memberId not resolved)

    let cancelled = false;
    setStarting(true);
    setStartError(null);

    startOrResumeAssessment(target)
      .then((assessment) => {
        if (cancelled) return;
        setAssessmentId(assessment.id);
        setInitialAnswers(toInitialAnswers(assessment.responses));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey is the stable per-mount identity; `target` itself is intentionally excluded (see comment above)
  }, [targetKey, templateLoading, templateError]);

  const errorMessage = templateError
    ? 'Failed to load the questionnaire. Please try again.'
    : startError;

  const state: AssessmentBootstrapState =
    errorMessage != null
      ? 'error'
      : templateLoading || starting || !template || !assessmentId
      ? 'loading'
      : 'ready';

  return { state, template, assessmentId, errorMessage, initialAnswers };
}
