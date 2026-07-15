"""STOP-prompt cadence + sms_mirroring_enabled kill switch (SMS Output Spec 1
§2 + §5).

STOP-prompt cadence: the first member-facing SMS in any rolling 24h window
carries " Reply STOP to opt out."; subsequent sends inside the window don't;
the line returns after 24h. Implemented in ``with_stop_prompt`` and applied by
every member-facing send path (fanout, explicit send, confirmations,
reminders).

Kill switch: ``settings.sms_mirroring_enabled = False`` short-circuits every
member-facing SMS path (fanout here) to a no-op WITHOUT touching the in-app
send. OTP delivery is deliberately NOT behind the flag — phone verification
must always work.
"""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select

import app.config as _app_config_module
from app.models.conversation import Message
from app.models.user import MemberProfile, User
from app.services.vonage_sms import SmsSendResult
from tests.conftest import auth_header
from tests.conftest import test_session as _test_session_factory

STOP_LINE = "Reply STOP to opt out."


# ─── Unit tests for with_stop_prompt (the shared helper) ─────────────────────


@pytest.mark.asyncio
async def test_first_send_appends_prompt_and_stamps():
    from app.routers.conversations import with_stop_prompt

    profile = MemberProfile(last_stop_prompt_at=None)
    async with _test_session_factory() as db:
        body = await with_stop_prompt(db, profile, "Compass: hello")
    assert body.endswith(STOP_LINE)
    assert profile.last_stop_prompt_at is not None


@pytest.mark.asyncio
async def test_second_send_within_24h_is_clean():
    from app.routers.conversations import with_stop_prompt

    profile = MemberProfile(last_stop_prompt_at=datetime.now(UTC) - timedelta(hours=1))
    async with _test_session_factory() as db:
        body = await with_stop_prompt(db, profile, "Compass: again")
    assert STOP_LINE not in body
    assert body == "Compass: again"


@pytest.mark.asyncio
async def test_prompt_returns_after_24h():
    from app.routers.conversations import with_stop_prompt

    stamp = datetime.now(UTC) - timedelta(hours=25)
    profile = MemberProfile(last_stop_prompt_at=stamp)
    async with _test_session_factory() as db:
        body = await with_stop_prompt(db, profile, "Compass: later")
    assert body.endswith(STOP_LINE)
    # Re-stamped to the newer send time.
    assert profile.last_stop_prompt_at > stamp


@pytest.mark.asyncio
async def test_naive_stamp_is_normalized_before_compare():
    """A tz-naive last_stop_prompt_at (some drivers return naive) must not
    crash the aware/naive subtraction — it's normalized to UTC first."""
    from app.routers.conversations import with_stop_prompt

    naive_recent = (datetime.now(UTC) - timedelta(hours=1)).replace(tzinfo=None)
    profile = MemberProfile(last_stop_prompt_at=naive_recent)
    async with _test_session_factory() as db:
        body = await with_stop_prompt(db, profile, "Compass: hi")
    assert STOP_LINE not in body


# ─── Shared HTTP helpers (mirror tests/test_message_sms_fanout.py) ───────────


async def _register(client: AsyncClient, email: str, role: str) -> dict:
    payload: dict = {
        "email": email,
        "password": "Testpass123!",
        "name": f"Test {role.upper()} {email[:8]}",
        "role": role,
    }
    if role == "member":
        payload.update(
            {
                "date_of_birth": "1990-01-01",
                "gender": "Female",
                "insurance_company": "Health Net",
                "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
                "zip_code": "90001",
                "terms_accepted": True,
                "communications_consent": True,
            }
        )
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, f"Register failed: {res.text}"
    return res.json()


def _user_id_from_tokens(tokens: dict) -> str:
    parts = tokens["access_token"].split(".")
    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))["sub"]


async def _set_member_phone_verified(user_id: str, phone: str) -> None:
    async with _test_session_factory() as session:
        user = await session.get(User, UUID(user_id))
        assert user is not None
        user.phone = phone
        user.phone_verified_at = datetime.now(UTC)
        await session.commit()


async def _create_session_between(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict
) -> None:
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "STOP-prompt integration test request",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]
    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    res = await client.post(
        "/api/v1/sessions/",
        json={"request_id": request_id, "scheduled_at": "2026-07-20T10:00:00Z", "mode": "phone"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text


async def _find_or_create_conversation(
    client: AsyncClient, initiator_tokens: dict, peer_id: str
) -> str:
    res = await client.post(
        "/api/v1/conversations/find-or-create",
        json={"peer_id": peer_id},
        headers=auth_header(initiator_tokens),
    )
    assert res.status_code == 200, res.text
    return res.json()["id"]


async def _setup(client: AsyncClient, chw_email: str, member_email: str, phone: str):
    chw_tokens = await _register(client, chw_email, "chw")
    member_tokens = await _register(client, member_email, "member")
    member_id = _user_id_from_tokens(member_tokens)
    await _create_session_between(client, chw_tokens, member_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)
    await _set_member_phone_verified(member_id, phone)
    return chw_tokens, member_tokens, member_id, conv_id


async def _send_chw_message(client, chw_tokens, conv_id, body):
    return await client.post(
        f"/api/v1/conversations/{conv_id}/messages",
        json={"body": body},
        headers=auth_header(chw_tokens),
    )


# ─── Integration: fanout STOP-prompt cadence ─────────────────────────────────


@pytest.mark.asyncio
async def test_fanout_first_send_has_stop_line_second_does_not(client: AsyncClient):
    chw_tokens, _member_tokens, member_id, conv_id = await _setup(
        client, "stop_chw1@test.com", "stop_member1@test.com", "+15550400001"
    )

    fake_send = AsyncMock(
        return_value=SmsSendResult(success=True, provider_message_id="mid-1")
    )
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send):
        res1 = await _send_chw_message(client, chw_tokens, conv_id, "First message")
        res2 = await _send_chw_message(client, chw_tokens, conv_id, "Second message")

    assert res1.status_code == 201
    assert res2.status_code == 201

    first_body = fake_send.call_args_list[0].args[1]
    second_body = fake_send.call_args_list[1].args[1]
    assert first_body.endswith(STOP_LINE), first_body
    assert STOP_LINE not in second_body, second_body

    # The cadence stamp was persisted by the fanout's own commit.
    async with _test_session_factory() as session:
        profile = (
            await session.execute(
                select(MemberProfile).where(MemberProfile.user_id == UUID(member_id))
            )
        ).scalar_one()
        assert profile.last_stop_prompt_at is not None


# ─── Kill switch: fanout no-op, in-app still persisted ───────────────────────


@pytest.mark.asyncio
async def test_kill_switch_off_disables_fanout_but_keeps_in_app(
    client: AsyncClient, monkeypatch
):
    chw_tokens, _member_tokens, member_id, conv_id = await _setup(
        client, "stop_chw2@test.com", "stop_member2@test.com", "+15550400002"
    )

    monkeypatch.setattr(_app_config_module.settings, "sms_mirroring_enabled", False)

    fake_send = AsyncMock(return_value=SmsSendResult(success=True))
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send):
        res = await _send_chw_message(client, chw_tokens, conv_id, "Should not text")

    # In-app message persists; no SMS attempted.
    assert res.status_code == 201
    assert res.json()["channel"] == "in_app"
    fake_send.assert_not_awaited()

    async with _test_session_factory() as session:
        msgs = (
            await session.execute(
                select(Message).where(Message.conversation_id == UUID(conv_id))
            )
        ).scalars().all()
        assert len(msgs) == 1


@pytest.mark.asyncio
async def test_kill_switch_off_does_not_block_otp_delivery(
    client: AsyncClient, monkeypatch
):
    """OTP verification is exempt from the kill switch — phone verification must
    always work even with member SMS mirroring turned off."""
    member_tokens = await _register(client, "stop_otp_member@test.com", "member")

    monkeypatch.setattr(_app_config_module.settings, "sms_mirroring_enabled", False)

    res = await client.post(
        "/api/v1/phone/start-verification",
        json={"phone": "+13105550188"},
        headers=auth_header(member_tokens),
    )
    # OTP send still succeeds (stub-mode Vonage) — the flag never gated it.
    assert res.status_code == 200, res.text


# ─── Reminder member leg carries the STOP line on the first send ─────────────


@pytest.mark.asyncio
async def test_reminder_member_leg_appends_stop_line_on_first_send(client: AsyncClient):
    from app.services import sms_notifications

    chw_tokens = await _register(client, "stop_rem_chw@test.com", "chw")
    member_tokens = await _register(client, "stop_rem_member@test.com", "member")
    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_member_phone_verified(member_id, "+15550400009")

    captured: list[str] = []

    async def fake_send_text(self, to_e164, text):
        captured.append(text)
        return SmsSendResult(success=True, provider_message_id="mid-rem")

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send_text
    ):
        async with _test_session_factory() as db:
            handled = await sms_notifications.send_session_reminder_sms(
                db,
                session_id=UUID(member_id),  # arbitrary id; logging only
                chw_id=UUID(chw_id),
                member_id=UUID(member_id),
                scheduled_at=datetime(2026, 7, 20, 21, 0, tzinfo=UTC),
                window="24h",
            )

    assert handled is True
    # CHW leg has no phone (never set) → only the member leg sent.
    assert len(captured) == 1
    assert captured[0].startswith("Compass: ")
    assert captured[0].endswith(STOP_LINE)
