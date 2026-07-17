# SMS Output — Spec 2: CHW SMS 2FA with Trusted Devices

**Date:** 2026-07-15 · **Status:** Approved (Akram) · **Prerequisite:** Spec 1 live (PRs #233–#235: unified Messages client, phone verification, STOP handling, delivery status).

## Decisions (locked with Akram)

1. **CHWs: SMS 2FA required at every login** (workforce holds PHI access). **Members: opt-in** via Settings. A member whose phone is exactly 555-555-5555 is fully SMS-opted-out — no texts, no verification, no 2FA (never sees the toggle).
2. **Remember device 30 days** after a successful code; challenged again on expiry, logout-everywhere, admin reset, or a new device.
3. **Enforced immediately on deploy** (no grace period — workforce is currently small). `chw_sms_2fa_enabled: bool = True` settings flag exists ONLY as an emergency off switch (pattern of `sms_mirroring_enabled`).
4. **Recovery = admin reset** behind the existing admin TOTP gate: clears the CHW's phone + verified flag + trusted devices + refresh tokens, audit-logged. The CHW then enrolls a new number through the normal login challenge — no special-case flow.
5. **Enrollment at login + Settings**: the login challenge itself enrolls an unverified CHW (enter number → code → in); CHW Settings gains the verify-phone card members got; new CHW signups verify at registration like members.

## Architecture

**Challenge flow.** `POST /auth/login` with a correct password → if user requires 2FA (CHW & flag on; or member with `sms_2fa_enabled` and a verified, non-sentinel phone) and no valid trusted-device header: respond `200 {"two_fa_required": true, "pending_token": <JWT>, "phone_verification_required": <bool>, "phone_last4": <str|null>}` — and NO access/refresh tokens. The pending token is single-purpose (type claim `user_2fa_pending`, `sub` = user id, 10-min expiry, signed with `settings.admin_2fa_secret`) and is accepted by exactly two endpoints:

- `POST /auth/2fa/send-code` `{pending_token, phone?}` — sends a 6-digit OTP via the unified Messages client to the user's verified phone; `phone` is accepted ONLY when the user has no verified phone (enrollment/recovery), is validated (E.164, sentinel rejected 422, duplicate rules per QA3 phone-uniqueness). Reuses the `PhoneVerification` machinery (argon2-hashed codes, TTL, attempt caps, 3-starts/hour + IP rate limit).
- `POST /auth/2fa/verify` `{pending_token, code, remember_device}` — on success issues the real access/refresh tokens (identical shape to today's login response); on the enrollment path also sets `User.phone`/`phone_verified_at` (duplicate-phone → 409, same contract as confirm-verification). With `remember_device: true`, also returns `device_token` (raw, 256-bit urlsafe) and stores its SHA-256 in `trusted_devices` with a 30-day expiry.

**Trusted devices.** Table `trusted_devices(id uuid pk, user_id fk→users indexed, token_hash char(64) unique, user_agent varchar(256) null, created_at, last_used_at, expires_at indexed)`. Login reads header `X-Device-Token`; a matching unexpired hash for that user bypasses the challenge and stamps `last_used_at`. Revoked by logout-everywhere, admin reset, and expiry.

**Member opt-in.** `users.sms_2fa_enabled` boolean (server_default false). Member Settings shows a single REAL toggle ("Two-factor authentication — text a code when you sign in") inside the Privacy & Security card — visible only for members with a verified, non-sentinel phone (note: this card's previous toggles were removed in QA3 precisely because they were fake; this one is wired). If a member enabled 2FA but later loses phone verification, login FAILS OPEN for members (skip challenge) — they're opt-in, not workforce.

**Admin recovery.** `POST /api/v1/admin/chws/{chw_id}/reset-2fa` gated by the existing `require_2fa_token` (admin TOTP): NULLs phone + `phone_verified_at`, deletes the CHW's `trusted_devices` rows, revokes refresh tokens, writes `AuditLog(action="chw_2fa_reset")`. Admin-console UI wiring is out of scope (runbook: call the endpoint; the admin dashboard build is a separate surface).

**Frontend.** Login flow gains `TwoFactorScreen`: code entry (with `phone_last4` shown), "Remember this device for 30 days" checkbox (default checked), resend with 30s cooldown, and a phone-entry variant when `phone_verification_required` (enrollment/recovery). Device token persisted (AsyncStorage / localStorage via the platform wrapper) and sent as `X-Device-Token` on login; cleared on logout-everywhere. CHW Settings (CHWProfileScreen) gets the verify-phone card; RegisterScreen routes new CHWs (real phone) to the Spec-1 `VerifyPhone` screen like members.

**One migration** (`chw2fa0715`, `down_revision="smsdlv0715"`): `trusted_devices` table + `users.sms_2fa_enabled`.

## Security invariants (each gets a test)

- No access/refresh token is ever issued from `/auth/login` when a challenge is required.
- The pending token authorizes ONLY the two 2FA endpoints (any other endpoint → 401) and expires in 10 minutes; a real access token is NOT accepted by the 2FA endpoints in its place.
- Device tokens: hash-only at rest; forged/expired/other-user's token → full challenge; verify with `remember_device: false` stores nothing.
- OTP: reused machinery keeps attempt caps and rate limits; codes are argon2-hashed, never logged; sending respects the sentinel and masks phones to last-4 in logs.
- Admin reset requires the admin TOTP header and writes an audit row.
- Members: sentinel-phone members can never enable or be challenged; flag-off (`chw_sms_2fa_enabled=False`) restores today's login for everyone (emergency valve).

## Error handling

Same disciplines as Spec 1: OTP delivery failure → 500 with row kept (retryable); Vonage failures never raise; challenge endpoints never 500 on malformed input; enrollment duplicate phone → 409 with the standard message.

## Out of scope

TOTP-app or email factors; member-required 2FA; admin-console UI for the reset endpoint; per-session step-up auth.
