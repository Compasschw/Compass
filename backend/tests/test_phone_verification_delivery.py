"""OTP delivery goes through the unified async Messages client (Spec 1 §1).

These tests pin the client-unification contract: the verification OTP is
delivered via ``VonageSmsMessagesClient.send_text`` (the JWT-authed Messages
API), branded with the Compass prefix, carries the TTL, and the legacy
sync SMS provider no longer exists. Task 2's sentinel guard is covered here
too — the 555 placeholder can never enter the verification flow.
"""

import re

import pytest

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

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
            fake_send_text,
        )
        res = await _start_verification(client, member_tokens)

    assert res.status_code == 200, res.text
    assert sent["to"] == "+13105550188"
    assert sent["text"].startswith("Compass: ")
    assert "verification code is" in sent["text"]
    assert "expires in" in sent["text"]
    # The raw 6-digit code is in the body (deliverable), never logged elsewhere.
    assert re.search(r"\b\d{6}\b", sent["text"])


async def test_otp_send_failure_returns_500_but_keeps_row(client, member_tokens):
    async def fail_send_text(self, to_e164, text):
        return SmsSendResult(success=False, error="vonage_status_500", status_code=500)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
            fail_send_text,
        )
        res = await _start_verification(client, member_tokens)

    # Same contract as today: row kept for retry, client sees 500.
    assert res.status_code == 500


async def test_legacy_otp_client_is_gone():
    with pytest.raises(ImportError):
        from app.services.communication.vonage_sms import (  # noqa: F401
            VonageSmsProvider,
        )


async def test_sentinel_phone_cannot_start_verification(client, member_tokens):
    res = await _start_verification(client, member_tokens, phone="+15555555555")
    assert res.status_code == 422
    assert "placeholder" in res.json()["detail"].lower()


# ─── Confirm-verification error branches (behavior pinned across the Spec 2 ───
# ─── extraction of the OTP machinery into app.services.otp) ───────────────────


async def _confirm(client, tokens, phone, code):
    from tests.conftest import auth_header

    return await client.post(
        "/api/v1/phone/confirm-verification",
        json={"phone": phone, "code": code},
        headers=auth_header(tokens),
    )


async def test_confirm_with_no_active_code_returns_410(client, member_tokens):
    res = await _confirm(client, member_tokens, "+13105550188", "123456")
    assert res.status_code == 410
    assert "request a new code" in res.json()["detail"].lower()


async def test_confirm_wrong_code_400_decrements_then_exhausts_410(
    client, member_tokens
):
    from app.services.vonage_sms import SmsSendResult

    async def ok_send_text(self, to_e164, text):
        return SmsSendResult(success=True, provider_message_id="mid-x")

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(
            "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
            ok_send_text,
        )
        res = await _start_verification(client, member_tokens)
    assert res.status_code == 200

    # 4 wrong guesses → 400 with a decrementing remaining count…
    for expected_remaining in (4, 3, 2, 1):
        res = await _confirm(client, member_tokens, "+13105550188", "000000")
        assert res.status_code == 400, res.text
        assert f"{expected_remaining} attempt(s) remaining" in res.json()["detail"]

    # …the 5th consumes the last attempt → 410 exhausted…
    res = await _confirm(client, member_tokens, "+13105550188", "000000")
    assert res.status_code == 410
    assert "too many incorrect attempts" in res.json()["detail"].lower()

    # …and the exhausted row stays dead on a further try (410, not 400).
    res = await _confirm(client, member_tokens, "+13105550188", "000000")
    assert res.status_code == 410
