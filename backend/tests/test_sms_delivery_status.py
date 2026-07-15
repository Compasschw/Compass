"""Delivery-status tracking for outbound SMS (SMS Output Spec 1 §4).

Covers:
  Task 10 (schema) — the two new nullable ``messages`` columns
    (``delivery_status`` / ``delivery_failed_reason``) exist under
    ``Base.metadata.create_all`` and round-trip a value.

  Task 11 (webhook — POST /api/v1/communication/sms/status):
    1. Missing/forged Vonage signature -> 401 (reuses the inbound-webhook
       signature discipline; verification only engages when a secret is set).
    2. status='delivered' -> stamps Message.delivery_status='delivered'.
    3. status='undeliverable' (and 'rejected') -> delivery_status='failed'
       + delivery_failed_reason (error.reason, truncated to 64).
    4. status='submitted' (interim) -> no write, note='ignored'.
    5. Unknown message_uuid -> 200 note='unmatched', nothing written.
    6. Replay of the same status -> 200, row unchanged (idempotent).
    7. Malformed JSON body -> 200 no-op (webhook NEVER 500s — Vonage retries
       on non-2xx, and the no-unhandled-500 rule in backend/TESTING.md).
    8. Confirmation/notification sends have no Message row; a status keyed by a
       CommunicationTouch.provider_session_id lands in that touch's
       extra_data['delivery_status'] instead.

Signature strategy mirrors tests/test_sms_messaging.py: in the default test
env ``vonage_signature_secret`` is unset, so the signature dependency is a
no-op and the happy-path tests can POST unsigned. The 401 tests explicitly
patch ``app.config.settings`` to set the secret (with no/forged Authorization
header), exactly like the inbound-webhook signature tests.
"""

import hashlib
import json
import time
import uuid
from datetime import UTC, datetime

import pytest
from httpx import ASGITransport
from httpx import AsyncClient as _AsyncClient
from jose import jwt as jose_jwt
from sqlalchemy import select

from app.models.conversation import Conversation, Message
from app.models.user import User
from app.services.communication_touch_log import CommunicationTouch
from tests.conftest import test_session as _test_session_factory

_VONAGE_SECRET = "test-vonage-sms-signature-secret-for-pytest"

_STATUS_URL = "/api/v1/communication/sms/status"


# ─── Seed helpers ───────────────────────────────────────────────────────────


async def _seed_sms_message(provider_message_id: str) -> uuid.UUID:
    """Create a minimal CHW/member conversation with one outbound SMS Message
    carrying ``provider_message_id``; return the Message id."""
    async with _test_session_factory() as session:
        suffix = uuid.uuid4().hex[:8]
        chw = User(email=f"chw_{suffix}@test.com", role="chw", name="CHW Tester")
        member = User(email=f"member_{suffix}@test.com", role="member", name="Member Tester")
        session.add_all([chw, member])
        await session.flush()

        conversation = Conversation(chw_id=chw.id, member_id=member.id)
        session.add(conversation)
        await session.flush()

        message = Message(
            conversation_id=conversation.id,
            sender_id=chw.id,
            body="Your session is confirmed.",
            channel="sms",
            provider_message_id=provider_message_id,
        )
        session.add(message)
        await session.commit()
        return message.id


async def _get_message(message_id: uuid.UUID) -> Message:
    async with _test_session_factory() as session:
        result = await session.execute(select(Message).where(Message.id == message_id))
        return result.scalar_one()


def _mint_vonage_webhook_jwt(body_bytes: bytes, secret: str) -> str:
    return jose_jwt.encode(
        {
            "iat": int(time.time()),
            "jti": uuid.uuid4().hex,
            "iss": "Vonage",
            "application_id": "00000000-0000-0000-0000-000000000000",
            "payload_hash": hashlib.sha256(body_bytes).hexdigest(),
        },
        secret,
        algorithm="HS256",
    )


async def _post_status(client, payload: dict):
    """POST a status callback unsigned (default test env has no secret set)."""
    return await client.post(_STATUS_URL, json=payload)


# ─── Task 10: schema parity under create_all ────────────────────────────────


@pytest.mark.asyncio
async def test_message_delivery_columns_roundtrip():
    """The migration's two new columns exist under create_all and persist."""
    message_id = await _seed_sms_message(f"seed-{uuid.uuid4().hex}")
    async with _test_session_factory() as session:
        message = await session.get(Message, message_id)
        assert message is not None
        # Default state: no status yet.
        assert message.delivery_status is None
        assert message.delivery_failed_reason is None
        message.delivery_status = "failed"
        message.delivery_failed_reason = "carrier rejected"
        await session.commit()

    refreshed = await _get_message(message_id)
    assert refreshed.delivery_status == "failed"
    assert refreshed.delivery_failed_reason == "carrier rejected"


# ─── Task 11: signature gate ────────────────────────────────────────────────


def _mock_settings_with_secret():
    return type(
        "_MockSettings",
        (),
        {
            "vonage_signature_secret": _VONAGE_SECRET,
            "environment": "development",
            "vonage_from_number": "18005551234",
            "vonage_sms_number": "",
            "magic_link_base_url": "https://api.joincompasschw.com/auth/magic",
        },
    )()


@pytest.mark.asyncio
async def test_status_missing_signature_returns_401_when_secret_configured():
    import app.config as _app_cfg
    from app.main import app as _app

    original = _app_cfg.settings
    _app_cfg.settings = _mock_settings_with_secret()
    try:
        transport = ASGITransport(app=_app)
        async with _AsyncClient(transport=transport, base_url="http://test") as unsigned:
            res = await unsigned.post(
                _STATUS_URL,
                json={"message_uuid": "x", "status": "delivered"},
            )
    finally:
        _app_cfg.settings = original

    assert res.status_code == 401, res.text


@pytest.mark.asyncio
async def test_status_forged_signature_returns_401():
    import app.config as _app_cfg
    from app.main import app as _app

    original = _app_cfg.settings
    _app_cfg.settings = _mock_settings_with_secret()
    try:
        body_bytes = json.dumps({"message_uuid": "x", "status": "delivered"}).encode("utf-8")
        forged = _mint_vonage_webhook_jwt(body_bytes, "totally-wrong-secret")
        transport = ASGITransport(app=_app)
        async with _AsyncClient(transport=transport, base_url="http://test") as unsigned:
            res = await unsigned.post(
                _STATUS_URL,
                content=body_bytes,
                headers={
                    "Authorization": f"Bearer {forged}",
                    "Content-Type": "application/json",
                },
            )
    finally:
        _app_cfg.settings = original

    assert res.status_code == 401, res.text


# ─── Task 11: status mapping ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delivered_status_stamps_message(client):
    mid = f"mid-delivered-{uuid.uuid4().hex}"
    message_id = await _seed_sms_message(mid)

    res = await _post_status(client, {"message_uuid": mid, "status": "delivered"})
    assert res.status_code == 200, res.text
    assert res.json()["note"] == "applied"

    message = await _get_message(message_id)
    assert message.delivery_status == "delivered"
    assert message.delivery_failed_reason is None


@pytest.mark.asyncio
async def test_undeliverable_status_stamps_failed_with_reason(client):
    mid = f"mid-undeliverable-{uuid.uuid4().hex}"
    message_id = await _seed_sms_message(mid)

    res = await _post_status(
        client,
        {
            "message_uuid": mid,
            "status": "undeliverable",
            "error": {"reason": "Invalid destination"},
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["note"] == "applied"

    message = await _get_message(message_id)
    assert message.delivery_status == "failed"
    assert message.delivery_failed_reason == "Invalid destination"


@pytest.mark.asyncio
async def test_rejected_status_without_error_reason_falls_back_to_status_word(client):
    mid = f"mid-rejected-{uuid.uuid4().hex}"
    message_id = await _seed_sms_message(mid)

    res = await _post_status(client, {"message_uuid": mid, "status": "rejected"})
    assert res.status_code == 200, res.text

    message = await _get_message(message_id)
    assert message.delivery_status == "failed"
    assert message.delivery_failed_reason == "rejected"


@pytest.mark.asyncio
async def test_failed_reason_is_truncated_to_64_chars(client):
    mid = f"mid-longreason-{uuid.uuid4().hex}"
    message_id = await _seed_sms_message(mid)
    long_reason = "x" * 200

    res = await _post_status(
        client,
        {"message_uuid": mid, "status": "undeliverable", "error": {"reason": long_reason}},
    )
    assert res.status_code == 200, res.text

    message = await _get_message(message_id)
    assert message.delivery_status == "failed"
    assert message.delivery_failed_reason is not None
    assert len(message.delivery_failed_reason) == 64


@pytest.mark.asyncio
async def test_submitted_status_is_noop(client):
    mid = f"mid-submitted-{uuid.uuid4().hex}"
    message_id = await _seed_sms_message(mid)

    res = await _post_status(client, {"message_uuid": mid, "status": "submitted"})
    assert res.status_code == 200, res.text
    assert res.json()["note"] == "ignored"

    message = await _get_message(message_id)
    assert message.delivery_status is None
    assert message.delivery_failed_reason is None


@pytest.mark.asyncio
async def test_unknown_message_uuid_is_unmatched_noop(client):
    res = await _post_status(
        client, {"message_uuid": f"never-{uuid.uuid4().hex}", "status": "delivered"}
    )
    assert res.status_code == 200, res.text
    assert res.json()["note"] == "unmatched"


@pytest.mark.asyncio
async def test_replay_of_same_status_is_idempotent(client):
    mid = f"mid-replay-{uuid.uuid4().hex}"
    message_id = await _seed_sms_message(mid)

    first = await _post_status(client, {"message_uuid": mid, "status": "delivered"})
    assert first.status_code == 200
    second = await _post_status(client, {"message_uuid": mid, "status": "delivered"})
    assert second.status_code == 200, second.text

    message = await _get_message(message_id)
    assert message.delivery_status == "delivered"
    assert message.delivery_failed_reason is None


@pytest.mark.asyncio
async def test_malformed_json_body_never_500s(client):
    res = await client.post(
        _STATUS_URL,
        content=b"{not valid json",
        headers={"Content-Type": "application/json"},
    )
    assert res.status_code == 200, res.text


@pytest.mark.asyncio
async def test_json_array_body_never_500s(client):
    """Valid JSON that isn't an object (an array) must also be a clean no-op."""
    res = await client.post(
        _STATUS_URL,
        content=b'["not", "an", "object"]',
        headers={"Content-Type": "application/json"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["note"] == "ignored"


@pytest.mark.asyncio
async def test_terminal_status_without_message_uuid_is_unmatched(client):
    """A delivered/failed status with no message_uuid can't be matched — dropped."""
    res = await _post_status(client, {"status": "delivered"})
    assert res.status_code == 200, res.text
    assert res.json()["note"] == "unmatched"


@pytest.mark.asyncio
async def test_status_lands_in_communication_touch_when_no_message_row(client):
    """Confirmation/notification sends have no Message row; a status keyed by a
    CommunicationTouch.provider_session_id stamps that touch's extra_data."""
    mid = f"mid-touch-{uuid.uuid4().hex}"
    async with _test_session_factory() as session:
        suffix = uuid.uuid4().hex[:8]
        chw = User(email=f"chw_{suffix}@test.com", role="chw", name="CHW T")
        member = User(email=f"member_{suffix}@test.com", role="member", name="Member T")
        session.add_all([chw, member])
        await session.flush()
        touch = CommunicationTouch(
            initiator_id=chw.id,
            recipient_id=member.id,
            kind="sms",
            provider_session_id=mid,
            created_at=datetime.now(UTC),
            extra_data={"context": "session_confirmed"},
        )
        session.add(touch)
        await session.commit()
        touch_id = touch.id

    res = await _post_status(
        client,
        {"message_uuid": mid, "status": "undeliverable", "error": {"reason": "blocked"}},
    )
    assert res.status_code == 200, res.text
    assert res.json()["note"] == "applied"

    async with _test_session_factory() as session:
        refreshed = await session.get(CommunicationTouch, touch_id)
        assert refreshed is not None
        assert refreshed.extra_data is not None
        assert refreshed.extra_data.get("delivery_status") == "failed"
        assert refreshed.extra_data.get("delivery_failed_reason") == "blocked"

    # Replay of the same status against the touch row is an idempotent no-op.
    replay = await _post_status(
        client,
        {"message_uuid": mid, "status": "undeliverable", "error": {"reason": "blocked"}},
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["note"] == "applied"

    async with _test_session_factory() as session:
        after_replay = await session.get(CommunicationTouch, touch_id)
        assert after_replay is not None
        assert after_replay.extra_data.get("delivery_status") == "failed"
        assert after_replay.extra_data.get("delivery_failed_reason") == "blocked"
