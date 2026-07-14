"""Tests for Epic A — best-effort post-signup confirmation email + SMS.

Covers all three account-creation surfaces:
  - Self-service signup (``POST /api/v1/auth/register``)
  - Social/OAuth signup (``POST /api/v1/auth/oauth/google``)
  - CHW-initiated member onboarding (``POST /api/v1/chw/members``)

The core guarantee under test: a confirmation email (and, for SMS-eligible
members, a confirmation SMS) is sent on every register path, and a failure
of either send NEVER fails the HTTP request or leaves the account
unpersisted (requests still return 201 with the row committed).

Mocking strategy mirrors the codebase's existing conventions:
  - Email: patch ``app.services.email.send_signup_confirmation_email``
    (mirrors ``tests/test_phase1b.py``'s
    ``monkeypatch.setattr(email_module, "send_request_accepted_email", ...)``).
  - SMS: patch ``app.services.vonage_sms.VonageSmsMessagesClient.send_text``
    (mirrors ``tests/test_message_sms_fanout.py``).
  - Background tasks run inline under ``ASGITransport`` before the test's
    ``await client.post(...)`` returns, so assertions can be made
    immediately after the response without any extra waiting/sleeping.
"""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.user import User
from app.services.email import EmailResult
from app.services.vonage_sms import SmsSendResult
from tests.conftest import auth_header, complete_member_signup_payload
from tests.conftest import test_session as _test_session_factory

# NOTE: no module-level `pytestmark = pytest.mark.asyncio` here — this file
# mixes async (HTTP-flow) tests with a couple of plain-sync unit tests for
# the email template renderer, and pytest.ini's `asyncio_mode = "auto"`
# already auto-detects async def tests without an explicit marker.


CHW_PAYLOAD = {
    "email": "signup.confirm.chw@example.com",
    "password": "testpass123",
    "name": "Confirm CHW",
    "role": "chw",
}

CHW_CREATE_MEMBER_PAYLOAD = {
    "email": "chw.created.member@example.com",
    "temp_password": "temp-pass-1234",
    "name": "New Onboarded Member",
    "phone": "+13105550199",
    "date_of_birth": "1990-04-12",
    "gender": "Female",
    "insurance_company": "Health Net",
    "medi_cal_id": "91234567A",
    "address_line1": "742 Evergreen Ter",
    "city": "Los Angeles",
    "state": "CA",
    "zip_code": "90001",
    "terms_accepted": True,
    "communications_consent": True,
}


# ─── A1: self-signup triggers a confirmation email ─────────────────────────


async def test_self_signup_sends_confirmation_email(client: AsyncClient):
    fake_send = AsyncMock(
        return_value=EmailResult(success=True, provider_message_id="ses-msg-1")
    )
    with patch("app.services.email.send_signup_confirmation_email", fake_send):
        res = await client.post(
            "/api/v1/auth/register",
            json={
                "email": "confirm.email.member@example.com",
                "password": "password123",
                "name": "Email Confirm Member",
                "role": "member",
                **{
                    k: v
                    for k, v in complete_member_signup_payload(
                        email="confirm.email.member@example.com"
                    ).items()
                    if k not in {"email", "password", "name", "role"}
                },
            },
        )
    assert res.status_code == 201, res.text

    fake_send.assert_awaited_once()
    _, kwargs = fake_send.call_args
    assert kwargs["to"] == "confirm.email.member@example.com"
    assert kwargs["name"]  # non-empty


async def test_chw_self_signup_sends_confirmation_email(client: AsyncClient):
    """Email fires for CHW role too — the copy is role-agnostic (Epic A)."""
    fake_send = AsyncMock(
        return_value=EmailResult(success=True, provider_message_id="ses-msg-2")
    )
    with patch("app.services.email.send_signup_confirmation_email", fake_send):
        res = await client.post("/api/v1/auth/register", json=CHW_PAYLOAD)
    assert res.status_code == 201, res.text

    fake_send.assert_awaited_once()
    _, kwargs = fake_send.call_args
    assert kwargs["to"] == CHW_PAYLOAD["email"]
    assert kwargs["name"] == CHW_PAYLOAD["name"]


# ─── A2: SMS-eligible member gets a confirmation SMS on creation ───────────


async def test_chw_created_member_with_verified_phone_gets_confirmation_sms(
    client: AsyncClient, chw_tokens: dict
):
    """A member who is ALREADY SMS-eligible at creation time (verified phone,
    not opted out, no duplicate) gets a confirmation SMS.

    In practice this only happens if the phone was verified before this
    call — e.g. re-registration edge cases. We simulate that by seeding
    phone_verified_at via a first pass that fails, or more directly: since
    check_sms_eligibility runs against DB state fetched fresh in the
    background task (which reads the just-committed row), we cannot
    pre-verify before the row exists. Instead, this test creates the member
    then relies on the fact that the background task re-fetches from the
    SAME session — so we monkeypatch check_sms_eligibility's underlying
    dependency by pre-seeding phone_verified_at is not possible pre-creation.

    Practical approach: patch check_sms_eligibility directly to simulate an
    eligible member, isolating this test from the (unverified-by-default)
    real eligibility gate, and assert the confirmation SMS pipeline (brand
    prefix + Vonage client) is invoked correctly when eligibility says yes.
    """
    from app.services.sms_eligibility import SmsEligibilityResult

    fake_eligible = AsyncMock(
        return_value=SmsEligibilityResult(eligible=True, normalized_phone="+13105550199")
    )
    fake_send_text = AsyncMock(
        return_value=SmsSendResult(success=True, provider_message_id="vonage-msg-1")
    )
    with patch(
        "app.services.sms_eligibility.check_sms_eligibility", fake_eligible
    ), patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send_text
    ):
        res = await client.post(
            "/api/v1/chw/members",
            json=CHW_CREATE_MEMBER_PAYLOAD,
            headers=auth_header(chw_tokens),
        )
    assert res.status_code == 201, res.text

    fake_send_text.assert_awaited_once()
    call_args = fake_send_text.call_args
    to_number, body = call_args.args[0], call_args.args[1]
    assert to_number == "+13105550199"
    assert body.startswith("Compass:")


async def test_ineligible_member_does_not_get_confirmation_sms(
    client: AsyncClient, chw_tokens: dict
):
    """Default case: a freshly CHW-created member has an UNVERIFIED phone
    (phone_verified_at is only ever set via the separate OTP flow), so the
    real (unpatched) eligibility check must say ineligible and the SMS
    sender must never be called."""
    fake_send_text = AsyncMock(
        return_value=SmsSendResult(success=True, provider_message_id="vonage-msg-should-not-fire")
    )
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send_text):
        res = await client.post(
            "/api/v1/chw/members",
            json=CHW_CREATE_MEMBER_PAYLOAD,
            headers=auth_header(chw_tokens),
        )
    assert res.status_code == 201, res.text
    fake_send_text.assert_not_awaited()


async def test_opted_out_member_does_not_get_confirmation_sms(
    client: AsyncClient, chw_tokens: dict
):
    """A member who is SMS-verified but has opted out (sms_opt_out=True)
    must not receive the confirmation SMS, even though the phone is
    otherwise eligible."""
    from app.services.sms_eligibility import SmsEligibilityResult

    fake_eligible = AsyncMock(
        return_value=SmsEligibilityResult(
            eligible=False, reason_code="opted_out", detail="opted out"
        )
    )
    fake_send_text = AsyncMock(
        return_value=SmsSendResult(success=True, provider_message_id="should-not-fire")
    )
    with patch(
        "app.services.sms_eligibility.check_sms_eligibility", fake_eligible
    ), patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send_text
    ):
        res = await client.post(
            "/api/v1/chw/members",
            json=CHW_CREATE_MEMBER_PAYLOAD,
            headers=auth_header(chw_tokens),
        )
    assert res.status_code == 201, res.text
    fake_send_text.assert_not_awaited()


async def test_chw_role_never_gets_confirmation_sms(client: AsyncClient):
    """SMS is member-only — a CHW self-registering must never trigger the
    SMS pipeline (the notification helper gates on role == 'member')."""
    fake_send_text = AsyncMock(
        return_value=SmsSendResult(success=True, provider_message_id="should-not-fire")
    )
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send_text):
        res = await client.post("/api/v1/auth/register", json=CHW_PAYLOAD)
    assert res.status_code == 201, res.text
    fake_send_text.assert_not_awaited()


# ─── Critical regression: send failures never fail registration ───────────


async def test_email_send_failure_does_not_fail_self_signup(client: AsyncClient):
    """A raising email provider must not fail /auth/register — still 201,
    and the user row is durably persisted afterward."""

    async def boom(*args, **kwargs):
        raise RuntimeError("SES outage simulated")

    payload = {
        "email": "email.failure.member@example.com",
        "password": "password123",
        "name": "Email Failure Member",
        "role": "member",
        **{
            k: v
            for k, v in complete_member_signup_payload(
                email="email.failure.member@example.com"
            ).items()
            if k not in {"email", "password", "name", "role"}
        },
    }

    with patch("app.services.email.send_signup_confirmation_email", boom):
        res = await client.post("/api/v1/auth/register", json=payload)

    assert res.status_code == 201, res.text
    body = res.json()
    assert "access_token" in body

    async with _test_session_factory() as db:
        result = await db.execute(
            select(User).where(User.email == "email.failure.member@example.com")
        )
        user = result.scalar_one_or_none()
        assert user is not None, "User row must be persisted despite email failure"


async def test_email_send_failure_does_not_fail_chw_create_member(
    client: AsyncClient, chw_tokens: dict
):
    """A raising email provider must not fail POST /chw/members — still
    201, and the member row (+ CHW-link) is durably persisted afterward."""

    async def boom(*args, **kwargs):
        raise RuntimeError("SES outage simulated")

    with patch("app.services.email.send_signup_confirmation_email", boom):
        res = await client.post(
            "/api/v1/chw/members",
            json=CHW_CREATE_MEMBER_PAYLOAD,
            headers=auth_header(chw_tokens),
        )

    assert res.status_code == 201, res.text
    body = res.json()

    async with _test_session_factory() as db:
        result = await db.execute(
            select(User).where(User.email == CHW_CREATE_MEMBER_PAYLOAD["email"])
        )
        user = result.scalar_one_or_none()
        assert user is not None, "Member row must be persisted despite email failure"
        assert str(user.id) == body["id"]


async def test_sms_send_failure_does_not_fail_chw_create_member(
    client: AsyncClient, chw_tokens: dict
):
    """A raising (or failed) SMS send must not fail POST /chw/members even
    when the member is SMS-eligible — still 201, member row persisted."""
    from app.services.sms_eligibility import SmsEligibilityResult

    fake_eligible = AsyncMock(
        return_value=SmsEligibilityResult(eligible=True, normalized_phone="+13105550199")
    )

    async def boom(*args, **kwargs):
        raise RuntimeError("Vonage outage simulated")

    with patch(
        "app.services.sms_eligibility.check_sms_eligibility", fake_eligible
    ), patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text", boom
    ):
        res = await client.post(
            "/api/v1/chw/members",
            json=CHW_CREATE_MEMBER_PAYLOAD,
            headers=auth_header(chw_tokens),
        )

    assert res.status_code == 201, res.text
    body = res.json()

    async with _test_session_factory() as db:
        result = await db.execute(
            select(User).where(User.email == CHW_CREATE_MEMBER_PAYLOAD["email"])
        )
        user = result.scalar_one_or_none()
        assert user is not None
        assert str(user.id) == body["id"]


async def test_sms_provider_returning_failure_result_does_not_raise(
    client: AsyncClient, chw_tokens: dict
):
    """A clean (non-raising) SmsSendResult(success=False) — e.g. SES/Vonage
    sandbox rejection — must be swallowed silently: 201, member persisted,
    no exception propagates."""
    from app.services.sms_eligibility import SmsEligibilityResult

    fake_eligible = AsyncMock(
        return_value=SmsEligibilityResult(eligible=True, normalized_phone="+13105550199")
    )
    fake_send_text = AsyncMock(
        return_value=SmsSendResult(success=False, error="vonage_status_500", status_code=500)
    )
    with patch(
        "app.services.sms_eligibility.check_sms_eligibility", fake_eligible
    ), patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send_text
    ):
        res = await client.post(
            "/api/v1/chw/members",
            json=CHW_CREATE_MEMBER_PAYLOAD,
            headers=auth_header(chw_tokens),
        )

    assert res.status_code == 201, res.text
    fake_send_text.assert_awaited_once()


# ─── OAuth / social signup also triggers the confirmation email ───────────


async def test_google_oauth_new_signup_sends_confirmation_email(client: AsyncClient):
    from app.services.oauth_verification import OAuthIdentity

    identity = OAuthIdentity(
        email="newgoogle.confirm@example.com",
        email_verified=True,
        name="New Google Confirm User",
        provider="google",
        subject="g-sub-confirm",
    )

    fake_send = AsyncMock(
        return_value=EmailResult(success=True, provider_message_id="ses-msg-oauth")
    )
    with patch("app.routers.auth._settings") as mock_s, \
         patch("app.routers.auth.verify_google_id_token", new_callable=AsyncMock, return_value=identity), \
         patch("app.routers.auth._sync_new_member_to_pear", new_callable=AsyncMock), \
         patch("app.routers.auth._append_new_member_to_csv", new_callable=AsyncMock), \
         patch("app.services.email.send_signup_confirmation_email", fake_send):
        mock_s.oauth_google_enabled = True
        mock_s.oauth_apple_enabled = False
        mock_s.refresh_token_expire_days = 7
        mock_s.access_token_expire_minutes = 15
        mock_s.secret_key = "test-secret-key-for-pytest-runner-placeholder-AABBCCDD"
        mock_s.member_csv_enabled = False
        mock_s.pear_suite_enabled = False

        res = await client.post(
            "/api/v1/auth/oauth/google", json={"id_token": "valid.google.token"}
        )

    assert res.status_code == 200, res.text
    fake_send.assert_awaited_once()
    _, kwargs = fake_send.call_args
    assert kwargs["to"] == "newgoogle.confirm@example.com"


async def test_google_oauth_existing_user_signin_does_not_resend_confirmation(
    client: AsyncClient,
):
    """Signing IN (existing account) must NOT re-fire the signup
    confirmation — only the sign-UP branch does."""
    from app.services.oauth_verification import OAuthIdentity

    # First create the account normally (self-service register).
    register_payload = {
        "email": "existing.oauth.user@example.com",
        "password": "password123",
        "name": "Existing OAuth User",
        "role": "member",
        **{
            k: v
            for k, v in complete_member_signup_payload(
                email="existing.oauth.user@example.com"
            ).items()
            if k not in {"email", "password", "name", "role"}
        },
    }
    reg_res = await client.post("/api/v1/auth/register", json=register_payload)
    assert reg_res.status_code == 201, reg_res.text

    identity = OAuthIdentity(
        email="existing.oauth.user@example.com",
        email_verified=True,
        name="Existing OAuth User",
        provider="google",
        subject="g-sub-existing",
    )

    fake_send = AsyncMock(
        return_value=EmailResult(success=True, provider_message_id="should-not-fire")
    )
    with patch("app.routers.auth._settings") as mock_s, \
         patch("app.routers.auth.verify_google_id_token", new_callable=AsyncMock, return_value=identity), \
         patch("app.services.email.send_signup_confirmation_email", fake_send):
        mock_s.oauth_google_enabled = True
        mock_s.oauth_apple_enabled = False
        mock_s.refresh_token_expire_days = 7
        mock_s.access_token_expire_minutes = 15
        mock_s.secret_key = "test-secret-key-for-pytest-runner-placeholder-AABBCCDD"

        res = await client.post(
            "/api/v1/auth/oauth/google", json={"id_token": "valid.google.token"}
        )

    assert res.status_code == 200, res.text
    fake_send.assert_not_awaited()


# ─── CHW-created member also gets the confirmation email ───────────────────


async def test_chw_created_member_gets_confirmation_email(
    client: AsyncClient, chw_tokens: dict
):
    fake_send = AsyncMock(
        return_value=EmailResult(success=True, provider_message_id="ses-msg-chw-created")
    )
    with patch("app.services.email.send_signup_confirmation_email", fake_send):
        res = await client.post(
            "/api/v1/chw/members",
            json=CHW_CREATE_MEMBER_PAYLOAD,
            headers=auth_header(chw_tokens),
        )
    assert res.status_code == 201, res.text

    fake_send.assert_awaited_once()
    _, kwargs = fake_send.call_args
    assert kwargs["to"] == CHW_CREATE_MEMBER_PAYLOAD["email"]
    assert kwargs["name"] == CHW_CREATE_MEMBER_PAYLOAD["name"]


# ─── Unit-level coverage of the email template + notifications helper ─────


def test_render_signup_confirmation_email_has_nonempty_subject_and_body():
    from app.services.email import render_signup_confirmation_email

    subject, html, text = render_signup_confirmation_email("Jamie")
    assert subject.strip()
    assert "Jamie" in html
    assert "Jamie" in text
    # v2 (Epic A v2): the self-signup member variant opens with "Welcome to
    # CompassCHW" rather than the old "Thanks for signing up" phrasing.
    assert "welcome to compasschw" in text.lower()


def test_render_signup_confirmation_email_handles_empty_name():
    from app.services.email import render_signup_confirmation_email

    subject, html, text = render_signup_confirmation_email("")
    assert subject.strip()
    assert "Hi there" in html or "Hi there" in text


# ─── Epic A v2: welcome email copy variants ────────────────────────────────


def test_self_signup_member_variant_has_next_steps_and_app_link_no_phi():
    """Self-signup member (role=member, created_by_chw=False): welcome +
    "what happens next" bullets (find your CHW, schedule your first
    session), app link, support contact, and "didn't create this account"
    disclaimer. Must NOT mention any CHW name or health information (no
    PHI) — the copy is intentionally generic."""
    from app.services.email import render_signup_confirmation_email

    subject, html, text = render_signup_confirmation_email(
        "Jamie", created_by_chw=False, role="member",
    )
    assert subject.strip()
    lowered_text = text.lower()

    # "What happens next" bullets.
    assert "find your community health worker" in lowered_text
    assert "schedule your first session" in lowered_text

    # App link + support contact.
    assert "https://joincompasschw.com" in text
    assert "support@joincompasschw.com" in text

    # Enumeration-safe disclaimer.
    assert "didn't create this account" in lowered_text

    # Must NOT contain the CHW-created variant's password-setup copy.
    assert "set your own password" not in lowered_text

    # No PHI: no CHW name (this variant never receives one) and no
    # health-related terms.
    for phi_term in ("diagnosis", "medication", "health condition", "medi-cal id"):
        assert phi_term not in lowered_text


def test_chw_created_member_variant_mentions_chw_created_account_and_password_setup():
    """CHW-created member (role=member, created_by_chw=True): same welcome
    shape as self-signup, plus "your CHW created your account" + "you'll
    set your own password at first sign-in" — but still no CHW name (no
    PHI)."""
    from app.services.email import render_signup_confirmation_email

    subject, html, text = render_signup_confirmation_email(
        "Alex", created_by_chw=True, role="member",
    )
    lowered_text = text.lower()

    assert "community health worker created your account" in lowered_text
    assert "set your own password" in lowered_text

    # Still has the same "what happens next" bullets as the self-signup variant.
    assert "find your community health worker" in lowered_text
    assert "schedule your first session" in lowered_text

    # Support contact present in this variant too.
    assert "support@joincompasschw.com" in text

    # No PHI — no CHW name is threaded into this template at all.
    for phi_term in ("diagnosis", "medication", "health condition"):
        assert phi_term not in lowered_text


def test_chw_account_signup_variant_uses_simple_welcome_copy():
    """CHW (role != member) signups keep the simple welcome copy — no
    member-facing "what happens next" bullets."""
    from app.services.email import render_signup_confirmation_email

    subject, html, text = render_signup_confirmation_email(
        "Morgan", created_by_chw=False, role="chw",
    )
    lowered_text = text.lower()

    assert "thanks for signing up" in lowered_text
    assert "find your community health worker" not in lowered_text
    assert "schedule your first session" not in lowered_text
    assert "support@joincompasschw.com" in text


def test_both_member_variants_contain_support_email():
    """Both the self-signup and CHW-created member variants must surface
    the support contact address."""
    from app.services.email import render_signup_confirmation_email

    _, _, self_signup_text = render_signup_confirmation_email(
        "Jamie", created_by_chw=False, role="member",
    )
    _, _, chw_created_text = render_signup_confirmation_email(
        "Alex", created_by_chw=True, role="member",
    )
    assert "support@joincompasschw.com" in self_signup_text
    assert "support@joincompasschw.com" in chw_created_text


async def test_chw_created_member_gets_the_chw_created_copy_variant_end_to_end(
    client: AsyncClient, chw_tokens: dict,
):
    """End-to-end: POST /chw/members must select the created_by_chw=True
    copy variant, not the plain self-signup welcome."""
    fake_send = AsyncMock(
        return_value=EmailResult(success=True, provider_message_id="ses-msg-variant")
    )
    with patch("app.services.email.get_email_provider") as mock_provider:
        mock_provider.return_value.send = fake_send
        res = await client.post(
            "/api/v1/chw/members",
            json=CHW_CREATE_MEMBER_PAYLOAD,
            headers=auth_header(chw_tokens),
        )
    assert res.status_code == 201, res.text

    fake_send.assert_awaited_once()
    (sent_message,), _ = fake_send.call_args
    assert "set your own password" in sent_message.text.lower()
    assert "community health worker created your account" in sent_message.text.lower()


async def test_self_signup_member_gets_the_plain_welcome_copy_variant_end_to_end(
    client: AsyncClient,
):
    """End-to-end: POST /auth/register (self-signup) must NOT select the
    created_by_chw copy variant."""
    fake_send = AsyncMock(
        return_value=EmailResult(success=True, provider_message_id="ses-msg-self")
    )
    payload = {
        "email": "variant.self.signup@example.com",
        "password": "password123",
        "name": "Variant Self Signup",
        "role": "member",
        **{
            k: v
            for k, v in complete_member_signup_payload(
                email="variant.self.signup@example.com"
            ).items()
            if k not in {"email", "password", "name", "role"}
        },
    }
    with patch("app.services.email.get_email_provider") as mock_provider:
        mock_provider.return_value.send = fake_send
        res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text

    fake_send.assert_awaited_once()
    (sent_message,), _ = fake_send.call_args
    assert "set your own password" not in sent_message.text.lower()
    assert "find your community health worker" in sent_message.text.lower()


async def test_send_signup_confirmations_noop_when_user_missing():
    """Defensive branch: user row not found (e.g. deleted between commit and
    background-task execution) — must return cleanly, no raise."""
    from uuid import uuid4

    from app.services.signup_confirmations import send_signup_confirmations

    # Must not raise.
    await send_signup_confirmations(uuid4())


async def test_send_signup_confirmations_unexpected_exception_is_swallowed():
    """Even an unexpected exception in the outer DB lookup (e.g. db.get
    itself raising) must not propagate out of the background task."""
    from uuid import uuid4

    from app.services.signup_confirmations import send_signup_confirmations

    with patch(
        "app.database.async_session",
        side_effect=RuntimeError("db connection pool exhausted"),
    ):
        # Must not raise even though async_session() itself blows up.
        try:
            await send_signup_confirmations(uuid4())
        except RuntimeError:
            pytest.fail(
                "send_signup_confirmations must never propagate an exception"
            )
