# Session Summary — April 18, 2026 (Part 2)

**Duration:** Continued work in same day
**Commits:** 8 additional (on top of morning's 5)
**Focus:** Phase A (mock data decoupling) + Phase B (mobile build infra) + 6 parallel backend tracks

---

## What We Built (This Half)

### Phase A — Authenticated Screens Decoupled From Mock Data
- MemberSessionsScreen: removed dead MOCK_MEMBER_NAME constant
- MemberCalendarScreen: removed hardcoded goal milestone events + unused DEMO_MEMBER_NAME
- MemberRoadmapScreen: goal list starts empty instead of 3 fake fixtures
- Impact: Lisett and Karla will see only their own data in-app

### Phase B — EAS Mobile Build Infrastructure
- app.json: added iOS bundleIdentifier, Android package, permissions, permission descriptions
- eas.json: three build profiles (development, preview, production) with correct API URLs
- package.json: build:ios:preview, build:ios:prod, build:android:*, submit:* scripts
- .gitignore: blocks google-service-account.json + Apple creds from commits
- docs/MOBILE_APP_SETUP.md: step-by-step setup, store submission, tester rollout

### Phase C — Push Notifications (Backend)
- DeviceToken model + migration (one user : many devices)
- Provider-agnostic NotificationProvider interface with ExpoPushProvider adapter
- notify_user() helper with auto-prune of invalid tokens
- POST /api/v1/devices/register + /unregister endpoints
- Wired into: request accepted (notify member), new chat message (notify recipient)
- Preview-only message bodies in notifications (never full PHI text in lock-screen preview)

### Phase C — Push Notifications + Deep Links (Mobile)
- expo-notifications + expo-constants + expo-linking added to deps
- src/hooks/usePushNotifications.ts: registers Expo token, POSTs to /devices/register
- src/hooks/useDeepLinks.ts: parses compasschw://... URLs from push taps + universal links
- Magic link + session + conversation + request deeplinks all routed

### Phase D — Magic-Link (Passwordless) Auth
- MagicLinkToken model + migration
- POST /auth/magic/request — 3/min rate-limited, returns 202 regardless (no enumeration)
- POST /auth/magic/verify — single-use, 15-min TTL, returns JWT pair
- useRequestMagicLink + useVerifyMagicLink hooks in the native app

### Phase E — Transcription Provider
- Provider-agnostic TranscriptionProvider interface
- AssemblyAIProvider with medical mode + PII redaction
- Wired into VonageProvider.get_transcript (Vonage captures audio → AssemblyAI transcribes)
- Handles speaker diarization, medical entities, auto-redaction of SSN/phone/medical terms

### Phase F — Legal Document Templates
- docs/legal/PRIVACY_POLICY.md: HIPAA-compliant, CCPA-aware, subprocessor list
- docs/legal/HIPAA_NOTICE.md: Notice of Privacy Practices, patient rights, breach policy
- docs/legal/TERMS_OF_SERVICE.md: Medi-Cal authorization, fraud warning, arbitration
- docs/legal/APP_STORE_PRIVACY_LABELS.md: Apple App Privacy questionnaire answers

---

## API Surface

**32 → 50 endpoints** (previous session → now)

New endpoints:
- POST /api/v1/devices/register
- POST /api/v1/devices/unregister
- POST /api/v1/auth/magic/request
- POST /api/v1/auth/magic/verify
- GET /api/v1/requests/{id} (full detail post-accept)
- DELETE /api/v1/member/account
- POST /admin/waitlist/login
- POST /admin/waitlist/logout

---

## What Remains Before Mobile App Ships

### Technical (backend work done, frontend integration needed)
- Mount `useRegisterPushNotifications(isAuthenticated)` in App.tsx
- Mount `useDeepLinks(navigationRef, handleMagicLink)` in App.tsx
- Build MagicLinkScreen UI (request form + token-verify handler)
- Email delivery for magic links (SES, Resend, or Postmark — currently logs the URL)
- Onboarding screen auth-unlock when launch-ready

### External (Akram-owned)
- Expo organization creation (compasschw)
- Apple Developer Program enrollment ($99/yr, ~2 wk approval)
- Google Play Console ($25)
- Vonage account + signed BAA
- AssemblyAI account + signed BAA
- Pear Suite API key delivery

### Deployment
- Backend redeploy to EC2 with new env vars:
  - ADMIN_KEY, PHI_ENCRYPTION_KEY (from this morning)
  - ASSEMBLYAI_API_KEY, EXPO_ACCESS_TOKEN (optional)
- Run all 5 new Alembic migrations
- Once Expo org + Apple Dev approved: first EAS preview build

---

## Progress Metrics

| Metric | Start of Day | End of Day |
|--------|--------------|------------|
| Backend endpoints | 32 | 50 |
| HIPAA technical safeguards | ~50% | ~95% |
| Backend provider abstractions | 1 (comms) | 4 (comms, billing, notifications, transcription) |
| Mobile build infrastructure | None | EAS-ready |
| Legal/compliance docs | None | 4 templates complete |
| Mock data in auth screens | 3 | 0 |
| Outstanding CRITICAL issues | 4 | 0 |
| Outstanding HIGH issues | 6 | 2 (Vonage BAA + Redis rate limiter) |

---

## Key Architectural Decisions

1. **Provider-agnostic from day one** — every external integration (comms, billing, notifications, transcription) is behind an ABC so swapping providers is a single-file change.
2. **Non-blocking side effects** — notifications, billing submissions, transcription never fail the originating request. They're best-effort and retryable.
3. **Minimum-necessary on push content** — notification bodies are 40-char previews, never full message text. Full content requires opening the app (where the JWT is).
4. **Single-use, short-TTL magic links** — 15 min default, hashed storage, rate-limited request endpoint, no enumeration oracle.
5. **Medical transcription via AssemblyAI** — BAA available, medical terminology model, auto-PII redaction built in.
6. **Deep-link scheme** `compasschw://` used consistently across notifications, magic links, and future share-flows.
