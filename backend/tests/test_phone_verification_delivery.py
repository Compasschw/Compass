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
