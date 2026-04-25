/**
 * InstallPWA — Progressive Web App install affordance.
 *
 * Three modes of operation:
 *  1. Chrome/Edge/Android (beforeinstallprompt available): shows a bottom banner
 *     with an "Install App" button. Clicking triggers the native prompt.
 *  2. iOS Safari (no beforeinstallprompt, standalone not already active): shows a
 *     "Add to Home Screen" tooltip with step-by-step instructions.
 *  3. Already running as a standalone PWA: renders nothing.
 *
 * Dismissal writes a timestamp to localStorage; the banner stays hidden for 30 days.
 */

import { useCallback, useEffect, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

/** The non-standard BeforeInstallPromptEvent present in Chromium browsers. */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
  prompt(): Promise<void>
}

type InstallMode = 'chromium' | 'ios' | 'none'

// ── Constants ─────────────────────────────────────────────────────────────────

const DISMISS_KEY = 'compass_pwa_install_dismissed_at'
const DISMISS_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectInstallMode(): InstallMode {
  // Already running as a standalone PWA — no prompt needed.
  if (window.matchMedia('(display-mode: standalone)').matches) return 'none'
  // iOS Safari: no beforeinstallprompt, but PWA can still be added via share sheet.
  const ua = navigator.userAgent
  const isIOS = /iP(hone|ad|od)/.test(ua) && !/CriOS|FxiOS|OPiOS|mercury/.test(ua)
  if (isIOS) return 'ios'
  // Chromium-derived browsers will fire beforeinstallprompt if installable.
  return 'chromium'
}

function isDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    if (!raw) return false
    const ts = parseInt(raw, 10)
    return Date.now() - ts < DISMISS_TTL_MS
  } catch {
    return false
  }
}

function writeDismissal(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
  } catch {
    // Storage may be unavailable in private-browsing — fail silently.
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface ChromiumBannerProps {
  onInstall: () => void
  onDismiss: () => void
}

/** Bottom banner shown in Chromium-derived browsers when the PWA is installable. */
function ChromiumBanner({ onInstall, onDismiss }: ChromiumBannerProps) {
  return (
    <div
      role="banner"
      aria-label="Install CompassCHW as an app"
      className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-between gap-3 bg-[#2C3E2D] px-4 py-3 shadow-lg"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}
    >
      {/* Icon + copy */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div
          aria-hidden="true"
          className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-[#6B8F71]"
        >
          {/* Simple home-screen glyph */}
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M3 9.5L10 3l7 6.5V17a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"
              stroke="#FBF7F0"
              strokeWidth="1.5"
              strokeLinejoin="round"
              fill="none"
            />
            <path d="M7 18v-5h6v5" stroke="#FBF7F0" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight text-[#FBF7F0]">
            Add CompassCHW to your home screen
          </p>
          <p className="text-xs text-[#9DB8A0]">Fast access, works offline</p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-shrink-0 items-center gap-2">
        <button
          onClick={onInstall}
          className="rounded-xl bg-[#6B8F71] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
          aria-label="Install CompassCHW app"
        >
          Install
        </button>
        <button
          onClick={onDismiss}
          className="flex h-8 w-8 items-center justify-center rounded-full text-[#9DB8A0] transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/50"
          aria-label="Dismiss install prompt"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}

interface IOSTooltipProps {
  onDismiss: () => void
}

/**
 * Instructional tooltip for iOS Safari users.
 * iOS does not fire beforeinstallprompt — the user must manually use the
 * share sheet to add to home screen.
 */
function IOSTooltip({ onDismiss }: IOSTooltipProps) {
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="How to add CompassCHW to your home screen on iOS"
      className="fixed bottom-0 left-0 right-0 z-50 bg-[#2C3E2D] shadow-xl"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
    >
      {/* Chevron notch */}
      <div className="mx-auto mb-2 mt-3 h-1 w-10 rounded-full bg-white/20" aria-hidden="true" />

      <div className="px-5 pb-4 pt-1">
        {/* Header row */}
        <div className="mb-3 flex items-center justify-between">
          <p className="text-base font-semibold text-[#FBF7F0]">Add to Home Screen</p>
          <button
            onClick={onDismiss}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[#9DB8A0] transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/50"
            aria-label="Dismiss iOS install instructions"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Steps */}
        <ol className="space-y-3" aria-label="Steps to install">
          <li className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[#6B8F71] text-xs font-bold text-white"
            >
              1
            </span>
            <span className="text-sm text-[#D6E8D9]">
              Tap the{' '}
              <span className="inline-flex items-center gap-1 align-middle">
                {/* Share icon */}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-label="Share"
                  role="img"
                >
                  <path
                    d="M8 1v9M5 4l3-3 3 3M3 10v4h10v-4"
                    stroke="#6B8F71"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <strong className="text-[#FBF7F0]">Share</strong>
              </span>{' '}
              button in the Safari toolbar
            </span>
          </li>

          <li className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[#6B8F71] text-xs font-bold text-white"
            >
              2
            </span>
            <span className="text-sm text-[#D6E8D9]">
              Scroll down and tap{' '}
              <span className="inline-flex items-center gap-1 align-middle">
                {/* Plus icon */}
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  aria-label="Add"
                  role="img"
                >
                  <rect x="1" y="1" width="12" height="12" rx="2" stroke="#6B8F71" strokeWidth="1.5" />
                  <path d="M7 4v6M4 7h6" stroke="#6B8F71" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <strong className="text-[#FBF7F0]">Add to Home Screen</strong>
              </span>
            </span>
          </li>

          <li className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[#6B8F71] text-xs font-bold text-white"
            >
              3
            </span>
            <span className="text-sm text-[#D6E8D9]">
              Tap <strong className="text-[#FBF7F0]">Add</strong> to confirm
            </span>
          </li>
        </ol>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * Mount this component at the App root so it renders on all routes including
 * unauthenticated ones.  It self-hides when:
 *   - the user has dismissed within the last 30 days
 *   - the app is already running as a standalone PWA
 *   - the browser has not flagged the site as installable (Chromium mode only)
 */
export function InstallPWA() {
  const [mode] = useState<InstallMode>(() => detectInstallMode())
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [visible, setVisible] = useState(false)

  // Capture the Chromium beforeinstallprompt event.
  useEffect(() => {
    if (mode !== 'chromium') return
    if (isDismissed()) return

    const handler = (event: Event) => {
      event.preventDefault()
      setDeferredPrompt(event as BeforeInstallPromptEvent)
      setVisible(true)
    }

    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [mode])

  // iOS: show the tooltip once (unless dismissed).
  useEffect(() => {
    if (mode !== 'ios') return
    if (isDismissed()) return
    setVisible(true)
  }, [mode])

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') {
      setVisible(false)
      setDeferredPrompt(null)
    }
  }, [deferredPrompt])

  const handleDismiss = useCallback(() => {
    writeDismissal()
    setVisible(false)
    setDeferredPrompt(null)
  }, [])

  if (!visible) return null

  if (mode === 'chromium' && deferredPrompt) {
    return <ChromiumBanner onInstall={handleInstall} onDismiss={handleDismiss} />
  }

  if (mode === 'ios') {
    return <IOSTooltip onDismiss={handleDismiss} />
  }

  return null
}
