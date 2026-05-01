import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, QrCode, KeyRound, AlertTriangle } from 'lucide-react';
import {
  ADMIN_KEY_STORAGE,
  ADMIN_2FA_TOKEN_STORAGE,
  verifyTotpCode,
  fetchTotpSetup,
  AdminApiError,
  type TotpSetupResponse,
} from './adminApi';

/**
 * Admin 2FA screen — step 2 of the two-factor admin auth flow.
 *
 * States:
 *   "verify"   — Normal flow: the TOTP secret is already set up.
 *                Operator enters their 6-digit code and submits.
 *
 *   "setup"    — First-time flow: no secret exists yet (or it is unverified).
 *                Shows the QR code and manual-entry secret.
 *                After scanning, operator enters their first code to confirm.
 *
 * Flow:
 *   1. On mount: call /2fa/verify with a dummy empty code to probe.
 *      If 428 ("setup_required") → switch to "setup" mode and fetch the QR.
 *      If 401 (bad code — expected) → show the code entry form ("verify" mode).
 *   2. On code submit: call /2fa/verify.
 *      On success: store two_fa_token in sessionStorage, navigate to /admin.
 *      On 401: show "Invalid code" error.
 *      On 428: redirect to setup mode.
 *
 * Guards:
 *   - If ADMIN_KEY is not in sessionStorage, redirect to /admin/login immediately.
 */

type PageMode = 'verify' | 'setup' | 'loading';

export function Admin2FAVerify() {
  const navigate = useNavigate();
  const codeInputRef = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<PageMode>('loading');
  const [setupData, setSetupData] = useState<TotpSetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFetchingSetup, setIsFetchingSetup] = useState(false);

  // Redirect immediately if the admin key is missing (user skipped step 1)
  useEffect(() => {
    const key = sessionStorage.getItem(ADMIN_KEY_STORAGE);
    if (!key) {
      navigate('/admin/login', { replace: true });
    }
  }, [navigate]);

  // Probe the backend to determine whether setup is needed
  useEffect(() => {
    async function probe() {
      try {
        // Attempt a verify with a clearly invalid code to get the error shape.
        // 428 → setup_required; 401 → secret exists, code was wrong (expected).
        await verifyTotpCode('000000');
        // 200 with "000000" is astronomically unlikely — treat as verify mode.
        setMode('verify');
      } catch (err) {
        if (err instanceof AdminApiError) {
          if (err.status === 428 && err.message === 'setup_required') {
            // No secret set up yet — go to setup mode
            setMode('setup');
            void loadSetupData();
            return;
          }
          // 401 = bad code (expected) — the secret exists, show normal verify
          if (err.status === 401) {
            setMode('verify');
            return;
          }
        }
        // Unexpected error — show verify form anyway, user will see the real
        // error when they submit their actual code
        setMode('verify');
      }
    }
    void probe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the code input once the form becomes visible
  useEffect(() => {
    if (mode === 'verify' || mode === 'setup') {
      codeInputRef.current?.focus();
    }
  }, [mode]);

  async function loadSetupData() {
    setIsFetchingSetup(true);
    try {
      const data = await fetchTotpSetup();
      setSetupData(data);
    } catch (err) {
      const message =
        err instanceof AdminApiError
          ? `Failed to load QR code (${err.status}): ${err.message}`
          : 'Failed to load setup data. Refresh and try again.';
      setError(message);
    } finally {
      setIsFetchingSetup(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = code.replace(/\s/g, '');
    if (trimmed.length !== 6) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await verifyTotpCode(trimmed);
      sessionStorage.setItem(ADMIN_2FA_TOKEN_STORAGE, result.two_fa_token);
      navigate('/admin', { replace: true });
    } catch (err) {
      if (err instanceof AdminApiError) {
        if (err.status === 428 && err.message === 'setup_required') {
          setMode('setup');
          void loadSetupData();
        } else if (err.status === 401) {
          setError('Invalid code. Check your authenticator app and try again.');
        } else {
          setError(`Server error (${err.status}): ${err.message}`);
        }
      } else {
        setError('Unable to reach the server. Check your connection.');
      }
      setCode('');
      codeInputRef.current?.focus();
    } finally {
      setIsSubmitting(false);
    }
  }

  // ─── Loading state ──────────────────────────────────────────────────────────

  if (mode === 'loading') {
    return (
      <div className="min-h-screen bg-[#FBF7F0] flex items-center justify-center">
        <span
          className="w-8 h-8 border-2 border-[#2C3E2D]/20 border-t-[#2C3E2D] rounded-full animate-spin"
          aria-label="Loading"
        />
      </div>
    );
  }

  // ─── Shared layout wrapper ──────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#FBF7F0] flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm bg-white rounded-[20px] shadow-sm border border-[rgba(44,62,45,0.1)] px-8 py-10">

        {/* Header */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-[#2C3E2D] flex items-center justify-center mb-3">
            {mode === 'setup'
              ? <QrCode size={24} className="text-white" aria-hidden="true" />
              : <ShieldCheck size={24} className="text-white" aria-hidden="true" />
            }
          </div>
          <h1 className="text-2xl font-semibold text-[#2C3E2D]">
            {mode === 'setup' ? 'Set up 2FA' : 'Two-factor auth'}
          </h1>
          <p className="text-sm text-[#6B7B6D] mt-1 text-center">
            {mode === 'setup'
              ? 'Scan the QR code with your authenticator app, then enter the 6-digit code to confirm.'
              : 'Enter the 6-digit code from your authenticator app.'}
          </p>
        </div>

        {/* Error banner */}
        {error !== null && (
          <div
            role="alert"
            className="mb-4 p-3 rounded-[12px] bg-red-50 border border-red-200 text-sm text-red-700 flex items-start gap-2"
          >
            <AlertTriangle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />
            {error}
          </div>
        )}

        {/* Setup QR section */}
        {mode === 'setup' && (
          <div className="mb-6">
            {isFetchingSetup ? (
              <div className="flex justify-center py-8">
                <span
                  className="w-6 h-6 border-2 border-[#2C3E2D]/20 border-t-[#2C3E2D] rounded-full animate-spin"
                  aria-label="Loading QR code"
                />
              </div>
            ) : setupData ? (
              <div className="space-y-4">
                {/* QR code via Google Charts API — no third-party JS required */}
                <div className="flex justify-center">
                  <img
                    src={`https://chart.googleapis.com/chart?chs=200x200&chld=M|0&cht=qr&chl=${encodeURIComponent(setupData.otpauth_uri)}`}
                    alt="TOTP QR code — scan with your authenticator app"
                    className="w-[200px] h-[200px] rounded-[12px] border border-[rgba(44,62,45,0.1)]"
                    width={200}
                    height={200}
                  />
                </div>

                {/* Manual entry secret — shown only before first verification */}
                {setupData.secret && (
                  <div className="bg-[#FBF7F0] rounded-[12px] p-3 text-center">
                    <p className="text-xs text-[#6B7B6D] mb-1.5">
                      Can't scan? Enter this key manually:
                    </p>
                    <div className="flex items-center justify-center gap-2">
                      <KeyRound size={13} className="text-[#6B8F71]" aria-hidden="true" />
                      <code className="text-sm font-mono text-[#2C3E2D] tracking-widest select-all">
                        {setupData.secret}
                      </code>
                    </div>
                    <p className="text-xs text-[#8B9B8D] mt-2">
                      This key is shown only once. Store it securely.
                    </p>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}

        {/* Code entry form */}
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <label
              htmlFor="totp-code"
              className="block text-sm font-medium text-[#2C3E2D] mb-1.5"
            >
              {mode === 'setup' ? 'Confirm your code' : '6-digit code'}
            </label>
            <input
              ref={codeInputRef}
              id="totp-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              className="w-full rounded-[20px] border border-[rgba(44,62,45,0.1)] px-3.5 py-2.5 text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] text-center tracking-[0.35em] font-mono focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition"
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting || code.length !== 6}
            className="w-full bg-[#2C3E2D] hover:bg-[#3A5240] disabled:bg-[rgba(44,62,45,0.2)] text-white font-semibold py-2.5 rounded-[12px] text-sm transition-colors mt-2 flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <>
                <span
                  className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"
                  aria-hidden="true"
                />
                Verifying...
              </>
            ) : mode === 'setup' ? (
              'Confirm and continue'
            ) : (
              'Verify'
            )}
          </button>
        </form>

        {/* First-time setup link (shown in verify mode only) */}
        {mode === 'verify' && (
          <p className="text-center text-xs text-[#8B9B8D] mt-6">
            New device?{' '}
            <button
              type="button"
              onClick={() => {
                setMode('setup');
                void loadSetupData();
              }}
              className="text-[#6B8F71] hover:underline font-medium"
            >
              Set up 2FA
            </button>
          </p>
        )}

        <p className="text-center text-xs text-[#8B9B8D] mt-3">
          Session clears when you close the browser tab.
        </p>
      </div>
    </div>
  );
}
