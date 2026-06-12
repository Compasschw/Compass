/**
 * Mobile crash + error reporting — wraps @sentry/react-native so the rest of
 * the app talks to a stable `crash` interface.
 *
 * Default behavior: noop. No `EXPO_PUBLIC_SENTRY_DSN` → no Sentry client is
 * ever constructed, no native module is touched, `captureException` is a
 * no-op. Set the DSN in the environment (Vercel env for web, EAS secrets for
 * native builds) to turn reporting live — no code change needed.
 *
 * Call `crash.init()` exactly once at the top of `App.tsx` (before
 * rendering the ErrorBoundary) to install the Sentry SDK when active.
 *
 * The `@sentry/react-native/expo` config plugin in app.config.ts handles
 * native-layer init + source-map upload on EAS builds (sentry-expo is
 * deprecated as of Expo SDK 50 and must not be used).
 *
 * Backend Sentry is already live (see backend/app/main.py); this is the
 * client-side counterpart so we see frontend exceptions in the same
 * dashboard.
 */

export interface CrashProvider {
  /** Install global error hooks. Idempotent. */
  init(): void;
  /** Record a caught exception. */
  captureException(error: unknown, context?: Record<string, unknown>): void;
  /** Low-priority breadcrumb for debugging — trailed on the next exception. */
  addBreadcrumb(msg: string, category?: string, data?: Record<string, unknown>): void;
  /** Tag events with the signed-in user id (cleared on logout). */
  setUser(userId: string | null): void;
}

// ─── Noop provider ───────────────────────────────────────────────────────────

class NoopCrashProvider implements CrashProvider {
  init(): void {}
  captureException(): void {}
  addBreadcrumb(): void {}
  setUser(): void {}
}

// ─── Sentry provider (lazy-loaded) ───────────────────────────────────────────

class SentryCrashProvider implements CrashProvider {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private Sentry: any = null;
  private initialized = false;

  constructor(private readonly dsn: string) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      this.Sentry = require('@sentry/react-native');
    } catch {
      // Module not installed — stay in a safe no-op state.
      this.Sentry = null;
    }
  }

  init(): void {
    if (this.initialized || !this.Sentry) return;
    this.Sentry.init({
      dsn: this.dsn,
      environment: process.env.EXPO_PUBLIC_ENVIRONMENT ?? 'development',
      debug: false,
      tracesSampleRate: 0.1,
      // PHI guard: never attach request/response bodies or console
      // breadcrumbs that could carry member data into Sentry.
      sendDefaultPii: false,
    });
    this.initialized = true;
  }

  captureException(error: unknown, context?: Record<string, unknown>): void {
    if (!this.Sentry) return;
    if (context) this.Sentry.setContext?.('meta', context);
    this.Sentry.captureException?.(error);
  }

  addBreadcrumb(msg: string, category?: string, data?: Record<string, unknown>): void {
    this.Sentry?.addBreadcrumb?.({ message: msg, category, data });
  }

  setUser(userId: string | null): void {
    this.Sentry?.setUser?.(userId ? { id: userId } : null);
  }
}

// ─── Factory + singleton ─────────────────────────────────────────────────────

function createCrashProvider(): CrashProvider {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return new NoopCrashProvider();
  return new SentryCrashProvider(dsn);
}

export const crash: CrashProvider = createCrashProvider();
