/**
 * Session timer formatting — pure logic for the CHW Messages live session timer.
 *
 * The timer counts UP from the active session's `started_at`. Kept framework-
 * free so it's unit-tested in isolation (see sessionTimer.test.ts) rather than
 * only exercised through the ticking component.
 */

/** Whole seconds elapsed between an ISO start time and `nowMs` (never negative). */
export function elapsedSeconds(startIso: string | null | undefined, nowMs: number): number {
  if (!startIso) return 0;
  const startMs = Date.parse(startIso);
  if (Number.isNaN(startMs)) return 0;
  return Math.max(0, Math.floor((nowMs - startMs) / 1000));
}

/**
 * Format a whole-second duration as a clock string:
 *   - under an hour → `M:SS`   (e.g. 0:05, 12:34)
 *   - one hour+     → `H:MM:SS` (e.g. 1:02:09)
 *
 * Negative or non-finite inputs clamp to `0:00`.
 */
export function formatElapsed(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const secs = Math.floor(totalSeconds);
  const hours = Math.floor(secs / 3600);
  const minutes = Math.floor((secs % 3600) / 60);
  const seconds = secs % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    const mm = String(minutes).padStart(2, '0');
    return `${hours}:${mm}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

/** Convenience: elapsed clock string directly from an ISO start + current ms. */
export function formatElapsedSince(startIso: string | null | undefined, nowMs: number): string {
  return formatElapsed(elapsedSeconds(startIso, nowMs));
}
