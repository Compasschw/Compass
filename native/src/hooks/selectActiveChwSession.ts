/**
 * selectActiveChwSession — pure selector behind the ActiveSessionBadge.
 *
 * Picks the single in-progress session (if any) out of a CHW's conversations
 * array. Kept framework-free (no React, no react-query, no react-native) so
 * it's unit-tested in isolation — see selectActiveChwSession.test.ts — rather
 * than only exercised indirectly through a hook render.
 *
 * The `ConversationData` import below is type-only and erased at compile
 * time, so it does not pull react-query (or anything else) into this module
 * at runtime.
 */
import type { ConversationData } from './useApiQueries';

/** Shape consumed by ActiveSessionBadge — a resolved in-progress session. */
export interface ActiveChwSession {
  sessionId: string;
  memberId: string;
  memberName: string;
  /**
   * ISO8601 start time of the session. Null defensively — the backend
   * contract guarantees this is set whenever activeSessionId is set, but we
   * don't trust that blindly here; ActiveSessionBadge's timer already
   * degrades gracefully (renders "0:00") when this is null.
   */
  startedAt: string | null;
}

/**
 * Resolves the CHW's active (in_progress) session from a conversations list.
 *
 *   - No conversation has `activeSessionId` set → null.
 *   - Exactly one does                          → that one.
 *   - More than one (should not normally happen — a CHW should only ever
 *     have a single in-progress session at a time, but we don't assume the
 *     backend enforces that here) → the one with the most recent
 *     `activeSessionStartedAt`. A conversation with a null/unparseable
 *     `activeSessionStartedAt` always loses the tie-break.
 */
export function selectActiveChwSession(
  conversations: readonly ConversationData[] | null | undefined,
): ActiveChwSession | null {
  if (!conversations || conversations.length === 0) return null;

  const active = conversations.filter((c) => c.activeSessionId != null);
  if (active.length === 0) return null;

  const startedAtMs = (c: ConversationData): number => {
    if (!c.activeSessionStartedAt) return -Infinity;
    const ms = Date.parse(c.activeSessionStartedAt);
    return Number.isNaN(ms) ? -Infinity : ms;
  };

  const mostRecent = active.reduce((latest, current) =>
    startedAtMs(current) > startedAtMs(latest) ? current : latest,
  );

  return {
    // Non-null asserted: `active` was filtered on `activeSessionId != null`.
    sessionId: mostRecent.activeSessionId as string,
    memberId: mostRecent.memberId,
    memberName: mostRecent.memberName,
    startedAt: mostRecent.activeSessionStartedAt,
  };
}
