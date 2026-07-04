/**
 * App-wide feature flags.
 *
 * These are compile-time constants (not remote config) — flip a value and
 * redeploy to toggle a feature across the app.
 */

/**
 * Wellness points / rewards.
 *
 * TEMPORARILY DISABLED (2026-07): the product decision is to remove every mention
 * of points from the platform for now. The points/rewards CODE is intentionally
 * kept intact and simply gated behind this flag so it can be re-enabled in one
 * line when we return to the feature — no re-implementation needed.
 *
 * When false, hide: per-step "+N pts" on journey timelines, the "wellness pts"
 * badge, rewards-balance widgets, and the member Rewards tab/screen entry points.
 * Backend still tracks points (ledger) untouched — this only hides the UI.
 */
export const POINTS_ENABLED = false;
