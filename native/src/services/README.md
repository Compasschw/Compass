# Services

Thin provider-pattern modules for external tool integrations.

Every module here follows the same shape, which mirrors the backend's
`app/services/<name>/{base,...}_provider.py` pattern:

- `index.ts` — public API (interface + factory + `createXProvider()`).
- A default **Noop** provider that makes the app run without credentials.
- A **real** provider lazy-loaded when the relevant `EXPO_PUBLIC_*` env
  var is set.

This lets us ship screens that call `track()`, `dial()`,
`addSessionToCalendar()`, `requireUnlock()`, etc., today and flip the
real provider live by setting a single env var once the vendor account /
credential arrives.

| Service | Env flag | Default | Real provider | Status |
|---------|----------|---------|----------------|--------|
| analytics | `EXPO_PUBLIC_POSTHOG_KEY` | noop | PostHog | scaffolded |
| phone | `EXPO_PUBLIC_USE_VONAGE_DIAL=1` | `Linking.openURL('tel:...')` | Vonage masked bridge via backend | scaffolded |
| calendar | (always real if module present) | noop | `expo-calendar` | scaffolded |
| biometric | `EXPO_PUBLIC_REQUIRE_BIOMETRIC=1` | bypass | `expo-local-authentication` | scaffolded |
| crash | `EXPO_PUBLIC_SENTRY_DSN` | noop | `sentry-expo` | scaffolded |

## Install checklist (when activating a provider)

- **expo-calendar**: `npx expo install expo-calendar` + add
  `NSCalendarsUsageDescription` to `app.json` ios.infoPlist.
- **expo-local-authentication**: `npx expo install expo-local-authentication`
  + add `NSFaceIDUsageDescription` to `app.json` ios.infoPlist.
- **sentry-expo**: `npx expo install sentry-expo` + set `EXPO_PUBLIC_SENTRY_DSN`.
- **posthog-react-native**: `npm i posthog-react-native` + set
  `EXPO_PUBLIC_POSTHOG_KEY` (and optionally `EXPO_PUBLIC_POSTHOG_HOST` for
  self-hosted).
- **Vonage phone bridge**: no client-side dep — hits the backend
  `/communication/call-bridge` endpoint. Set `EXPO_PUBLIC_USE_VONAGE_DIAL=1`
  once the backend Vonage BAA is live.
