/**
 * Analytics — thin interface over a product-analytics SDK (PostHog by
 * default when `EXPO_PUBLIC_POSTHOG_KEY` is set; otherwise no-op).
 *
 * Screens should `import { analytics } from '.../services/analytics'` and
 * call `analytics.track('EventName', { ...props })`. Do not reach into a
 * specific SDK; the provider abstraction lets us swap vendors without
 * touching screens.
 */

export interface AnalyticsProvider {
  /** Associate subsequent events with a stable user id (e.g. post-login). */
  identify(userId: string, traits?: Record<string, unknown>): void;
  /** Arbitrary product event. */
  track(event: string, props?: Record<string, unknown>): void;
  /** Navigator-level screen event. */
  screen(name: string, props?: Record<string, unknown>): void;
  /** Clear identity on logout — prevents cross-user event leakage. */
  reset(): void;
}

// ─── Noop (default) ─────────────────────────────────────────────────────────

class NoopAnalyticsProvider implements AnalyticsProvider {
  identify(): void {}
  track(): void {}
  screen(): void {}
  reset(): void {}
}

// ─── PostHog (activated by EXPO_PUBLIC_POSTHOG_KEY) ─────────────────────────
//
// The SDK import is intentionally `require()`d lazily — if the module isn't
// installed (or the env var is empty), we never touch it and fall through to
// Noop. This keeps the default app bundle free of analytics code.

class PostHogAnalyticsProvider implements AnalyticsProvider {
  // Typed loosely — the SDK's types aren't importable unless installed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;

  constructor(apiKey: string, host?: string) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const PostHog = require('posthog-react-native').default;
      this.client = new PostHog(apiKey, host ? { host } : {});
    } catch {
      // Module not installed — silently fall back to no-op behavior.
      this.client = null;
    }
  }

  identify(userId: string, traits?: Record<string, unknown>): void {
    this.client?.identify?.(userId, traits);
  }

  track(event: string, props?: Record<string, unknown>): void {
    this.client?.capture?.(event, props);
  }

  screen(name: string, props?: Record<string, unknown>): void {
    this.client?.screen?.(name, props);
  }

  reset(): void {
    this.client?.reset?.();
  }
}

// ─── Factory + singleton ─────────────────────────────────────────────────────

function createAnalyticsProvider(): AnalyticsProvider {
  const key = process.env.EXPO_PUBLIC_POSTHOG_KEY;
  if (!key) return new NoopAnalyticsProvider();
  const host = process.env.EXPO_PUBLIC_POSTHOG_HOST;
  return new PostHogAnalyticsProvider(key, host);
}

export const analytics: AnalyticsProvider = createAnalyticsProvider();
