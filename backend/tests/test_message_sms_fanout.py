"""Integration + unit tests for auto SMS fanout on CHW->member in-app messages.

Product decision (locked): every message a CHW sends in a conversation is
ALSO delivered to the member as a masked SMS text, automatically — there is
no dedicated "send SMS" button. The in-app Message row always stays
channel='in_app'; the SMS is a transparent, best-effort mirror sent via
``app.services.vonage_sms`` from
``app.routers.conversations._fanout_sms_for_chw_message``, scheduled as a
FastAPI BackgroundTask off ``POST /conversations/{id}/messages``.

Coverage:
  1. CHW -> SMS-eligible member: in-app Message persisted (channel=in_app)
     AND the Vonage client is called with the full body + the member's
     normalized E.164 number; sticky pointer set; CommunicationTouch
     (kind='sms', auto_fanout=True) written.
  2. CHW -> ineligible member (555 sentinel) -> in-app only, no SMS, no
     error, no touch-log row, 201.
  3. CHW -> ineligible member (phone never verified) -> same as #2.
  4. CHW -> ineligible member (opted out) -> same as #2.
  5. SMS send FAILS (Vonage client returns success=False) -> in-app Message
     STILL persisted, endpoint still returns 201, no sticky pointer, no
     touch-log row.
  6. Member (not CHW) sends a message -> Vonage client is NEVER called.
  7. Attachment-only message (empty body) from a CHW -> no SMS attempted
     (nothing meaningful to mirror).
  8. Unexpected exception inside the fanout (e.g. eligibility check raises)
     -> swallowed; the in-app send still returns 201.
  9. Defensive branches of the background function itself, exercised as a
     unit test (member row / member profile row missing) -> no-op, no raise.
  10. Regression: normal messaging (thread fetch, unread count) is
      unaffected by this feature.

Mocking strategy: patches ``app.services.vonage_sms.VonageSmsMessagesClient.
send_text`` directly (mirrors tests/test_sms_messaging.py) rather than
relying on stub mode, so call args (body + normalized phone) can be asserted
precisely.
"""

import base64
import json
from unittest.mock import AsyncMock, patch
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.conversation import Message
from app.models.user import MemberProfile, User
from app.services.communication_touch_log import CommunicationTouch, TouchKind
from app.services.vonage_sms import SmsSendResult
from tests.conftest import auth_header
from tests.conftest import test_session as _test_session_factory

# ─── Shared helpers (mirrors tests/test_sms_messaging.py) ─────────────────────


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
            "description": "SMS fanout integration test request",
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


async def _setup_chw_member_conversation(
    client: AsyncClient, chw_email: str, member_email: str
) -> tuple[dict, dict, str, str, str]:
    """Register a CHW + member, share a session, and find-or-create their
    conversation. Returns (chw_tokens, member_tokens, chw_id, member_id, conv_id)."""
    chw_tokens = await _register(client, chw_email, "chw")
    member_tokens = await _register(client, member_email, "member")
    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _create_session_between(client, chw_tokens, member_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)
    return chw_tokens, member_tokens, chw_id, member_id, conv_id


# ─── 1. Eligible member: in-app + SMS fanout ───────────────────────────────────


@pytest.mark.asyncio
async def test_chw_message_to_eligible_member_fans_out_as_sms(client: AsyncClient):
    chw_tokens, member_tokens, chw_id, member_id, conv_id = await _setup_chw_member_conversation(
        client, "fanout_chw1@test.com", "fanout_member1@test.com"
    )
    await _set_member_phone_verified(member_id, "+15550300001")

    fake_send = AsyncMock(
        return_value=SmsSendResult(success=True, provider_message_id="vonage-msg-1")
    )
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send):
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Hi, this is your CHW checking in!"},
            headers=auth_header(chw_tokens),
        )

    assert res.status_code == 201, f"Expected 201, got {res.status_code}: {res.text}"
    data = res.json()
    assert data["channel"] == "in_app", "the in-app Message must stay channel=in_app"
    assert data["body"] == "Hi, this is your CHW checking in!"

    # 10DLC brand prefix (Compass: …) is added to every outbound SMS while the
    # in-app Message body stays exactly what the CHW typed (asserted above).
    # This is the member's FIRST outbound SMS, so the STOP-prompt cadence
    # (SMS Output Spec 1 §2) appends the opt-out line to this send.
    fake_send.assert_awaited_once_with(
        "+15550300001",
        "Compass: Hi, this is your CHW checking in! Reply STOP to opt out.",
    )

    async with _test_session_factory() as session:
        # Exactly one Message row — the fanout must NOT create a second row.
        msg_result = await session.execute(
            select(Message).where(Message.conversation_id == UUID(conv_id))
        )
        messages = msg_result.scalars().all()
        assert len(messages) == 1
        assert messages[0].channel == "in_app"

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
        assert touch.extra_data.get("auto_fanout") is True
        assert touch.provider_session_id == "vonage-msg-1"


# ─── 2-4. Ineligible member variants: in-app only, no SMS, no error ────────────


@pytest.mark.asyncio
async def test_chw_message_to_sentinel_phone_member_is_in_app_only(client: AsyncClient):
    chw_tokens, member_tokens, chw_id, member_id, conv_id = await _setup_chw_member_conversation(
        client, "fanout_chw2@test.com", "fanout_member2@test.com"
    )
    await _set_member_phone_verified(member_id, "555-555-5555")

    fake_send = AsyncMock()
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send):
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Should be in-app only"},
            headers=auth_header(chw_tokens),
        )

    assert res.status_code == 201, f"Expected 201, got {res.status_code}: {res.text}"
    assert res.json()["channel"] == "in_app"
    fake_send.assert_not_awaited()

    async with _test_session_factory() as session:
        msg_result = await session.execute(
            select(Message).where(Message.conversation_id == UUID(conv_id))
        )
        assert len(msg_result.scalars().all()) == 1

        profile_result = await session.execute(
            select(MemberProfile).where(MemberProfile.user_id == UUID(member_id))
        )
        profile = profile_result.scalar_one()
        assert profile.last_sms_conversation_id is None

        touch_result = await session.execute(
            select(CommunicationTouch).where(
                CommunicationTouch.recipient_id == UUID(member_id),
                CommunicationTouch.kind == TouchKind.sms.value,
            )
        )
        assert touch_result.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_chw_message_to_unverified_phone_member_is_in_app_only(client: AsyncClient):
    chw_tokens, member_tokens, chw_id, member_id, conv_id = await _setup_chw_member_conversation(
        client, "fanout_chw3@test.com", "fanout_member3@test.com"
    )
    # Phone set but never verified via OTP.
    await _set_phone_via_db(member_id, "+15550300003")

    fake_send = AsyncMock()
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send):
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Should be in-app only"},
            headers=auth_header(chw_tokens),
        )

    assert res.status_code == 201, f"Expected 201, got {res.status_code}: {res.text}"
    fake_send.assert_not_awaited()

    async with _test_session_factory() as session:
        touch_result = await session.execute(
            select(CommunicationTouch).where(
                CommunicationTouch.recipient_id == UUID(member_id),
                CommunicationTouch.kind == TouchKind.sms.value,
            )
        )
        assert touch_result.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_chw_message_to_opted_out_member_is_in_app_only(client: AsyncClient):
    chw_tokens, member_tokens, chw_id, member_id, conv_id = await _setup_chw_member_conversation(
        client, "fanout_chw4@test.com", "fanout_member4@test.com"
    )
    await _set_member_phone_verified(member_id, "+15550300004", opt_out=True)

    fake_send = AsyncMock()
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send):
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Should be in-app only"},
            headers=auth_header(chw_tokens),
        )

    assert res.status_code == 201, f"Expected 201, got {res.status_code}: {res.text}"
    fake_send.assert_not_awaited()

    async with _test_session_factory() as session:
        touch_result = await session.execute(
            select(CommunicationTouch).where(
                CommunicationTouch.recipient_id == UUID(member_id),
                CommunicationTouch.kind == TouchKind.sms.value,
            )
        )
        assert touch_result.scalar_one_or_none() is None


# ─── 5. SMS send failure never blocks the in-app message ──────────────────────


@pytest.mark.asyncio
async def test_sms_send_failure_does_not_block_in_app_message(client: AsyncClient):
    chw_tokens, member_tokens, chw_id, member_id, conv_id = await _setup_chw_member_conversation(
        client, "fanout_chw5@test.com", "fanout_member5@test.com"
    )
    await _set_member_phone_verified(member_id, "+15550300005")

    failing_send = AsyncMock(
        return_value=SmsSendResult(success=False, error="vonage_status_500", status_code=500)
    )
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", failing_send):
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "This SMS mirror will fail"},
            headers=auth_header(chw_tokens),
        )

    # Best-effort: the in-app send succeeds regardless of the SMS outcome.
    assert res.status_code == 201, f"Expected 201, got {res.status_code}: {res.text}"
    assert res.json()["channel"] == "in_app"
    failing_send.assert_awaited_once()

    async with _test_session_factory() as session:
        msg_result = await session.execute(
            select(Message).where(Message.conversation_id == UUID(conv_id))
        )
        messages = msg_result.scalars().all()
        assert len(messages) == 1, "in-app Message must still be persisted"

        profile_result = await session.execute(
            select(MemberProfile).where(MemberProfile.user_id == UUID(member_id))
        )
        profile = profile_result.scalar_one()
        assert profile.last_sms_conversation_id is None, "sticky pointer must not be set on failure"

        touch_result = await session.execute(
            select(CommunicationTouch).where(
                CommunicationTouch.recipient_id == UUID(member_id),
                CommunicationTouch.kind == TouchKind.sms.value,
            )
        )
        assert touch_result.scalar_one_or_none() is None, "no touch-log row on failed send"


# ─── 6. Member-originated messages never fan out ───────────────────────────────


@pytest.mark.asyncio
async def test_member_message_does_not_fan_out_as_sms(client: AsyncClient):
    chw_tokens, member_tokens, chw_id, member_id, conv_id = await _setup_chw_member_conversation(
        client, "fanout_chw6@test.com", "fanout_member6@test.com"
    )
    await _set_member_phone_verified(member_id, "+15550300006")

    fake_send = AsyncMock()
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send):
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Member reply — must never SMS the CHW"},
            headers=auth_header(member_tokens),
        )

    assert res.status_code == 201, f"Expected 201, got {res.status_code}: {res.text}"
    fake_send.assert_not_awaited()

    async with _test_session_factory() as session:
        touch_result = await session.execute(
            select(CommunicationTouch).where(
                CommunicationTouch.kind == TouchKind.sms.value,
            )
        )
        assert touch_result.scalar_one_or_none() is None


# ─── 7. Attachment-only (empty body) message never attempts SMS ───────────────


@pytest.mark.asyncio
async def test_chw_attachment_only_message_does_not_attempt_sms(client: AsyncClient):
    chw_tokens, member_tokens, chw_id, member_id, conv_id = await _setup_chw_member_conversation(
        client, "fanout_chw7@test.com", "fanout_member7@test.com"
    )
    await _set_member_phone_verified(member_id, "+15550300007")

    fake_send = AsyncMock()
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send):
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={
                "body": "",
                "attachment_s3_key": "message-attachments/fake.png",
                "attachment_filename": "fake.png",
                "attachment_size_bytes": 1234,
                "attachment_content_type": "image/png",
            },
            headers=auth_header(chw_tokens),
        )

    assert res.status_code == 201, f"Expected 201, got {res.status_code}: {res.text}"
    fake_send.assert_not_awaited()


# ─── 8. Unexpected exception in the fanout is swallowed ───────────────────────


@pytest.mark.asyncio
async def test_sms_fanout_unexpected_exception_does_not_fail_the_request(client: AsyncClient):
    chw_tokens, member_tokens, chw_id, member_id, conv_id = await _setup_chw_member_conversation(
        client, "fanout_chw8@test.com", "fanout_member8@test.com"
    )
    await _set_member_phone_verified(member_id, "+15550300008")

    with patch(
        "app.services.sms_eligibility.check_sms_eligibility",
        AsyncMock(side_effect=RuntimeError("eligibility service exploded")),
    ):
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Fanout will blow up internally"},
            headers=auth_header(chw_tokens),
        )

    assert res.status_code == 201, f"Expected 201 despite fanout exception, got {res.status_code}: {res.text}"

    async with _test_session_factory() as session:
        msg_result = await session.execute(
            select(Message).where(Message.conversation_id == UUID(conv_id))
        )
        assert len(msg_result.scalars().all()) == 1, "in-app Message must still be persisted"


# ─── 9. Unit tests for defensive branches of the background function itself ──


@pytest.mark.asyncio
async def test_fanout_function_noop_when_member_user_missing():
    """Direct unit test of the background task: an unknown member_id must
    be a silent no-op (never raise) — defends against a race where the
    member row is deleted between message-send and background execution."""
    from app.routers.conversations import _fanout_sms_for_chw_message

    bogus_member_id = uuid4()
    bogus_chw_id = uuid4()
    bogus_conv_id = uuid4()

    async with _test_session_factory() as session:
        await _fanout_sms_for_chw_message(
            conversation_id=bogus_conv_id,
            chw_id=bogus_chw_id,
            member_id=bogus_member_id,
            message_body="irrelevant",
            db=session,
        )
        touch_result = await session.execute(
            select(CommunicationTouch).where(
                CommunicationTouch.recipient_id == bogus_member_id,
            )
        )
        assert touch_result.scalar_one_or_none() is None


@pytest.mark.asyncio
async def test_fanout_function_noop_when_member_profile_missing(client: AsyncClient):
    """A member User row that (abnormally) has no MemberProfile row must
    also be a silent no-op rather than raising inside the background task."""
    from datetime import UTC, datetime

    from app.routers.conversations import _fanout_sms_for_chw_message

    chw_tokens = await _register(client, "fanout_chw9@test.com", "chw")
    chw_id = _user_id_from_tokens(chw_tokens)

    # Insert a bare member User row directly, bypassing registration (which
    # always creates a MemberProfile) — simulates a data-integrity edge case.
    orphan_member_id = uuid4()
    async with _test_session_factory() as session:
        session.add(
            User(
                id=orphan_member_id,
                email="orphan_member@test.com",
                password_hash="unused",
                role="member",
                name="Orphan Member",
                phone="+15550300009",
                phone_verified_at=datetime.now(UTC),
            )
        )
        await session.commit()

    async with _test_session_factory() as session:
        await _fanout_sms_for_chw_message(
            conversation_id=uuid4(),
            chw_id=UUID(chw_id),
            member_id=orphan_member_id,
            message_body="irrelevant",
            db=session,
        )
        touch_result = await session.execute(
            select(CommunicationTouch).where(
                CommunicationTouch.recipient_id == orphan_member_id,
            )
        )
        assert touch_result.scalar_one_or_none() is None


# ─── 10. Regression: normal messaging (thread + unread) unaffected ────────────


@pytest.mark.asyncio
async def test_regression_thread_and_unread_count_still_work_with_fanout_present(
    client: AsyncClient,
):
    chw_tokens, member_tokens, chw_id, member_id, conv_id = await _setup_chw_member_conversation(
        client, "fanout_chw10@test.com", "fanout_member10@test.com"
    )
    await _set_member_phone_verified(member_id, "+15550300010")

    fake_send = AsyncMock(
        return_value=SmsSendResult(success=True, provider_message_id="vonage-msg-regress")
    )
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send):
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Hello from CHW"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201

        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Hello back from member"},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 201

    # Thread fetch still returns both messages, in order.
    res = await client.get(
        f"/api/v1/conversations/{conv_id}/messages", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    bodies = [m["body"] for m in res.json()]
    assert bodies == ["Hello from CHW", "Hello back from member"]

    # Unread count for the CHW (member's unread reply) still works via the
    # inbox list endpoint.
    res = await client.get("/api/v1/conversations/", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    conv = next(c for c in res.json() if c["id"] == conv_id)
    assert conv["unread_count"] == 1

    # Only the CHW's message triggered a fanout attempt. First outbound SMS to
    # this member, so the STOP-prompt cadence appends the opt-out line.
    fake_send.assert_awaited_once_with(
        "+15550300010", "Compass: Hello from CHW Reply STOP to opt out."
    )
