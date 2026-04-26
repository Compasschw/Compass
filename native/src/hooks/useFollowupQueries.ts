/**
 * TanStack Query hooks for session follow-up extraction and management.
 *
 * Covered endpoints:
 *   POST /sessions/{id}/extract-followups  — LLM extraction (idempotent)
 *   PATCH /sessions/{id}/followups/{fid}   — confirm / dismiss / edit
 *   GET  /member/roadmap                   — member's roadmap items
 *
 * HIPAA: followup descriptions are NEVER logged in console.error / analytics.
 * All network errors are redacted before surfacing.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { transformKeys, toSnakeCase } from '../utils/caseTransform';

// ─── Domain types ─────────────────────────────────────────────────────────────

export type FollowupKind =
  | 'action_item'
  | 'follow_up_task'
  | 'resource_referral'
  | 'member_goal';

export type FollowupOwner = 'chw' | 'member' | 'both';

export type FollowupStatus = 'pending' | 'confirmed' | 'dismissed' | 'completed';

export type FollowupPriority = 'low' | 'medium' | 'high';

export type FollowupVertical =
  | 'housing'
  | 'food'
  | 'mental_health'
  | 'rehab'
  | 'healthcare';

export interface SessionFollowup {
  id: string;
  kind: FollowupKind;
  description: string;
  owner: FollowupOwner | null;
  vertical: FollowupVertical | null;
  priority: FollowupPriority | null;
  dueDate: string | null;
  status: FollowupStatus;
  autoCreated: boolean;
  showOnRoadmap: boolean;
  confirmedByUserId: string | null;
  confirmedAt: string | null;
  createdAt: string;
  /** Present on roadmap items — surfaced from the session join */
  sessionDate?: string | null;
  /** Present on roadmap items — surfaced from the session join */
  chwName?: string | null;
}

export interface ExtractFollowupsResponse {
  sessionId: string;
  followups: SessionFollowup[];
  actionItemsCount: number;
  followUpTasksCount: number;
  resourceReferralsCount: number;
  memberGoalsCount: number;
  wasCached: boolean;
}

/**
 * Fields that the CHW may mutate via the PATCH endpoint.
 * All fields are optional — send only what changed.
 */
export interface PatchFollowupPayload {
  status?: FollowupStatus;
  description?: string;
  owner?: FollowupOwner | null;
  vertical?: FollowupVertical | null;
  priority?: FollowupPriority | null;
  dueDate?: string | null;
  showOnRoadmap?: boolean;
}

// ─── Query keys ───────────────────────────────────────────────────────────────

export const followupQueryKeys = {
  extraction: (sessionId: string) =>
    ['sessions', sessionId, 'followups'] as const,
  memberRoadmap: ['member', 'roadmap'] as const,
} as const;

// ─── useExtractSessionFollowups ───────────────────────────────────────────────

/**
 * Run LLM extraction for a session's follow-ups.
 *
 * The endpoint is idempotent — calling it again returns cached results if
 * they were already extracted (wasCached: true). Callers can skip the loading
 * spinner in that case.
 *
 * On success the result is written into the query cache so
 * CHWSessionReviewScreen can read it without an extra network round-trip.
 */
export function useExtractSessionFollowups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string): Promise<ExtractFollowupsResponse> => {
      const raw = await api<unknown>(
        `/sessions/${sessionId}/extract-followups`,
        { method: 'POST' },
      );
      return transformKeys<ExtractFollowupsResponse>(raw);
    },
    onSuccess: (data) => {
      // Seed the query cache so the review screen renders without an extra fetch.
      qc.setQueryData(followupQueryKeys.extraction(data.sessionId), data);
    },
  });
}

// ─── useSessionFollowups ──────────────────────────────────────────────────────

/**
 * Read follow-ups already extracted for a session.
 * Typically populated from the cache seeded by useExtractSessionFollowups —
 * the query will only fire a network request if the cache is cold.
 */
export function useSessionFollowups(sessionId: string) {
  return useQuery({
    queryKey: followupQueryKeys.extraction(sessionId),
    queryFn: async (): Promise<ExtractFollowupsResponse> => {
      // Re-run extraction if cache is cold (idempotent on the server).
      const raw = await api<unknown>(
        `/sessions/${sessionId}/extract-followups`,
        { method: 'POST' },
      );
      return transformKeys<ExtractFollowupsResponse>(raw);
    },
    enabled: !!sessionId,
    // Results don't change after CHW review — 10-minute stale window is safe.
    staleTime: 10 * 60 * 1_000,
  });
}

// ─── useUpdateFollowup ────────────────────────────────────────────────────────

/**
 * Patch a single follow-up (confirm / dismiss / edit).
 *
 * Performs an optimistic update against the cached extraction result so the
 * UI responds immediately. On error the cache is rolled back.
 *
 * TODO(backend): confirm PATCH /api/v1/sessions/{session_id}/followups/{followup_id}
 * is live. Backend contract tracked in Compass issue #[followup-patch-endpoint].
 */
export function useUpdateFollowup(sessionId: string) {
  const qc = useQueryClient();
  const cacheKey = followupQueryKeys.extraction(sessionId);

  return useMutation({
    mutationFn: async ({
      followupId,
      patch,
    }: {
      followupId: string;
      patch: PatchFollowupPayload;
    }): Promise<SessionFollowup> => {
      const raw = await api<unknown>(
        `/sessions/${sessionId}/followups/${followupId}`,
        {
          method: 'PATCH',
          // HIPAA: description is sent to the server but NOT logged here.
          body: JSON.stringify(toSnakeCase(patch)),
        },
      );
      return transformKeys<SessionFollowup>(raw);
    },

    // ── Optimistic update ──────────────────────────────────────────────────────
    onMutate: async ({ followupId, patch }) => {
      // Cancel any in-flight refetch so it doesn't overwrite our optimistic data.
      await qc.cancelQueries({ queryKey: cacheKey });

      const previous = qc.getQueryData<ExtractFollowupsResponse>(cacheKey);
      if (previous) {
        qc.setQueryData<ExtractFollowupsResponse>(cacheKey, {
          ...previous,
          followups: previous.followups.map((f) =>
            f.id === followupId ? { ...f, ...patch } : f,
          ),
        });
      }
      return { previous };
    },

    onError: (_err, _vars, context) => {
      // Rollback on failure. HIPAA: error detail is not logged.
      if (context?.previous) {
        qc.setQueryData<ExtractFollowupsResponse>(cacheKey, context.previous);
      }
    },

    onSettled: () => {
      // Revalidate after a short debounce to pick up server-side state.
      void qc.invalidateQueries({ queryKey: cacheKey });
      // If something was shown-on-roadmap, the roadmap may have changed too.
      void qc.invalidateQueries({ queryKey: followupQueryKeys.memberRoadmap });
    },
  });
}

// ─── useMemberRoadmap ─────────────────────────────────────────────────────────

/**
 * Fetch the current member's roadmap items.
 * Returns SessionFollowup[] filtered to show_on_roadmap == true for the
 * authenticated member.
 *
 * TODO(backend): confirm GET /api/v1/member/roadmap is live. Backend contract
 * tracked in Compass issue #[member-roadmap-endpoint].
 */
export function useMemberRoadmap() {
  return useQuery({
    queryKey: followupQueryKeys.memberRoadmap,
    queryFn: async (): Promise<SessionFollowup[]> => {
      const raw = await api<unknown[]>('/member/roadmap');
      return transformKeys<SessionFollowup[]>(raw);
    },
    staleTime: 60_000,
  });
}

/**
 * Mark a roadmap item as completed.
 * Optimistically flips status in the roadmap cache; rolls back on error.
 *
 * TODO(backend): same PATCH endpoint — confirm
 * PATCH /api/v1/sessions/{session_id}/followups/{followup_id}
 * is live. Tracked in Compass issue #[followup-patch-endpoint].
 */
export function useCompleteRoadmapItem() {
  const qc = useQueryClient();
  const cacheKey = followupQueryKeys.memberRoadmap;

  return useMutation({
    mutationFn: async ({
      sessionId,
      followupId,
    }: {
      sessionId: string;
      followupId: string;
    }): Promise<void> => {
      await api(`/sessions/${sessionId}/followups/${followupId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'completed' }),
      });
    },

    onMutate: async ({ followupId }) => {
      await qc.cancelQueries({ queryKey: cacheKey });
      const previous = qc.getQueryData<SessionFollowup[]>(cacheKey);
      if (previous) {
        qc.setQueryData<SessionFollowup[]>(
          cacheKey,
          previous.map((f) =>
            f.id === followupId ? { ...f, status: 'completed' as const } : f,
          ),
        );
      }
      return { previous };
    },

    onError: (_err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData<SessionFollowup[]>(cacheKey, context.previous);
      }
    },

    onSettled: () => {
      void qc.invalidateQueries({ queryKey: cacheKey });
    },
  });
}
