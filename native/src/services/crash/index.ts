/**
 * Mobile crash + error reporting — wraps Sentry so we can ship the
 * initialization code now and turn it live by setting
 * `EXPO_PUBLIC_SENTRY_DSN` later.
 *
 * Default behavior: noop. No DSN → no Sentry client is ever constructed,
 * no native module is touched, `captureException` is a no-op.
 *
 * Call `crash.init()` exactly once at the top of `App.tsx` (before
 * rendering the ErrorBoundary) to install the Sentry SDK when active.
 *
 * Install to activate:
 *   npx expo install sentry-expo
 *   # then set EXPO_PUBLIC_SENTRY_DSN in .env
 *
 * Backend Sentry is already live (see backend/app/main.py); this is the
 * mobile-side counterpart so we see client-side exceptions in the same
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
      this.Sentry = require('sentry-expo');
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
      enableInExpoDevelopment: false,
      debug: false,
      tracesSampleRate: 0.1,
    });
    this.initialized = true;
  }

  captureException(error: unknown, context?: Record<string, unknown>): void {
    if (!this.Sentry) return;
    const Native = this.Sentry.Native;
    if (context) Native?.setContext?.('meta', context);
    Native?.captureException?.(error);
  }

  addBreadcrumb(msg: string, category?: string, data?: Record<string, unknown>): void {
    this.Sentry?.Native?.addBreadcrumb?.({ message: msg, category, data });
  }

  setUser(userId: string | null): void {
    this.Sentry?.Native?.setUser?.(userId ? { id: userId } : null);
  }
}

// ─── Factory + singleton ─────────────────────────────────────────────────────

function createCrashProvider(): CrashProvider {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return new NoopCrashProvider();
  return new SentryCrashProvider(dsn);
}

export const crash: CrashProvider = createCrashProvider();
