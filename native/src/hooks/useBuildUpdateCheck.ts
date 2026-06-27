/**
 * useBuildUpdateCheck — detects when a new Expo web bundle has been deployed
 * while the current tab is still running an older one.
 *
 * Web-only. On native (`Platform.OS !== 'web'`) the hook returns a stable
 * no-op result and attaches no listeners.
 *
 * Detection strategy:
 *   Expo web production builds inject a content-hashed script tag of the form
 *   `/_expo/static/js/web/index-<hash>.js`. We capture that hash at mount
 *   time from the live DOM, then periodically re-fetch the root HTML document
 *   to read the currently-deployed hash. A mismatch means a newer build was
 *   deployed while this tab was open.
 *
 * Cadence:
 *   - Initial check: ~10 s after mount (avoids firing during first paint).
 *   - Recurring interval: every 5 minutes.
 *   - On `focus`: when the browser window / tab regains focus.
 *   - On `visibilitychange`: when the tab becomes visible after backgrounding.
 *   - Throttled: will not check more than once per 30 s regardless of trigger.
 *
 * Guarantees:
 *   - Never auto-reloads — the caller decides how to prompt the user.
 *   - Offline-safe: all fetch errors are swallowed silently.
 *   - Zero new runtime dependencies.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum milliseconds between consecutive hash checks (throttle guard). */
const THROTTLE_MS = 30_000; // 30 s

/** Delay before the first check fires after mount. */
const INITIAL_DELAY_MS = 10_000; // 10 s

/** Interval between recurring background checks. */
const INTERVAL_MS = 5 * 60_000; // 5 min

/**
 * Matches the content-hashed Expo web bundle URL and captures the hex hash.
 * Example: `/_expo/static/js/web/index-a1b2c3d4.js` → capture `a1b2c3d4`.
 */
const BUNDLE_HASH_RE = /\/_expo\/static\/js\/web\/index-([a-f0-9]+)\.js/;

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Reads the content-hash of the currently-running bundle from the injected
 * `<script>` tag in the live DOM.
 *
 * Returns `null` if the tag cannot be found (dev build, no hash, or non-web).
 */
function readRunningHash(): string | null {
  if (typeof document === 'undefined') return null;

  const script = document.querySelector<HTMLScriptElement>(
    'script[src*="/_expo/static/js/web/index-"]',
  );
  if (!script) return null;

  const match = BUNDLE_HASH_RE.exec(script.src);
  return match?.[1] ?? null;
}

/**
 * Fetches the root HTML document (cache-busted with a timestamp query param)
 * and extracts the deployed bundle hash from it.
 *
 * Returns `null` on network error, non-OK response, or if the hash pattern
 * is absent from the response body (e.g. the CDN returned a stale response).
 */
async function fetchDeployedHash(): Promise<string | null> {
  try {
    const response = await fetch(`/?_v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const html = await response.text();
    const match = BUNDLE_HASH_RE.exec(html);
    return match?.[1] ?? null;
  } catch {
    // Network offline or fetch blocked — expected in bad-connectivity scenarios.
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface BuildUpdateCheckResult {
  /**
   * `true` once the deployed bundle hash is confirmed to differ from the
   * hash of the bundle currently loaded in this tab. Starts as `false`.
   * Never reverts to `false` once set (until the page is reloaded).
   */
  updateAvailable: boolean;

  /**
   * Triggers `window.location.reload()`. Safe to reference on native (no-op).
   */
  reload: () => void;
}

/**
 * Checks for a newly-deployed Expo web bundle and returns whether an update
 * is available along with a `reload` helper.
 *
 * Mount once near the app root — typically in `App.tsx` via the
 * `<UpdateAvailableBanner />` component that calls this hook internally.
 */
export function useBuildUpdateCheck(): BuildUpdateCheckResult {
  const [updateAvailable, setUpdateAvailable] = useState<boolean>(false);

  /**
   * The hash that was in the DOM when this tab first loaded.
   * Captured once at mount; never changes while the tab is open.
   */
  const runningHashRef = useRef<string | null>(null);

  /**
   * Unix timestamp of the last completed check, used to throttle re-checks
   * triggered by focus / visibility events.
   */
  const lastCheckAtRef = useRef<number>(0);

  const check = useCallback(async (): Promise<void> => {
    // Guard: this hook does nothing outside the web platform.
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    // Throttle: skip if we just checked within the minimum window.
    const now = Date.now();
    if (now - lastCheckAtRef.current < THROTTLE_MS) return;
    lastCheckAtRef.current = now;

    const deployedHash = await fetchDeployedHash();
    if (!deployedHash) return;

    // Only flag a mismatch when we have a confirmed running hash to compare
    // against — if readRunningHash() returned null at mount, we stay silent.
    const running = runningHashRef.current;
    if (running !== null && deployedHash !== running) {
      setUpdateAvailable(true);
    }
  }, []);

  const reload = useCallback((): void => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, []);

  useEffect(() => {
    // Exit immediately on non-web platforms; no listeners, no timers.
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;

    // Capture the running bundle hash exactly once at mount.
    runningHashRef.current = readRunningHash();

    // Without a known running hash we cannot detect a change — bail out
    // silently (e.g. in development where no content-hashed bundle exists).
    if (runningHashRef.current === null) return;

    // Schedule the initial check after the mount delay.
    const initialTimer = setTimeout(() => {
      void check();
    }, INITIAL_DELAY_MS);

    // Set up the recurring interval check.
    const interval = setInterval(() => {
      void check();
    }, INTERVAL_MS);

    // Re-check when the browser window / tab regains focus.
    const handleFocus = (): void => {
      void check();
    };
    window.addEventListener('focus', handleFocus);

    // Re-check when the page becomes visible again after being backgrounded
    // (e.g. user switches back from another application or browser tab).
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void check();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [check]);

  return { updateAvailable, reload };
}
