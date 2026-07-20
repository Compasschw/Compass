/**
 * PostSessionRatingGate — member-wide host for the post-session star-rating
 * prompt (Epic B2).
 *
 * WHY THIS EXISTS AS A STANDALONE HOST (not inline on MemberHomeScreen):
 * A CHW completes a session while the member is passive — there is no push /
 * websocket, so the member's app discovers the newly completed-but-unrated
 * session purely by React Query refetch (see `useTestimonialPrompt`, which now
 * polls on an interval + on window focus). If the prompt only lived on the
 * Home screen, a member sitting on Messages / Journey / Appointments when their
 * session completed would not be asked to rate it until they navigated back to
 * Home (often a fresh sign-in). Mounting this gate ONCE for authenticated
 * members — above the tab navigator (see `MemberNavigator` in
 * navigation/AppNavigator.tsx) — lets the PromptDialog overlay surface on ANY
 * tab, within ~30s / on refocus of the session completing.
 *
 * It owns exactly what the inline MemberHomeScreen version owned, unchanged:
 *   - the `useTestimonialPrompt` query (the single most-recent completed +
 *     unrated session, ≤14 days, at most one — chosen server-side),
 *   - the per-app-session "Maybe later" dismissal (module-level Set keyed by
 *     session id, so a NEW completed session still prompts — see the Set's
 *     docstring),
 *   - the `showTestimonialPrompt` gate, including the `!mustChangePassword`
 *     coexistence rule (the mandatory first-login password gate — still owned
 *     by MemberHomeScreen — must always win; the two modals never stack), and
 *   - `useSubmitTestimonial` (POST /sessions/{id}/testimonials; invalidates the
 *     prompts query on success so the prompt disappears).
 */
import React, { useCallback, useMemo, useState } from 'react';

import { ApiError } from '../../api/client';
import {
  useMemberProfile,
  useSubmitTestimonial,
  useTestimonialPrompt,
} from '../../hooks/useApiQueries';
import { PromptDialog, type PromptDialogField } from '../shared/PromptDialog';

// ─── Session-scoped "Maybe later" dismissal ──────────────────────────────────
//
// Module-level (not component state, not persisted storage): "Maybe later"
// dismisses the CURRENT app session's copy of the prompt only. This is a
// deliberate product choice (see prompt task spec) — a rating nudge that's
// permanently suppressed after one dismissal would mean a member who taps
// "Maybe later" in a rush never gets asked again, even for a LATER session.
// Re-opening the app (fresh JS module load / cold start) clears this set, so
// the prompt can resurface next visit. Keyed by session id so a NEW completed
// session (a distinct id) is still offered even after an earlier one was
// dismissed.
const dismissedTestimonialPromptSessionIds = new Set<string>();

/**
 * Mount once for authenticated members. Renders nothing (returns `null`) unless
 * there is a completed-but-unrated session to rate AND the mandatory password
 * gate is not up AND this session hasn't been dismissed this app session.
 */
export function PostSessionRatingGate(): React.JSX.Element | null {
  // Source `mustChangePassword` here (same GET /member/profile the Home screen
  // reads) so the mandatory first-login gate still suppresses this prompt even
  // though the gate is no longer rendered on Home alongside it.
  const profileQuery = useMemberProfile();
  const mustChangePassword = Boolean(profileQuery.data?.mustChangePassword);

  const testimonialPromptQuery = useTestimonialPrompt();
  const submitTestimonialMutation = useSubmitTestimonial();

  const [ratingFields, setRatingFields] = useState({ rating: '', text: '' });
  const [ratingFormError, setRatingFormError] = useState<string | null>(null);
  // Locally track the id of the session most recently dismissed via "Maybe
  // later", so the dialog closes immediately without waiting on a refetch.
  // Keyed by session id (not a plain boolean) so if the prompts query later
  // resolves to a DIFFERENT session, the new session is still offered — the
  // source of truth for "don't show THIS session again this app session"
  // remains the module-level Set above.
  const [lastDismissedSessionId, setLastDismissedSessionId] = useState<string | null>(null);

  const handleRatingFieldChange = useCallback((key: string, value: string) => {
    setRatingFields((prev) => ({ ...prev, [key]: value }));
    setRatingFormError(null);
  }, []);

  const activePromptSessionId = testimonialPromptQuery.data?.sessionId ?? null;

  const handleSubmitRating = useCallback(() => {
    if (!activePromptSessionId) return;
    const ratingValue = Number(ratingFields.rating);
    if (!ratingValue || ratingValue < 1 || ratingValue > 5) {
      setRatingFormError('Please select a star rating.');
      return;
    }
    setRatingFormError(null);

    submitTestimonialMutation.mutate(
      {
        sessionId: activePromptSessionId,
        payload: {
          rating: ratingValue,
          text: ratingFields.text.trim().length > 0 ? ratingFields.text.trim() : null,
        },
      },
      {
        onSuccess: () => {
          setRatingFields({ rating: '', text: '' });
          setRatingFormError(null);
        },
        onError: (err: unknown) => {
          // Non-blocking inline error — the member can retry or dismiss via
          // "Maybe later"; a transient failure here must never crash the
          // screen or block the rest of the dashboard.
          setRatingFormError(
            err instanceof ApiError && err.message
              ? err.message
              : 'Could not submit your rating. Please try again.',
          );
        },
      },
    );
  }, [activePromptSessionId, ratingFields, submitTestimonialMutation]);

  const handleDismissRatingPrompt = useCallback(() => {
    if (activePromptSessionId) {
      dismissedTestimonialPromptSessionIds.add(activePromptSessionId);
      setLastDismissedSessionId(activePromptSessionId);
    }
    setRatingFields({ rating: '', text: '' });
    setRatingFormError(null);
  }, [activePromptSessionId]);

  const ratingPromptFields: PromptDialogField[] = useMemo(
    () => [
      { key: 'rating', label: 'Your rating', type: 'star' as const },
      {
        key: 'text',
        label: 'Tell us more (optional)',
        placeholder: 'What went well? Anything we could improve?',
        multiline: true,
        maxLength: 120,
      },
    ],
    [],
  );

  // Show ONLY when: not gated behind the mandatory password change, there IS a
  // session to rate, and it hasn't been dismissed this app session (locally or
  // via the module-level Set). Mirrors the exact condition the inline
  // MemberHomeScreen version used — the password gate always wins so the two
  // modals never stack.
  const showTestimonialPrompt =
    !mustChangePassword &&
    activePromptSessionId !== null &&
    activePromptSessionId !== lastDismissedSessionId &&
    !dismissedTestimonialPromptSessionIds.has(activePromptSessionId);

  if (!testimonialPromptQuery.data) return null;

  return (
    <PromptDialog
      visible={showTestimonialPrompt}
      title={`How was your session with ${testimonialPromptQuery.data.chwName}?`}
      fields={ratingPromptFields}
      values={ratingFields}
      onChangeValue={handleRatingFieldChange}
      onConfirm={handleSubmitRating}
      onCancel={handleDismissRatingPrompt}
      confirmLabel="Submit"
      cancelLabel="Maybe later"
      submitting={submitTestimonialMutation.isPending}
      errorText={ratingFormError}
      testID="testimonial-rating-prompt"
    />
  );
}
