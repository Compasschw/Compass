"""Integration tests for masked-number SMS messaging (shared Vonage number).

Coverage (mirrors the checklist in backend/TESTING.md):
  Outbound (POST /conversations/{id}/sms):
    1. Eligible member -> sends, persists Message(channel='sms'), sets the
       sticky routing pointer, writes a CommunicationTouch row.
    2. Ineligible member (unverified phone) -> 422, nothing sent/persisted.
    3. Non-owning CHW -> 403 (relationship gate, not just a role gate).
    4. Vonage send failure -> 502, nothing persisted (never claim a message
       was sent when it wasn't).

  Inbound (POST /communication/sms/inbound):
    5. Correct member/conversation routing by from-number.
    6. STICKY routing when the member has TWO CHWs — texts route to the
       last-SMS'd conversation (built as an explicit two-CHW scenario).
    7. Unknown from-number -> dead-letter (logged, 200, no Message row).
    8. Duplicate message_uuid -> idempotent (exactly one Message).
    9. STOP keyword -> sets sms_opt_out=true + a subsequent outbound send is
       blocked (422) — proving the opt-out is enforced, not just recorded.
    10. Missing/forged Vonage signature -> 401.

  Migration regression:
    11. Plain in-app send_message still defaults channel='in_app' — existing
        message-creation paths are unaffected by this feature.

Test strategy:
  - Vonage is NOT configured in the test env (no vonage_application_id /
    vonage_private_key_path) → VonageSmsMessagesClient.send_text runs in
    stub mode and returns success=True with a placeholder message_uuid.
    This mirrors the existing call-bridge test convention (see
    tests/test_bidirectional_comms.py's module docstring) — the Vonage
    client boundary is naturally stubbed rather than needing a mock for the
    happy path. The one test that needs a REAL failure (#4 above) explicitly
    monkeypatches VonageSmsMessagesClient.send_text to simulate a Vonage
    outage, since stub mode can't produce a failure on its own.
"""

import base64
import hashlib
import json
import time
import uuid
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from jose import jwt as jose_jwt
from sqlalchemy import select

from app.models.conversation import Conversation, Message
from app.models.user import MemberProfile, User
from app.services.communication_touch_log import CommunicationTouch, TouchKind
from app.services.vonage_sms import SmsSendResult
from tests.conftest import auth_header, test_session as _test_session_factory

_VONAGE_SECRET = "test-vonage-sms-signature-secret-for-pytest"


# ─── Shared helpers ────────────────────────────────────────────────────────────


async def _register(client: AsyncClient, email: str, role: str) -> dict:
    payload: dict = {
        "email": email,
        "password": "testpass123",
        "name": f"Test {role.upper()} {email[:8]}",
        "role": role,
    }
    if role == "member":
        payload.update({
            "date_of_birth": "1990-01-01",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
            "zip_code": "90001",
        })
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, f"Register failed: {res.text}"
    return res.json()


def _user_id_from_tokens(tokens: dict) -> str:
    parts = tokens["access_token"].split(".")
    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded))
    return payload["sub"]


async def _set_member_phone_verified(
    user_id: str, phone: str, *, opt_out: bool = False
) -> None:
    from datetime import UTC, datetime

    async with _test_session_factory() as session:
        user = await session.get(User, UUID(user_id))
        assert user is not None
        user.phone = phone
        user.phone_verified_at = datetime.now(UTC)

        profile_result = await session.execute(
            select(MemberProfile).where(MemberProfile.user_id == UUID(user_id))
        )
        profile = profile_result.scalar_one()
        profile.sms_opt_out = opt_out
        await session.commit()


async def _set_phone_via_db(user_id: str, phone: str) -> None:
    async with _test_session_factory() as session:
        user = await session.get(User, UUID(user_id))
        assert user is not None
        user.phone = phone
        await session.commit()


async def _create_session_between(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
    *,
    vertical: str = "housing",
) -> str:
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": vertical,
            "urgency": "routine",
            "description": "SMS messaging integration test request",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, f"Create request failed: {res.text}"
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Accept request failed: {res.text}"

    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-07-10T10:00:00Z",
            "mode": "phone",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, f"Create session failed: {res.text}"
    return res.json()["id"]


async def _find_or_create_conversation(
    client: AsyncClient, initiator_tokens: dict, peer_id: str
) -> str:
    res = await client.post(
        "/api/v1/conversations/find-or-create",
        json={"peer_id": peer_id},
        headers=auth_header(initiator_tokens),
    )
    assert res.status_code == 200, f"find-or-create failed: {res.text}"
    return res.json()["id"]


def _mint_vonage_webhook_jwt(body_bytes: bytes, secret: str) -> str:
    """Mint a Vonage signed-webhook JWT the way Vonage does (see
    tests/test_wave_a1_security.py for the original reference implementation
    this mirrors)."""
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


async def _post_sms_inbound(
    client: AsyncClient,
    *,
    from_number_digits: str,
    text: str,
    message_uuid: str | None = None,
    to_number_digits: str = "18005551234",
    signed: bool = False,
) -> "AsyncClient":
    body = {
        "message_uuid": message_uuid or str(uuid.uuid4()),
        "to": to_number_digits,
        "from": from_number_digits,
        "channel": "sms",
        "message_type": "text",
        "text": text,
    }
    body_bytes = json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if signed:
        token = _mint_vonage_webhook_jwt(body_bytes, _VONAGE_SECRET)
        headers["Authorization"] = f"Bearer {token}"
    return await client.post(
        "/api/v1/communication/sms/inbound", content=body_bytes, headers=headers
    )


# ─── Outbound: eligible member sends ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_outbound_sms_eligible_member_succeeds(client: AsyncClient):
    chw_tokens = await _register(client, "sms_out_chw1@test.com", "chw")
    member_tokens = await _register(client, "sms_out_member1@test.com", "member")

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550100001")
    await _set_member_phone_verified(member_id, "+15550100002")

    await _create_session_between(client, chw_tokens, member_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    res = await client.post(
        f"/api/v1/conversations/{conv_id}/sms",
        json={"text": "Hi, this is your CHW checking in!"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, f"Expected 201, got {res.status_code}: {res.text}"
    data = res.json()
    assert data["channel"] == "sms"
    assert data["body"] == "Hi, this is your CHW checking in!"
    assert data["sender_id"] == chw_id

    async with _test_session_factory() as session:
        msg_result = await session.execute(
            select(Message).where(Message.conversation_id == UUID(conv_id))
        )
        messages = msg_result.scalars().all()
        assert len(messages) == 1
        assert messages[0].channel == "sms"
        assert messages[0].provider_message_id is not None

        profile_result = await session.execute(
            select(MemberProfile).where(MemberProfile.user_id == UUID(member_id))
        )
        profile = profile_result.scalar_one()
        assert str(profile.last_sms_conversation_id) == conv_id

        touch_result = await session.execute(
            select(CommunicationTouch).where(
                CommunicationTouch.initiator_id == UUID(chw_id),
                CommunicationTouch.recipient_id == UUID(member_id),
                CommunicationTouch.kind == TouchKind.sms.value,
            )
        )
        touch = touch_result.scalar_one_or_none()
        assert touch is not None
        assert touch.extra_data.get("direction") == "outbound"


# ─── Outbound: ineligible member variants ──────────────────────────────────────


@pytest.mark.asyncio
async def test_outbound_sms_unverified_phone_returns_422_and_sends_nothing(
    client: AsyncClient,
):
    chw_tokens = await _register(client, "sms_out_chw2@test.com", "chw")
    member_tokens = await _register(client, "sms_out_member2@test.com", "member")

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550100003")
    # Phone set but NEVER verified.
    await _set_phone_via_db(member_id, "+15550100004")

    await _create_session_between(client, chw_tokens, member_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    res = await client.post(
        f"/api/v1/conversations/{conv_id}/sms",
        json={"text": "Should not send"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, f"Expected 422, got {res.status_code}: {res.text}"
    assert res.json()["detail"]["code"] == "phone_not_verified"

    async with _test_session_factory() as session:
        msg_result = await session.execute(
            select(Message).where(Message.conversation_id == UUID(conv_id))
        )
        assert msg_result.scalars().all() == []


@pytest.mark.asyncio
async def test_outbound_sms_sentinel_phone_returns_422(client: AsyncClient):
    chw_tokens = await _register(client, "sms_out_chw3@test.com", "chw")
    member_tokens = await _register(client, "sms_out_member3@test.com", "member")

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550100005")
    await _set_member_phone_verified(member_id, "555-555-5555")

    await _create_session_between(client, chw_tokens, member_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    res = await client.post(
        f"/api/v1/conversations/{conv_id}/sms",
        json={"text": "Should not send"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "sentinel_phone"


@pytest.mark.asyncio
async def test_outbound_sms_opted_out_member_returns_422(client: AsyncClient):
    chw_tokens = await _register(client, "sms_out_chw4@test.com", "chw")
    member_tokens = await _register(client, "sms_out_member4@test.com", "member")

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550100006")
    await _set_member_phone_verified(member_id, "+15550100007", opt_out=True)

    await _create_session_between(client, chw_tokens, member_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    res = await client.post(
        f"/api/v1/conversations/{conv_id}/sms",
        json={"text": "Should not send"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "opted_out"


@pytest.mark.asyncio
async def test_outbound_sms_no_phone_returns_422(client: AsyncClient):
    chw_tokens = await _register(client, "sms_out_chw5@test.com", "chw")
    member_tokens = await _register(client, "sms_out_member5@test.com", "member")

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550100008")
    # Member has no phone at all.

    await _create_session_between(client, chw_tokens, member_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    res = await client.post(
        f"/api/v1/conversations/{conv_id}/sms",
        json={"text": "Should not send"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "no_phone"


# ─── Outbound: non-owning CHW ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_outbound_sms_non_owning_chw_returns_403(client: AsyncClient):
    chw_tokens = await _register(client, "sms_out_chw6@test.com", "chw")
    other_chw_tokens = await _register(client, "sms_out_chw6b@test.com", "chw")
    member_tokens = await _register(client, "sms_out_member6@test.com", "member")

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550100009")
    await _set_member_phone_verified(member_id, "+15550100010")

    await _create_session_between(client, chw_tokens, member_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    # A DIFFERENT CHW (not on this conversation) tries to send.
    res = await client.post(
        f"/api/v1/conversations/{conv_id}/sms",
        json={"text": "Should not send"},
        headers=auth_header(other_chw_tokens),
    )
    assert res.status_code == 403, f"Expected 403, got {res.status_code}: {res.text}"

    async with _test_session_factory() as session:
        msg_result = await session.execute(
            select(Message).where(Message.conversation_id == UUID(conv_id))
        )
        assert msg_result.scalars().all() == []


@pytest.mark.asyncio
async def test_outbound_sms_member_cannot_send(client: AsyncClient):
    """A member (not a CHW) is never authorized to POST /sms."""
    chw_tokens = await _register(client, "sms_out_chw7@test.com", "chw")
    member_tokens = await _register(client, "sms_out_member7@test.com", "member")

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550100011")
    await _set_member_phone_verified(member_id, "+15550100012")

    await _create_session_between(client, chw_tokens, member_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    res = await client.post(
        f"/api/v1/conversations/{conv_id}/sms",
        json={"text": "Should not send"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403


# ─── Outbound: Vonage send failure ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_outbound_sms_vonage_failure_returns_502_and_persists_nothing(
    client: AsyncClient,
):
    chw_tokens = await _register(client, "sms_out_chw8@test.com", "chw")
    member_tokens = await _register(client, "sms_out_member8@test.com", "member")

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550100013")
    await _set_member_phone_verified(member_id, "+15550100014")

    await _create_session_between(client, chw_tokens, member_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    failing_send = AsyncMock(
        return_value=SmsSendResult(success=False, error="vonage_status_500", status_code=500)
    )
    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text", failing_send
    ):
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/sms",
            json={"text": "This send will fail"},
            headers=auth_header(chw_tokens),
        )

    assert res.status_code == 502, f"Expected 502, got {res.status_code}: {res.text}"
    failing_send.assert_awaited_once()

    async with _test_session_factory() as session:
        msg_result = await session.execute(
            select(Message).where(Message.conversation_id == UUID(conv_id))
        )
        assert msg_result.scalars().all() == [], "No message should be persisted on send failure"

        profile_result = await session.execute(
            select(MemberProfile).where(MemberProfile.user_id == UUID(member_id))
        )
        profile = profile_result.scalar_one()
        assert profile.last_sms_conversation_id is None, "Sticky pointer must not be set on failure"


# ─── Inbound: routing by from-number ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_inbound_sms_routes_to_member_conversation(client: AsyncClient):
    chw_tokens = await _register(client, "sms_in_chw1@test.com", "chw")
    member_tokens = await _register(client, "sms_in_member1@test.com", "member")

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550200001")
    await _set_member_phone_verified(member_id, "+15550200002")

    await _create_session_between(client, chw_tokens, member_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    # Outbound SMS first — sets the sticky pointer to this conversation.
    res = await client.post(
        f"/api/v1/conversations/{conv_id}/sms",
        json={"text": "Hello from your CHW"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201

    res = await _post_sms_inbound(
        client, from_number_digits="15550200002", text="Thanks, got it!"
    )
    assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
    assert res.json()["received"] is True

    async with _test_session_factory() as session:
        msg_result = await session.execute(
            select(Message)
            .where(Message.conversation_id == UUID(conv_id), Message.sender_id == UUID(member_id))
            .order_by(Message.created_at.desc())
        )
        inbound_msgs = msg_result.scalars().all()
        assert len(inbound_msgs) == 1
        assert inbound_msgs[0].body == "Thanks, got it!"
        assert inbound_msgs[0].channel == "sms"


# ─── Inbound: STICKY routing with two CHWs ─────────────────────────────────────


@pytest.mark.asyncio
async def test_inbound_sms_sticky_routing_with_two_chws(client: AsyncClient):
    """A member with TWO CHW conversations: an inbound reply routes to
    whichever CHW most recently SMS'd them (the sticky pointer), not the
    first/other conversation."""
    chw_a_tokens = await _register(client, "sms_sticky_chwA@test.com", "chw")
    chw_b_tokens = await _register(client, "sms_sticky_chwB@test.com", "chw")
    member_tokens = await _register(client, "sms_sticky_member@test.com", "member")

    chw_a_id = _user_id_from_tokens(chw_a_tokens)
    chw_b_id = _user_id_from_tokens(chw_b_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_a_id, "+15550200003")
    await _set_phone_via_db(chw_b_id, "+15550200004")
    await _set_member_phone_verified(member_id, "+15550200005")

    await _create_session_between(client, chw_a_tokens, member_tokens, vertical="housing")
    await _create_session_between(client, chw_b_tokens, member_tokens, vertical="food")

    conv_a_id = await _find_or_create_conversation(client, chw_a_tokens, member_id)
    conv_b_id = await _find_or_create_conversation(client, chw_b_tokens, member_id)
    assert conv_a_id != conv_b_id

    # CHW A texts first...
    res = await client.post(
        f"/api/v1/conversations/{conv_a_id}/sms",
        json={"text": "Hi from CHW A"},
        headers=auth_header(chw_a_tokens),
    )
    assert res.status_code == 201

    # ...then CHW B texts, which should become the new sticky pointer.
    res = await client.post(
        f"/api/v1/conversations/{conv_b_id}/sms",
        json={"text": "Hi from CHW B"},
        headers=auth_header(chw_b_tokens),
    )
    assert res.status_code == 201

    # Member replies once — must land in conv_b (CHW B), the last-SMS'd thread.
    res = await _post_sms_inbound(
        client, from_number_digits="15550200005", text="Replying to whoever texted last"
    )
    assert res.status_code == 200

    async with _test_session_factory() as session:
        conv_a_msgs = (
            await session.execute(
                select(Message).where(
                    Message.conversation_id == UUID(conv_a_id),
                    Message.sender_id == UUID(member_id),
                )
            )
        ).scalars().all()
        conv_b_msgs = (
            await session.execute(
                select(Message).where(
                    Message.conversation_id == UUID(conv_b_id),
                    Message.sender_id == UUID(member_id),
                )
            )
        ).scalars().all()

    assert conv_a_msgs == [], "Reply must NOT land in conv_a — CHW A did not text last"
    assert len(conv_b_msgs) == 1, "Reply must land in conv_b — CHW B texted last (sticky pointer)"
    assert conv_b_msgs[0].body == "Replying to whoever texted last"


# ─── Inbound: dead-letter, idempotency, STOP, signature ───────────────────────


@pytest.mark.asyncio
async def test_inbound_sms_unknown_number_dead_letters(client: AsyncClient):
    res = await _post_sms_inbound(
        client, from_number_digits="19995551234", text="Nobody knows this number"
    )
    assert res.status_code == 200, f"Dead-letter must still be 200, got {res.status_code}: {res.text}"
    body = res.json()
    assert body["received"] is True
    assert body["note"] == "dead_letter_unknown_member"

    async with _test_session_factory() as session:
        msg_result = await session.execute(
            select(Message).where(Message.body == "Nobody knows this number")
        )
        assert msg_result.scalars().all() == []


@pytest.mark.asyncio
async def test_inbound_sms_duplicate_message_uuid_is_idempotent(client: AsyncClient):
    chw_tokens = await _register(client, "sms_in_dup_chw@test.com", "chw")
    member_tokens = await _register(client, "sms_in_dup_member@test.com", "member")

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550200006")
    await _set_member_phone_verified(member_id, "+15550200007")

    await _create_session_between(client, chw_tokens, member_tokens)
    await _find_or_create_conversation(client, chw_tokens, member_id)

    shared_uuid = str(uuid.uuid4())
    res1 = await _post_sms_inbound(
        client,
        from_number_digits="15550200007",
        text="Duplicate delivery test",
        message_uuid=shared_uuid,
    )
    assert res1.status_code == 200
    assert res1.json().get("note") is None

    res2 = await _post_sms_inbound(
        client,
        from_number_digits="15550200007",
        text="Duplicate delivery test",
        message_uuid=shared_uuid,
    )
    assert res2.status_code == 200
    assert res2.json()["note"] == "duplicate"

    async with _test_session_factory() as session:
        msg_result = await session.execute(
            select(Message).where(Message.provider_message_id == shared_uuid)
        )
        assert len(msg_result.scalars().all()) == 1, "Duplicate webhook must not create a 2nd Message"


@pytest.mark.asyncio
async def test_inbound_sms_stop_keyword_opts_out_and_blocks_outbound(client: AsyncClient):
    chw_tokens = await _register(client, "sms_stop_chw@test.com", "chw")
    member_tokens = await _register(client, "sms_stop_member@test.com", "member")

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550200008")
    await _set_member_phone_verified(member_id, "+15550200009")

    await _create_session_between(client, chw_tokens, member_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    # lowercase + surrounding whitespace — must still match case-insensitively.
    res = await _post_sms_inbound(client, from_number_digits="15550200009", text="  stop  ")
    assert res.status_code == 200
    assert res.json()["note"] == "stop_processed"

    async with _test_session_factory() as session:
        # STOP must not be persisted as a normal chat message.
        msg_result = await session.execute(
            select(Message).where(Message.conversation_id == UUID(conv_id))
        )
        assert msg_result.scalars().all() == []

        profile_result = await session.execute(
            select(MemberProfile).where(MemberProfile.user_id == UUID(member_id))
        )
        profile = profile_result.scalar_one()
        assert profile.sms_opt_out is True

        touch_result = await session.execute(
            select(CommunicationTouch).where(
                CommunicationTouch.initiator_id == UUID(member_id),
                CommunicationTouch.kind == TouchKind.sms.value,
            )
        )
        touch = touch_result.scalar_one_or_none()
        assert touch is not None
        assert touch.extra_data.get("stop_keyword") is True

    # Subsequent outbound send is now blocked.
    res = await client.post(
        f"/api/v1/conversations/{conv_id}/sms",
        json={"text": "This should be blocked"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "opted_out"


@pytest.mark.asyncio
async def test_inbound_sms_missing_signature_returns_401_when_secret_configured():
    """When vonage_signature_secret IS configured, a webhook with no
    Authorization header must be rejected — mirrors the voice webhook
    signature tests in tests/test_wave_a1_security.py."""
    import app.config as _app_cfg
    from httpx import ASGITransport
    from httpx import AsyncClient as _AsyncClient

    from app.main import app as _app

    original = _app_cfg.settings
    _app_cfg.settings = type(
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
    try:
        transport = ASGITransport(app=_app)
        async with _AsyncClient(transport=transport, base_url="http://test") as unsigned_client:
            res = await unsigned_client.post(
                "/api/v1/communication/sms/inbound",
                json={"message_uuid": "x", "to": "18005551234", "from": "15551234567", "text": "hi"},
            )
    finally:
        _app_cfg.settings = original

    assert res.status_code == 401, f"Expected 401, got {res.status_code}: {res.text}"


@pytest.mark.asyncio
async def test_inbound_sms_forged_signature_returns_401():
    import app.config as _app_cfg
    from httpx import ASGITransport
    from httpx import AsyncClient as _AsyncClient

    from app.main import app as _app

    original = _app_cfg.settings
    _app_cfg.settings = type(
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
    try:
        body_bytes = json.dumps(
            {"message_uuid": "x", "to": "18005551234", "from": "15551234567", "text": "hi"}
        ).encode("utf-8")
        forged_token = _mint_vonage_webhook_jwt(body_bytes, "totally-wrong-secret")
        transport = ASGITransport(app=_app)
        async with _AsyncClient(transport=transport, base_url="http://test") as unsigned_client:
            res = await unsigned_client.post(
                "/api/v1/communication/sms/inbound",
                content=body_bytes,
                headers={
                    "Authorization": f"Bearer {forged_token}",
                    "Content-Type": "application/json",
                },
            )
    finally:
        _app_cfg.settings = original

    assert res.status_code == 401, f"Expected 401, got {res.status_code}: {res.text}"


# ─── Migration regression: existing in-app messaging unaffected ───────────────


@pytest.mark.asyncio
async def test_in_app_message_still_defaults_channel_in_app(client: AsyncClient):
    """Existing send_message (in-app thread) path is untouched by this
    feature — every Message it creates still defaults to channel='in_app'."""
    chw_tokens = await _register(client, "sms_regress_chw@test.com", "chw")
    member_tokens = await _register(client, "sms_regress_member@test.com", "member")

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550200010")
    await _set_phone_via_db(member_id, "+15550200011")

    await _create_session_between(client, chw_tokens, member_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    res = await client.post(
        f"/api/v1/conversations/{conv_id}/messages",
        json={"body": "Plain in-app message"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, f"Expected 201, got {res.status_code}: {res.text}"
    data = res.json()
    assert data["channel"] == "in_app"

    async with _test_session_factory() as session:
        msg_result = await session.execute(
            select(Message).where(Message.conversation_id == UUID(conv_id))
        )
        msg = msg_result.scalars().one()
        assert msg.channel == "in_app"
        assert msg.provider_message_id is None
