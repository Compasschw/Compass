# SMS Output (Spec 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on the dormant CHW↔member SMS pipeline safely: member phone verification at signup, one unified SMS client, STOP-prompt cadence, four confirmation sends, and per-message delivery-status tracking.

**Architecture:** All sends flow through the single async Vonage Messages client (`app/services/vonage_sms.py`); eligibility is unchanged (`check_sms_eligibility`); new confirmations follow the `sms_notifications.py` best-effort pattern; delivery status arrives on a new signature-verified webhook that stamps `messages.delivery_status`.

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic (backend), React Native/Expo + vitest (native/), Vonage Messages API.

**Spec:** `docs/specs/2026-07-15-sms-output-design.md` — read it first; its Decisions section is binding.

## Global Constraints

- Every SMS send is best-effort: never raises, never blocks or fails its parent operation.
- No PHI in notification bodies: first names only; every new body gets a no-PHI test.
- All new outbound member SMS go through `brand_outbound_sms` + the STOP-prompt helper (Task 6).
- Logging: phones masked to last-4; never log message bodies.
- OTP delivery is NOT behind the `sms_mirroring_enabled` flag (verification must always work).
- Backend CI enforces ≥85% diff coverage on changed lines — cover exception branches.
- Frontend CI runs bun: verify with `bun run test` (full suite) and `bun run typecheck`. Never commit lockfile changes.
- Backend tests: use an ISOLATED Postgres DB per agent (`createdb`/psql + `DATABASE_URL=postgresql+asyncpg://compass:compass_dev_password@localhost:5432/<your_db>`); never run two pytest processes against one DB. Note: 4 `test_session_chat.py` S3 tests fail locally (no local S3) but pass in CI — ignore exactly those.
- Conventional commits; end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## PR structure (3 branches off origin/main)

- **PR-1 `feat/sms1-verify-unify`** — Tasks 1–5 (client unification + member verify-at-signup FE/BE).
- **PR-2 `feat/sms1-confirmations`** — Tasks 6–9 (STOP-prompt helper + kill-switch flag + three confirmation sends).
- **PR-3 `feat/sms1-delivery-status`** — Tasks 10–13 (migration + status webhook + thread indicator). Contains this plan's ONLY migration; it is also the alembic MERGE revision for the current two heads.

PR-2 and PR-3 both touch the outbound send paths; PR-1 is independent. Merge order: PR-1 → PR-2 → PR-3 (rebase as needed).

---

### Task 1: OTP delivery via the Messages client (unification, backend)

**Files:**
- Modify: `backend/app/routers/phone_verification.py` (the `get_vonage_sms_provider().send_code(...)` block at ~lines 228–245, plus its import)
- Test: `backend/tests/test_phone_verification_uniqueness.py` (add a class) or new `backend/tests/test_phone_verification_delivery.py`

**Interfaces:**
- Consumes: `get_vonage_sms_messages_client()` → `.send_text(to_e164: str, text: str) -> SmsSendResult` (`app/services/vonage_sms.py:173,261`); `brand_outbound_sms(body: str) -> str` (`app/routers/conversations.py:702`); `PhoneVerification.CODE_TTL_MINUTES`.
- Produces: OTP SMS body format `"Compass: Your verification code is {code}. It expires in {CODE_TTL_MINUTES} minutes."` (Task 4's FE copy references the same TTL).

- [ ] **Step 1: Write the failing test** (new file `backend/tests/test_phone_verification_delivery.py`, following the monkeypatch pattern in `tests/test_vonage_sms_messages_client.py`):

```python
"""OTP delivery goes through the unified async Messages client (Spec 1 §1)."""
import pytest
from unittest.mock import AsyncMock, patch

from app.services.vonage_sms import SmsSendResult
from tests.conftest import auth_header


async def _start_verification(client, tokens, phone="+13105550188"):
    return await client.post(
        "/api/v1/phone/start-verification",
        json={"phone": phone},
        headers=auth_header(tokens),
    )


async def test_otp_sent_via_messages_client_with_brand_and_ttl(client, member_tokens):
    sent = {}

    async def fake_send_text(self, to_e164, text):
        sent["to"], sent["text"] = to_e164, text
        return SmsSendResult(success=True, provider_message_id="mid-otp-1")

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send_text
    ):
        res = await _start_verification(client, member_tokens)

    assert res.status_code == 200, res.text
    assert sent["to"] == "+13105550188"
    assert sent["text"].startswith("Compass: ")
    assert "verification code is" in sent["text"]
    assert "expires in" in sent["text"]
    # The raw 6-digit code is in the body (deliverable), never logged elsewhere.
    import re
    assert re.search(r"\b\d{6}\b", sent["text"])


async def test_otp_send_failure_returns_500_but_keeps_row(client, member_tokens):
    async def fail_send_text(self, to_e164, text):
        return SmsSendResult(success=False, error="vonage_status_500", status_code=500)

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text", fail_send_text
    ):
        res = await _start_verification(client, member_tokens)

    # Same contract as today: row kept for retry, client sees 500.
    assert res.status_code == 500


async def test_legacy_otp_client_is_gone():
    with pytest.raises(ImportError):
        from app.services.communication.vonage_sms import VonageSmsProvider  # noqa: F401
```

Note: if the file's existing fixtures don't provide `member_tokens`, register a member inline exactly as `tests/test_phone_uniqueness.py` does (use its `complete_member_signup_payload` helper and a `unique_cin()`), and mirror the surrounding conventions.

- [ ] **Step 2: Run to verify it fails** — `DATABASE_URL=... .venv/bin/python -m pytest tests/test_phone_verification_delivery.py -v`; expected: first two tests fail (OTP still sent via legacy `send_code`), third fails (module still importable).

- [ ] **Step 3: Implement.** In `phone_verification.py`, replace the legacy block:

```python
    # ── Deliver via SMS — unified async Messages client (Spec 1 §1) ──────────
    from app.routers.conversations import brand_outbound_sms
    from app.services.vonage_sms import get_vonage_sms_messages_client

    otp_body = brand_outbound_sms(
        f"Your verification code is {raw_code}. "
        f"It expires in {PhoneVerification.CODE_TTL_MINUTES} minutes."
    )
    sms_result = await get_vonage_sms_messages_client().send_text(body.phone, otp_body)

    if not sms_result.success:
        logger.error(
            "SMS delivery failed for user %s to %s (error=%s). "
            "Verification row id=%s is stored; user may retry.",
            current_user.id, _masked(body.phone), sms_result.error, pv.id,
        )
        ...  # keep the existing 500-return branch exactly as-is
```

Remove the `get_vonage_sms_provider` import. Preserve the existing "row kept, return 500" semantics verbatim.

- [ ] **Step 4: Delete the legacy client**: `git rm backend/app/services/communication/vonage_sms.py`. Grep for stragglers: `grep -rn "get_vonage_sms_provider\|VonageSmsProvider" backend/app backend/tests` — update/remove every hit (its dedicated test file gets deleted; any monkeypatches in `phone_verification` tests switch to patching `VonageSmsMessagesClient.send_text` as in Step 1).

- [ ] **Step 5: Run the phone-verification + new test files** — expected PASS; then commit: `git commit -m "feat(sms): deliver OTP via unified async Messages client, retire legacy SMS client"`.

### Task 2: Sentinel members never enter verification (backend guard)

**Files:**
- Modify: `backend/app/routers/phone_verification.py` (top of `start_verification`)
- Test: `backend/tests/test_phone_verification_delivery.py`

**Interfaces:**
- Consumes: `PLACEHOLDER_PHONE_E164` + `is_placeholder_phone` from `app/utils/phone.py`; `_normalize_phone_e164` already used in the router.
- Produces: `422 {"detail": "This phone number is a placeholder and can't receive texts."}` for the sentinel.

- [ ] **Step 1: Failing test** (append):

```python
async def test_sentinel_phone_cannot_start_verification(client, member_tokens):
    res = await _start_verification(client, member_tokens, phone="+15555555555")
    assert res.status_code == 422
    assert "placeholder" in res.json()["detail"].lower()
```

- [ ] **Step 2: Run — FAIL** (currently attempts the send).
- [ ] **Step 3: Implement** — after the router normalizes the phone, add:

```python
    from app.utils.phone import is_placeholder_phone

    if is_placeholder_phone(normalized):
        raise HTTPException(
            status_code=422,
            detail="This phone number is a placeholder and can't receive texts.",
        )
```

- [ ] **Step 4: Run — PASS.** **Step 5: Commit** `feat(sms): block placeholder phone from verification (treated as opted out)`.

### Task 3: Member "Confirm your phone" step after signup (frontend)

**Files:**
- Create: `native/src/screens/auth/VerifyPhoneScreen.tsx`
- Modify: `native/src/navigation/AppNavigator.tsx` (register `VerifyPhone` in the Auth stack beside `Register`), `native/src/screens/auth/RegisterScreen.tsx` (post-success navigation for role=member), `native/src/hooks/useApiQueries.ts` (two small mutations)
- Test: `native/src/screens/auth/VerifyPhoneScreen.test.tsx`

**Interfaces:**
- Consumes: `POST /phone/start-verification {phone}` and `POST /phone/confirm-verification {phone, code}` (existing endpoints); `api()` client; auth context (user is logged in right after register).
- Produces: hooks `useStartPhoneVerification()` and `useConfirmPhoneVerification()` in `useApiQueries.ts` (mutations, `toSnakeCase` payloads) — Task 4 reuses BOTH; route name `VerifyPhone` taking `{ phone: string }`.

- [ ] **Step 1: Hooks** in `useApiQueries.ts` (mirror `useCreateCaseNote`'s shape):

```ts
export function useStartPhoneVerification() {
  return useMutation({
    mutationFn: async (payload: { phone: string }) => {
      await api('/phone/start-verification', {
        method: 'POST',
        body: JSON.stringify(toSnakeCase(payload)),
      });
    },
  });
}

export function useConfirmPhoneVerification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { phone: string; code: string }) => {
      await api('/phone/confirm-verification', {
        method: 'POST',
        body: JSON.stringify(toSnakeCase(payload)),
      });
    },
    onSuccess: () => {
      // phone_verified_at changed — member profile drives the settings card state.
      void qc.invalidateQueries({ queryKey: queryKeys.memberProfile });
    },
  });
}
```

- [ ] **Step 2: Screen.** `VerifyPhoneScreen` renders: title "Confirm your phone", copy "We texted a 6-digit code to {phone}. Enter it below to turn on text messages from your CHW.", a 6-digit `TextInput` (numeric, `accessibilityLabel="Verification code"`), primary button "Confirm" (calls confirm mutation; on success navigate to the member home stack), link button "Verify later" (`accessibilityLabel="Skip verification"`, navigates on without confirming), inline red error on 4xx (reuse the `colors.destructive` fieldError convention from `ResetPasswordScreen`), and a "Resend code" link calling the start mutation (disabled 30s after tap). On mount it does NOT auto-send — RegisterScreen triggers the first send before navigating (Step 3) so the screen never double-texts. Follow `ResetPasswordScreen.tsx` structure/styles closely.

- [ ] **Step 3: Wire from RegisterScreen.** In the register-success path, for `role === 'member'` whose submitted phone is real (not `5555555555`-normalized — reuse the literal check on the raw digits), fire `startVerification.mutate({ phone })` best-effort and `navigation.navigate('VerifyPhone', { phone })`; CHWs and sentinel-phone members keep today's destination unchanged.

- [ ] **Step 4: Tests** (`VerifyPhoneScreen.test.tsx`, jsdom pattern from `ResetPasswordScreen.test.tsx`): renders code input + both actions; happy path posts `/phone/confirm-verification` with `{phone, code}` and navigates; 410/422 from confirm shows inline error and stays; "Verify later" navigates without any confirm call; resend calls start endpoint. Plus a `RegisterScreen.test.tsx` addition: member with real phone navigates to `VerifyPhone`; member with `555-555-5555` does not.

- [ ] **Step 5: Run** `bun run test` (full) + `bun run typecheck` — PASS. **Commit** `feat(member): verify-phone step after signup (turns on SMS eligibility)`.

### Task 4: "Text messages" card in Member Settings (frontend)

**Files:**
- Modify: `native/src/screens/member/MemberSettingsScreen.tsx` (new card between the Profile card and Privacy & Security), `native/src/screens/member/MemberSettingsScreen.test.tsx`

**Interfaces:**
- Consumes: `useMemberProfile()` (exposes `phone`; backend `MemberProfileResponse` already returns user fields — confirm it exposes `phone_verified_at`; if not, add it to the response schema + the FE type in this task), Task 3's two hooks and the same inline code-entry UX (compact, in-card).
- Produces: nothing downstream.

- [ ] **Step 1: Backend field check** — if `MemberProfileResponse` lacks `phone_verified_at`, add `phone_verified_at: datetime | None = None` to the schema (`backend/app/schemas/user.py`) — it serializes from the joined User row like `phone` does — plus a 1-line backend test asserting it's present in `GET /member/profile`.
- [ ] **Step 2: Card states.** Sentinel phone (`+15555555555` normalized) → card hidden entirely. Verified (`phoneVerifiedAt != null`) → static row "Text messages: On — we text you at {last-4}. Reply STOP anytime to opt out." Unverified real phone → "Turn on text messages" body copy + "Send code" button → inline 6-digit input + Confirm (same two hooks; on success the profile query invalidates and the card flips to On).
- [ ] **Step 3: Tests**: three states render correctly from profile fixtures; confirm flow fires both endpoints; sentinel fixture renders no card. Run full `bun run test` + `bun run typecheck`.
- [ ] **Step 4: Commit** `feat(member): settings card to turn on text messages`.

### Task 5: PR-1 finish line

- [ ] Full backend suite green on YOUR isolated DB (ignore only the 4 known S3 `test_session_chat` local failures); full `bun run test` + `bun run typecheck`; no lockfile diffs.
- [ ] Push `feat/sms1-verify-unify`; open PR titled `feat(sms): phone verification at signup + unified SMS client (Spec 1, PR-1)` with body listing Tasks 1–4 and the spec path. Body ends with the 🤖 Generated with [Claude Code](https://claude.com/claude-code) line.

---

### Task 6: STOP-prompt helper with 24h cadence (backend)

**Files:**
- Create: `backend/alembic/versions/stopprompt0715_add_last_stop_prompt_at.py` — **PR-2 ships its own migration** for the model column it adds (a model column whose migration lands in a LATER PR would deploy new ORM code against an old schema and 500 member reads — the exact cinhash0715 incident mode; never do that): `revision="stopprompt0715"`, `down_revision="cinhash0715"`, upgrade = `op.add_column("member_profiles", sa.Column("last_stop_prompt_at", sa.DateTime(timezone=True), nullable=True))`, downgrade drops it.
- Modify: `backend/app/routers/conversations.py` (beside `brand_outbound_sms`, line ~702), `backend/app/models/user.py` (MemberProfile column, in lockstep with the migration above), callers: `_fanout_sms_for_chw_message` (~:778), `send_sms` (~:1094), `sms_notifications.py::_send_best_effort` (:101), `signup_confirmations.py::_send_confirmation_sms`
- Test: `backend/tests/test_sms_stop_prompt.py`

**Interfaces:**
- Consumes: `MemberProfile.last_stop_prompt_at` (new nullable `DateTime(timezone=True)` column on the model).
- Produces: `async def with_stop_prompt(db, member_profile, body: str) -> str` in `conversations.py` — appends `" Reply STOP to opt out."` and stamps `member_profile.last_stop_prompt_at = now` when null or >24h old; otherwise returns body unchanged. Callers pass the branded body through it JUST before `send_text`. The caller's existing commit persists the stamp (all call sites already commit after send).

- [ ] **Step 1: Failing tests**:

```python
"""STOP-prompt cadence: first member-facing SMS in any 24h window carries the
opt-out line; subsequent sends inside the window don't (Spec 1 §2)."""
from datetime import UTC, datetime, timedelta

STOP_LINE = "Reply STOP to opt out."

async def test_first_send_appends_prompt_and_stamps(db_member_profile):
    from app.routers.conversations import with_stop_prompt
    body = await with_stop_prompt(db, db_member_profile, "Compass: hello")
    assert body.endswith(STOP_LINE)
    assert db_member_profile.last_stop_prompt_at is not None

async def test_second_send_within_24h_is_clean(db_member_profile):
    from app.routers.conversations import with_stop_prompt
    db_member_profile.last_stop_prompt_at = datetime.now(UTC) - timedelta(hours=1)
    body = await with_stop_prompt(db, db_member_profile, "Compass: again")
    assert STOP_LINE not in body

async def test_prompt_returns_after_24h(db_member_profile):
    from app.routers.conversations import with_stop_prompt
    db_member_profile.last_stop_prompt_at = datetime.now(UTC) - timedelta(hours=25)
    body = await with_stop_prompt(db, db_member_profile, "Compass: later")
    assert body.endswith(STOP_LINE)
```

(Fixture: create a member + profile via the file-local session factory exactly as `tests/test_sms_eligibility.py` builds its rows.) Plus one integration test per call path: fanout first-SMS body ends with the line (extend `tests/test_message_sms_fanout.py` mock-capture pattern); reminder SMS gets it (extend `tests/test_sms_notifications.py`).

- [ ] **Step 2: FAIL. Step 3: Implement** the helper + model column + wire the four call sites (each passes its final branded body through `with_stop_prompt` immediately before `send_text`; `_send_best_effort` gains optional `db`/`member_profile` kwargs, None ⇒ unchanged behavior for CHW-facing sends). **Step 4: PASS. Step 5: Commit** `feat(sms): STOP opt-out prompt on first outbound SMS per 24h`.

### Task 7: `sms_mirroring_enabled` kill switch (backend)

**Files:**
- Modify: `backend/app/config.py` (`sms_mirroring_enabled: bool = True` near the other feature flags ~:94), `conversations.py::_fanout_sms_for_chw_message` (early return), `sms_notifications.py` (top of each member-facing send), `signup_confirmations.py::_send_confirmation_sms`
- Test: `backend/tests/test_sms_stop_prompt.py` (append)

**Interfaces:** Produces: flag consumed by every member-facing SMS path EXCEPT OTP delivery (spec §5).

- [ ] **Step 1: Failing test** — with `settings.sms_mirroring_enabled` monkeypatched False: fanout sends nothing (assert mock not called, in-app message still persisted); OTP start-verification STILL sends. **Step 2: FAIL. Step 3:** add flag + early returns (`if not settings.sms_mirroring_enabled: return`). **Step 4: PASS. Step 5: Commit** `feat(sms): runtime kill switch for member-facing SMS (OTP exempt)`.

### Task 8: Three confirmation sends (backend)

**Files:**
- Modify: `backend/app/services/sms_notifications.py` (three new functions at the bottom, following `send_session_reminder_sms`'s member-leg pattern exactly), hooks in `backend/app/routers/requests.py` (`create_request` — member ack; and the accept path beside `send_request_accepted_email` at :379) and `backend/app/routers/sessions.py` (confirm :393 region, cancel :497 handler, and the schedule-time-change path — locate the propose/rebook flow used by "Propose New Time" in `test_sms_messaging`/calendar tests and hook the member-notify there)
- Test: `backend/tests/test_sms_confirmations.py`

**Interfaces:**
- Consumes: `check_sms_eligibility`, `_send_best_effort(to, body, context=..., db=db, member_profile=profile)` (Task 6 signature), `record_touch(kind='sms')`, `settings.sms_mirroring_enabled` (Task 7), the reminder SMS's existing local-time formatter for dates.
- Produces (all `-> None`, best-effort, never raise):

```python
async def send_request_received_sms(db, *, member_user, member_profile, chw_first_name: str) -> None: ...
async def send_session_confirmed_sms(db, *, member_user, member_profile, chw_first_name: str, scheduled_at) -> None: ...
async def send_session_changed_sms(db, *, member_user, member_profile, old_scheduled_at, new_scheduled_at | None, cancelled: bool) -> None: ...
```

Bodies (exact copy, brand prefix added by `brand_outbound_sms`):
- request received: `"We got your session request — {chw_first} will confirm a time shortly."`
- confirmed: `"Your session with {chw_first} is confirmed for {formatted_datetime}."`
- cancelled: `"Your {formatted_date} session was cancelled."`
- rescheduled: `"Your session moved to {formatted_datetime}."`

- [ ] **Step 1: Failing tests** — for each function: eligible member → exactly one `send_text` with the exact body (mock-capture), touch row written with kind `sms`, no PHI beyond first name (assert no last name/email/DOB in body); ineligible (sentinel/unverified/opted-out) → zero sends, no raise; flag off → zero sends. For each hook: hitting the real endpoint transition fires the right function once (patch the function, assert awaited with correct args) and a failure inside it never breaks the endpoint (side_effect=RuntimeError → endpoint still 200).
- [ ] **Step 2: FAIL. Step 3:** implement functions + hooks (each hook lives immediately beside the existing email/push trigger at that transition; wrap in the same try/except best-effort style as the neighboring notify code). **Step 4: PASS. Step 5: Commit** `feat(sms): request/confirm/cancel/reschedule confirmation texts`.

### Task 9: PR-2 finish line

- [ ] Full backend suite green (isolated DB, known-S3 exceptions only); `alembic heads` sane; `bun run test`/`typecheck` (FE untouched — still run, it's cheap); push `feat/sms1-confirmations`; PR `feat(sms): STOP prompt, kill switch, confirmation texts (Spec 1, PR-2)`; body lists Tasks 6–8 + the `stopprompt0715` migration + spec path + 🤖 line.

---

### Task 10: Migration — delivery status + STOP-prompt column + alembic head merge

**Files:**
- Create: `backend/alembic/versions/smsdlv0715_delivery_status_and_stop_prompt.py`
- Modify: `backend/app/models/conversation.py` (Message: two new columns)
- Test: `backend/tests/test_sms_delivery_status.py` (schema assertions ride on `create_all`)

**Interfaces:**
- Produces: `messages.delivery_status` (`String(16)`, nullable), `messages.delivery_failed_reason` (`String(64)`, nullable), `member_profiles.last_stop_prompt_at` (`DateTime(timezone=True)`, nullable). Values written by Task 11: `"delivered"` / `"failed"`.
- **IMPORTANT:** heads at time of writing are the QA3 parallel heads `casenote0715` and `cinhash0715`; PR-2 adds `stopprompt0715` on top of `cinhash0715` (Task 6). This migration merges everything to ONE head — verify the actual head set first with `cd backend && ls alembic/versions | grep 0715` and list ALL current heads in `down_revision`:

```python
revision: str = "smsdlv0715"
down_revision = ("casenote0715", "stopprompt0715")  # merge to a single head; adjust to actual heads
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.add_column("messages", sa.Column("delivery_status", sa.String(16), nullable=True))
    op.add_column("messages", sa.Column("delivery_failed_reason", sa.String(64), nullable=True))

def downgrade() -> None:
    op.drop_column("messages", "delivery_failed_reason")
    op.drop_column("messages", "delivery_status")
```

- [ ] Steps: write migration + model columns → `alembic heads` shows exactly ONE head (`smsdlv0715`) → full test run proves `create_all` parity → commit `feat(sms): delivery-status columns + alembic head merge`.

### Task 11: Delivery-status webhook (backend)

**Files:**
- Modify: `backend/app/routers/communication.py` (new endpoint beside `sms_inbound` ~:1040, reusing `_verify_vonage_signature` and `_safely_read_body`)
- Test: `backend/tests/test_sms_delivery_status.py`

**Interfaces:**
- Consumes: `Message.provider_message_id` (existing, set on all outbound SMS Message rows); Vonage status payload shape `{"message_uuid": "...", "status": "delivered"|"rejected"|"undeliverable"|"submitted", "error": {"reason": "..."}?}`.
- Produces: `POST /api/v1/communication/sms/status` → maps `delivered`→`delivery_status="delivered"`; `rejected`/`undeliverable`→`"failed"` + `delivery_failed_reason` (error reason or the status word, truncated to 64); `submitted`/unknown → 200 no-op; unmatched `message_uuid` → 200 no-op (log info). Idempotent: re-delivery of the same status is a no-op write. Response body `{"status": "ok", "note": "<applied|ignored|unmatched>"}`. For notification sends without a Message row, status lands in the matching `CommunicationTouch.extra_data["delivery_status"]` when a touch row with that `provider_session_id` exists; else dropped.

- [ ] **Step 1: Failing tests** — signature: unsigned request → 401 (reuse the forged-sig pattern from `test_sms_messaging.py`); `delivered` stamps the Message row; `undeliverable` stamps failed + reason; `submitted` leaves nulls; unknown uuid → 200 `unmatched`; replay of same payload → 200, row unchanged; malformed JSON → 200 no-op (webhook never 500s — no-unhandled-500 rule).
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS. Step 5: Commit** `feat(sms): Vonage delivery-status webhook stamps per-message state`.

### Task 12: "Not delivered" indicator in CHW thread (frontend)

**Files:**
- Modify: `native/src/screens/chw/CHWMessagesScreen.tsx` (message bubble row), `native/src/hooks/useApiQueries.ts` (Message type gains `deliveryStatus?: 'delivered' | 'failed' | null`), backend `backend/app/schemas/conversation.py` message response (expose `delivery_status`)
- Test: `native/src/screens/chw/CHWMessagesScreen.test.tsx` (extend), 1 backend schema test

**Interfaces:** Consumes Task 10/11's column via the conversation messages response.

- [ ] **Step 1:** backend: add `delivery_status` to the message response schema (+ assert in an existing conversation-fetch test). **Step 2:** FE: on CHW-sent bubbles where `deliveryStatus === 'failed'`, render under the bubble: `Not delivered by text — member will see it in the app.` (muted small text, `accessibilityLiveRegion` not needed; style like the existing timestamp row). Render NOTHING for `delivered`/null. **Step 3:** tests: fixture message with failed → indicator text present; delivered/null → absent. Full `bun run test` + `typecheck`. **Step 4: Commit** `feat(chw): not-delivered indicator on mirrored texts`.

### Task 13: PR-3 finish line

- [ ] Full backend suite green (isolated DB); `alembic heads` = single head; `bun run test` + `typecheck`; push `feat/sms1-delivery-status`; PR `feat(sms): delivery-status tracking + head merge (Spec 1, PR-3)`; body lists Tasks 10–12, flags the merge revision, + 🤖 line.

---

## Self-review checklist (done at planning time)

- Spec §1 → Tasks 1–5; §2 → Task 6 (+ §5 flag in 7); §3 → Task 8; §4 → Tasks 10–12; §5 → Tasks 5/7/9/13. No gaps.
- Placeholders: none — every body/copy/status mapping is spelled out.
- Type consistency: `with_stop_prompt(db, member_profile, body)` used identically in Tasks 6/8; `SmsSendResult` fields match `vonage_sms.py:64`; hook signatures in Task 8's Produces block are the ones its Step 3 implements.
