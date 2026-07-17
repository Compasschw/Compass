# SMS Output — Spec 1: Phone Verification, Message Mirroring, Confirmations, Delivery Status

**Date:** 2026-07-15 · **Author:** Akram Mahmoud + Claude (brainstormed, approved) · **Status:** Approved for planning
**Prerequisite context:** 10DLC verified on Vonage (2026-07-14); Vonage BAA signed (`vonage_baa_confirmed` boot gate); QA3 wave shipped (555-555-5555 placeholder rules live).
**Companion:** Spec 2 (CHW-required SMS 2FA, 30-day trusted devices) follows separately once this ships and the SMS channel is production-proven.

## Context & goal

CHWs and members communicate through Compass in-app messages, but members won't always have the app open. Now that 10DLC is carrier-verified, texts deliver at full rates. Goal: when a member has a **real, verified, consented** phone (never the `555-555-5555` placeholder), messages from their CHW and key confirmations also reach them as SMS — reliably, with zero tolerance for PHI misdelivery, and with an always-available STOP opt-out.

Nearly the entire pipeline already exists and is dormant: CHW→member fanout (`conversations.py::_fanout_sms_for_chw_message`), inbound member SMS threading into the conversation (`communication.py::sms_inbound`, sticky routing via `last_sms_conversation_id`), STOP/HELP handling, duplicate-phone and sentinel gates (`sms_eligibility.py`), session-reminder and signup-confirmation SMS. It is dormant because eligibility requires `User.phone_verified_at`, and nothing in member signup sets it. **The core of this spec is turning the pipeline on safely, not building a new one.**

## Decisions (locked with Akram)

1. **Eligibility = one-time phone verification at signup** (OTP proves number ownership — the strongest anti-misdelivery / TCPA posture). Skippable; unverified members stay app-only.
2. A member whose phone is exactly **555-555-5555 is treated as fully SMS-opted-out**: no messages, no verification prompts, no SMS features.
3. **All in-app CHW→member messages mirror to SMS** for eligible members (existing fanout). Member→CHW remains the throttled "you have a message" CHW alert (CHWs work in-app).
4. **Confirmations via SMS**: session request received; session scheduled/confirmed; session cancelled/rescheduled; plus the verification OTP itself. (Signup welcome + 24h/1h reminders already exist.)
5. **STOP prompt**: members must always know they can opt out — append "Reply STOP to opt out." to the first outbound SMS of any 24-hour window per member. Inbound STOP handling already exists and applies instantly.
6. **Delivery-status tracking included**: Vonage status webhook → per-message delivered/failed → CHW sees a "not delivered" indicator (silence on success).
7. **One SMS client**: unify on the async Messages-API client (`services/vonage_sms.py`); retire the legacy sync key/secret OTP client (`services/communication/vonage_sms.py`).
8. **Runtime kill switch**: `sms_mirroring_enabled` settings flag (emergency off); per-member verify gate is the real control. BAA boot gate unchanged.

## Section 1 — Foundation: phone verification + client unification

**Member verify-at-signup (frontend + light backend):**
- After successful member registration, the app presents a "Confirm your phone" step: calls existing `POST /api/v1/phone/start-verification` (6-digit OTP, argon2-hashed, 3 starts/user/hour + IP rate limit, TTL + attempt caps) and confirms via `POST /api/v1/phone/confirm-verification`, which sets `User.phone_verified_at` — the exact gate `check_sms_eligibility` reads.
- **Skippable** ("Verify later"). Unverified member = app-only messaging, no SMS of any kind. Member Settings gains a "Turn on text messages" card that re-launches the same verify flow (and shows verified state once done).
- Members whose phone is the 555 sentinel never see the verify step or the settings card (decision 2).
- The OTP confirm flow already handles duplicate-phone → 409 and sentinel rules; no gate changes.

**Client unification (backend):**
- `phone_verification.py` switches OTP delivery from the legacy sync `VonageSmsProvider.send_code` to the async Messages client (`get_vonage_sms_messages_client().send_text`), body branded via `brand_outbound_sms` (e.g. "Compass: Your verification code is 123456. It expires in N minutes.").
- Delete `services/communication/vonage_sms.py` and its factory; update its tests. Result: exactly one SMS-emitting function in the codebase, one from-number seam (`get_sms_from_number`), one BAA-gated JWT-authenticated channel, no sync HTTP calls blocking the event loop.

## Section 2 — Message mirroring (delta on the existing pipeline)

Existing behavior switches on automatically as members verify: CHW message text fans out best-effort to the member's phone; member SMS replies thread back into the right conversation (`channel='sms'`), sticky-routed; STOP/HELP, ambiguous-phone dead-letters, per-pair daily rate limit all stand.

Deltas:
- **STOP prompt cadence**: new `MemberProfile.last_stop_prompt_at` (nullable timestamp). Any outbound member-facing SMS (fanout, explicit send, confirmations, reminders) appends `" Reply STOP to opt out."` when `last_stop_prompt_at` is null or >24h old, then stamps it. Implemented in one shared helper next to `brand_outbound_sms` so every send path gets it for free; body-length aware (SMS segments are fine — copy stays short).
- **No eligibility changes**: `check_sms_eligibility` gates (role, phone, verified, sentinel, opt-out, duplicate) are correct as-is.
- Member→CHW direction unchanged (throttled alert, no content).

## Section 3 — Confirmation SMS (four sends, three new)

New best-effort functions in `services/sms_notifications.py`, following its exact pattern (never raise, `check_sms_eligibility`-gated, no-PHI first-names-only bodies, `record_touch(kind='sms')`, tested for no-PHI):
- **Request received** — hooked where the member's session request is created: "Compass: We got your session request — {CHW first name} will confirm a time shortly."
- **Session confirmed** — hooked at the schedule-confirm transition (same place the request-accepted email/push fires): "Compass: Your session with {CHW first name} is confirmed for {Mon, Jul 20 at 2:00 PM}."
- **Cancelled / rescheduled** — hooked at cancel and propose-new-time/reschedule transitions: "Compass: Your {Jul 20} session was cancelled." / "Compass: Your session moved to {new date/time}."
- **Verification OTP** — Section 1's flow (not a new function; the unified client send).
All datetimes rendered in the member's local context the same way the reminder SMS already formats them. Each hook lives beside the existing email/push trigger at that transition so channels can't drift.

## Section 4 — Delivery-status tracking

- **Webhook**: `POST /api/v1/communication/sms/status` — Vonage Messages status callbacks, signature-verified with the same `_verify_vonage_signature` dependency as inbound; idempotent per (message_uuid, status). Mapping: `delivered` → `delivered`; `rejected`/`undeliverable` → `failed` (+ reason); `submitted` → ignored (interim state, no write).
- **Data**: migration adds `messages.delivery_status` (`String(16)`, nullable — null for pure in-app messages) + `messages.delivery_failed_reason` (`String(64)`, nullable). Outbound SMS sends already persist `provider_message_id`; the webhook matches on it and stamps `delivered` or `failed`. Confirmation/notification sends (no Message row) log status into the existing CommunicationTouch `extra_data` instead.
- **UI**: in the CHW thread, a mirrored/SMS message shows a subtle indicator ONLY on failure — "Not delivered by text — member will see it in the app." Success renders nothing (no clutter). No member-side UI.
- Unmatched or late statuses are logged and dropped (no dead-letter table needed — status is advisory).

## Section 5 — Rollout, flags, testing

- **Flag**: `sms_mirroring_enabled: bool = True` in settings — checked at the top of the fanout + confirmation sends (kill switch; OTP delivery is NOT behind it, verification must always work). BAA boot gate (`vonage_baa_confirmed`) unchanged.
- **Ship as ~3 PRs**: (1) client unification + member verify-at-signup (backend + FE screens/settings card); (2) confirmation sends + STOP-prompt helper; (3) delivery-status (migration + webhook + thread indicator).
- **Testing** (patterns from the 5 existing SMS test files, per `backend/TESTING.md`): OTP-through-Messages-client (success/stub/failure, no event-loop sync client anywhere); verify-at-signup FE flow (skip path, settings re-entry, sentinel members never prompted); STOP-prompt cadence (first send has it, second within 24h doesn't, resets after); each confirmation send (eligible sends / ineligible silent / no-PHI body / hook fires at the right transition and not others); status webhook (signature 401, idempotent replay, matches provider_message_id, stamps failed + reason, unmatched dropped); thread indicator renders only on failed. The existing SMS test suites must pass untouched — they are the regression net for the dormant pipeline turning on.

## Error handling principles (unchanged from existing discipline)

Every SMS send is best-effort and never blocks or fails its parent operation (message post, signup, schedule transition). Eligibility failures are silent no-ops (debug-logged reason codes). Vonage failures return result objects, never raise. Webhooks are idempotent and signature-gated. All logging masks phones to last-4 and never logs message bodies.

## Out of scope (explicitly)

- CHW-required SMS 2FA + trusted devices → **Spec 2** (next).
- CHW phone verification (needed for 2FA; not needed here — CHW alert SMS keeps its current loose gate).
- Number pooling (the from-number seam already isolates this).
- Mirroring member message content to CHW phones.
