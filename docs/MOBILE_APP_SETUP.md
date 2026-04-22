# Mobile App Setup Guide — CompassCHW iOS + Android

**Last updated:** April 18, 2026
**Target:** TestFlight + Google Play Internal Testing within 1-2 weeks

---

## Prerequisites (one-time)

These accounts must exist before the first build. All are Akram-owned.

### 1. Expo / EAS Account
- URL: https://expo.dev
- Sign up with business email: `akram.mahmoud-eng@joincompasschw.com`
- Create an organization: **compasschw** (matches `owner` in `app.json`)
- Free tier gives 30 builds/month — sufficient for development
- Get project ID after first `eas init`

### 2. Apple Developer Account
- URL: https://developer.apple.com
- **Cost:** $99/year
- Account type: **Organization** (not Individual) — required for:
  - HIPAA compliance signaling
  - Business Associate Agreement with Apple (if Apple becomes a BA)
  - Listing CompassCHW, LLC as the publisher (more credible than a person's name)
- Requires D-U-N-S number (free via Dun & Bradstreet)
- Expect 1-2 week approval delay for organization enrollment

### 3. Google Play Console
- URL: https://play.google.com/console
- **Cost:** $25 one-time
- Account type: **Organization**
- Required: 20 internal testers before public launch (standard policy)
- Requires bank info for payment verification

### 4. Apple Push Notification (APNs) — defer until notifications needed
Can skip initially; required before MVP launch. Generated in Apple Developer portal.

### 5. Google Firebase / FCM — defer until notifications needed
Can skip initially. Creates the `google-service-account.json` referenced in `eas.json`.

---

## Step-by-Step: First iOS Build to TestFlight

Once the Apple Developer account is approved and Akram has Expo installed:

```bash
cd /Users/akrammahmoud/Desktop/Projects/Compass/native

# 1. Install EAS CLI locally (already in devDependencies)
npm install

# 2. Log in to Expo
npx eas login

# 3. Link this project to an EAS project
npx eas init
# This writes a projectId to app.json. Commit that change.

# 4. Configure iOS credentials (EAS walks you through it)
npx eas credentials --platform ios
# Select:
#   - Set up an ad hoc provisioning profile (for preview builds)
#   - Set up distribution certificate (for App Store builds)
# EAS will ask for your Apple ID and push credentials to its cloud.

# 5. First preview build (signs with ad-hoc — installable on up to 100 devices)
npm run build:ios:preview
# Wait 15-20 minutes. Download the .ipa from the build link.
# Install on your iPhone via TestFlight or Expo Go.

# 6. First production build + TestFlight submission
npm run build:ios:prod
npm run submit:ios
# Requires ascAppId and appleTeamId filled in eas.json first.
```

---

## Step-by-Step: First Android Build

```bash
# 1. Configure Android credentials
npx eas credentials --platform android
# EAS creates and manages the keystore automatically.

# 2. Preview APK (installable on any Android via APK sideload)
npm run build:android:preview

# 3. Production AAB (for Google Play)
npm run build:android:prod

# 4. Submit to Play Internal Testing
#    Requires: google-service-account.json at project root (DO NOT COMMIT)
npm run submit:android
```

---

## Required Before App Store Submission

### iOS
- [ ] Apple Developer account approved
- [ ] `ascAppId` filled in `eas.json` (App Store Connect app record ID)
- [ ] `appleTeamId` filled in `eas.json` (10-character team ID)
- [ ] App Store Connect app record created at https://appstoreconnect.apple.com
- [ ] App icons in required sizes (Expo generates from `icon.png`)
- [ ] Screenshots (6.7", 6.5", 5.5" device sizes — Expo generates on build)
- [ ] Privacy policy URL (use `joincompasschw.com/privacy`)
- [ ] Support URL (use `joincompasschw.com/contact`)
- [ ] Age rating questionnaire completed
- [ ] Health app category selected
- [ ] **HIPAA data disclosure** (App Privacy nutrition label):
  - Data collected: Health & Fitness (Health), Contact Info (Email, Phone), User Content
  - Linked to user identity: Yes (all categories)
  - Used for tracking: No
  - Purpose: App Functionality, Analytics

### Android
- [ ] Google Play Console account approved
- [ ] `google-service-account.json` generated and placed at project root
- [ ] App listing created in Play Console (name, short description, full description, graphics)
- [ ] Content rating questionnaire completed
- [ ] Target API level 34+ (Expo SDK 54 handles this automatically)
- [ ] Health app category selected
- [ ] 20 internal testers added (can be Akram, Jemal, JT, Lisett, Karla, and 15 others)

---

## EAS Build Profiles Explained

The `eas.json` defines three profiles:

| Profile | Purpose | Distribution | API URL |
|---------|---------|--------------|---------|
| `development` | Expo Go + dev tools | Internal, simulator OK | localhost:8000 |
| `preview` | Internal alpha/beta | Ad-hoc / internal | production API |
| `production` | Store submission | App Store / Play Store | production API |

**When to use each:**
- **development** — for daily engineering work, hot reload, debug tools
- **preview** — for Lisett/Karla testing or founder testing on real devices before App Store submission
- **production** — only when you're ready to submit to a public release channel

---

## Push Notifications (Phase 2 — defer)

When ready, follow this order:

1. Add `expo-notifications` to dependencies
2. Generate APNs key in Apple Developer → Keys
3. Upload the `.p8` to EAS: `eas credentials --platform ios` → "Push Notifications"
4. Generate FCM service account in Firebase Console
5. Upload to EAS: `eas credentials --platform android` → "FCM Server Key"
6. Backend work:
   - Add `expo-server-sdk-python` dependency
   - Store device push tokens on the User model (`push_token` field)
   - Wire notification sending to:
     - New request to CHW (`/requests/` POST)
     - Request accepted (member notified)
     - Session starting reminder (15 min before)
     - New chat message
7. App work:
   - Register for notifications on login
   - Handle tap-to-open → navigate to relevant screen

---

## Internal Testing Plan

Once TestFlight is working:

| Week | Tester | Scope |
|------|--------|-------|
| Week 1 | Akram, Jemal, JT | Full smoke test; fix critical bugs |
| Week 2 | + Lisett, Karla | First real CHW flow — sign up, browse, accept request |
| Week 3 | + 5 friendly CHWs | Expand session completion tests |
| Week 4 | + 5 friendly members | End-to-end CHW ↔ member flow |
| Week 5+ | Public TestFlight (if ready) | Broader beta |

---

## Cost Summary

| Item | Cost |
|------|------|
| Expo EAS Free Tier | $0 (30 builds/mo) |
| Apple Developer Program | $99/year |
| Google Play Console | $25 one-time |
| Push notifications | $0 (APNs + FCM are free) |
| **Total Year 1** | **~$124** |

If you exceed 30 builds/month during heavy iteration, EAS Production tier is $99/month.

---

## Troubleshooting

**"This bundle ID is already in use"** — The bundle ID `com.joincompasschw.app` must be unique across all Apple Developer accounts. If taken, change to `com.compasschw.app` or similar in `app.json` and redo credentials.

**"Build failed: Pod install failed"** — Usually a CocoaPods version mismatch. Run `npx expo-doctor` and follow recommendations.

**"Distribution certificate is invalid"** — Apple Developer membership expired, or certificate was manually revoked. Regenerate via `eas credentials --platform ios`.

**Android APK won't install** — User must enable "Install from unknown sources" on their device. Not needed for Play Store distribution.

---

## Tool-integration scaffolds

Every third-party integration the mobile app will eventually use is wired
today as a **no-op by default**, activated by setting an `EXPO_PUBLIC_*`
env var. Screens import from `src/services/<name>/` and call into a thin
interface; provider swaps are a single-file change with no caller impact.

| Capability | Env flag (to activate) | Default behavior | Real provider | Install command |
|-----------|------------------------|------------------|----------------|-----------------|
| **Crash reporting** | `EXPO_PUBLIC_SENTRY_DSN=https://...` | no-op | `sentry-expo` (lazy-loaded) | `npx expo install sentry-expo` |
| **Product analytics** | `EXPO_PUBLIC_POSTHOG_KEY=phc_...` (+ optional `EXPO_PUBLIC_POSTHOG_HOST`) | no-op | `posthog-react-native` (lazy-loaded) | `npm i posthog-react-native` |
| **Phone dialing (masked)** | `EXPO_PUBLIC_USE_VONAGE_DIAL=1` | native `tel:` dialer | Backend `/communication/call-bridge` proxy via Vonage | (no client dep — backend Vonage BAA gates it) |
| **Add to calendar** | — (always real if module present) | no-op | `expo-calendar` | `npx expo install expo-calendar` + add `NSCalendarsUsageDescription` to `app.json` |
| **Biometric unlock** | `EXPO_PUBLIC_REQUIRE_BIOMETRIC=1` | bypass (no prompt) | `expo-local-authentication` | `npx expo install expo-local-authentication` + add `NSFaceIDUsageDescription` to `app.json` |

### Activation checklist when a credential arrives

1. Install the SDK (see table above).
2. Add the env var to `eas.json`'s relevant build profile (preview / production).
3. For calendar / biometric: add the matching `NS*UsageDescription` string to `app.json` `ios.infoPlist`.
4. Rebuild with `eas build` — no code changes required.

### Backend integration points

| Mobile service | Backend endpoint (ready) |
|----------------|--------------------------|
| phone (Vonage) | `POST /communication/call-bridge` — creates a per-session proxy number |
| crash | Sentry — already live for backend, shares the same project |
| (analytics) | PostHog — standalone SaaS, no backend glue |
| (calendar) | None — purely client-side |
| (biometric) | None — gates client session |

---

## Ship-prep TODOs

Items that must be filled before first production build:

- [ ] **`eas.json` → `submit.production.ios.ascAppId`** — App Store Connect app ID, obtained after creating the app listing in App Store Connect (post-Apple-Developer-org approval, which is blocked on DUNS, which is blocked on EIN).
- [ ] **`eas.json` → `submit.production.ios.appleTeamId`** — 10-char alphanumeric Team ID, visible in the Apple Developer portal Membership page.
- [ ] **`app.json` → `ios.bundleIdentifier`** — confirm `com.joincompasschw.app` is still the right bundle ID once Apple reservations go through.
- [ ] **Google Play Console service account key** — `google-service-account.json` at repo root (not committed). Download from Play Console → Setup → API access.

Each of these TODOs is repeated as a comment or `__TODO__` key in the
relevant file so they're impossible to miss during a build.
