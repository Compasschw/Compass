/**
 * Pure cache-patch helpers for the optimistic "Begin Session" update.
 *
 * Extracted from useStartSession so the patch logic can be unit-tested without a
 * React Query / RN render harness. The button reads a session's `status`, and
 * the header timer reads a conversation's `activeSessionStartedAt`; these apply
 * the in_progress flip immediately so both update the instant the CHW taps Begin.
 *
 * Structural (not concrete) types keep this module free of a hooks import, so it
 * can't create an import cycle.
 */

/** Minimal shape of a cached session for the optimistic start patch. */
export interface StartableSession {
  status: string;
  startedAt?: string;
}

/** Minimal shape of a cached conversation row for the timer patch. */
export interface TimerConversation {
  activeSessionId: string | null;
  activeSessionStartedAt: string | null;
}

/**
 * Flip a session to in_progress, stamping `startedAt` only if not already set.
 * Returns a new object; never mutates the input.
 */
export function withSessionStarted<T extends StartableSession>(session: T, nowIso: string): T {
  return {
    ...session,
    status: 'in_progress',
    startedAt: session.startedAt ?? nowIso,
  };
}

/**
 * For the conversation whose `activeSessionId` matches `sessionId`, seed
 * `activeSessionStartedAt` (only if empty) so the header timer starts now.
 * All other rows are returned unchanged. Never mutates the input array/rows.
 */
export function withStartedAtForSession<T extends TimerConversation>(
  conversations: T[],
  sessionId: string,
  nowIso: string,
): T[] {
  return conversations.map((c) =>
    c.activeSessionId === sessionId
      ? { ...c, activeSessionStartedAt: c.activeSessionStartedAt ?? nowIso }
      : c,
  );
}
