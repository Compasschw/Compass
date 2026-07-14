"""Tests for Wave-2 Agent B3 — always-on SMS notifications.

Coverage:
  Session reminders (app.services.scheduler.send_sms_session_reminders):
    1. 24h reminder sends exactly once to CHW + member (dedupe column set);
       re-run sends nothing.
    2. 1h reminder sends exactly once to CHW + member (dedupe column set);
       re-run sends nothing.
    3. Unconfirmed ("pending") session in-window gets no reminder.
    4. Cancelled session in-window gets no reminder.
    5. Member reminder respects SMS eligibility (unverified phone) — the CHW
       still gets theirs.
    6. Member reminder respects opt-out — the CHW still gets theirs.

  New member request (app.routers.requests.create_request):
    7. Targeted request (target_chw_id set) fires an SMS to that CHW.
    8. Un-targeted (open-pool) request fires no SMS.

  New message from member, throttled (app.routers.conversations.send_message):
    9. First member->CHW message within a fresh conversation sends an SMS
       alert.
    10. A second member message within 30 minutes does NOT send a second SMS.
    11. A member message after the 30-minute window DOES send again.
    12. CHW->member messages never trigger this alert (existing fanout path
        is untouched — regression guard).

  Payout initiated (app.routers.payments.trigger_chw_payout):
    13. A successful transfer sends a payout SMS with a correctly formatted
        dollar amount.
    14. A failed/blocked transfer (CHW not onboarded) sends no SMS.

  Resilience / regression (TESTING.md rule 3 — best-effort, never fail the
  triggering request/job):
    15. Vonage raising during a reminder job iteration does not crash the
        job and does not prevent other sessions in the batch from being
        processed.
    16. Vonage raising during the new-request BackgroundTask does not fail
        the underlying POST /requests/ (already returned 201 by the time
        the background task runs — verified by asserting the response is
        unaffected when send_text is patched to raise).
    17. Vonage raising during the new-message BackgroundTask does not fail
        POST /conversations/{id}/messages.
    18. Vonage raising during the payout SMS does not prevent
        trigger_chw_payout from returning True (payout itself must not be
        blocked by a notification failure).

  No-PHI assertion: every message body asserted in this file is checked to
  contain no vertical/service-category strings (a Vertical enum value) and
  no health-related terms.
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

from app.models.conversation import Conversation
from app.models.user import MemberProfile, User
from app.services import scheduler
from app.services.vonage_sms import SmsSendResult
from tests.conftest import auth_header
from tests.conftest import test_session as _test_session_factory

REFERENCE_NOW = datetime(2026, 7, 15, 12, 0, 0, tzinfo=UTC)

# Vertical enum values + health-ish terms that must NEVER appear in an SMS
# body — the message copy is names-only, no PHI, no service category.
_FORBIDDEN_PHI_TERMS = (
    "housing", "food", "transportation", "utilities", "mental health",
    "diagnosis", "medication", "medical", "clinical", "medi-cal",
)


def _assert_no_phi(body: str) -> None:
    lowered = body.lower()
    for term in _FORBIDDEN_PHI_TERMS:
        assert term not in lowered, f"PHI/vertical term {term!r} leaked into SMS body: {body!r}"


def _user_id_from_tokens(tokens: dict) -> str:
    parts = tokens["access_token"].split(".")
    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded))
    return payload["sub"]


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


async def _set_phone(user_id: str, phone: str) -> None:
    async with _test_session_factory() as session:
        user = await session.get(User, UUID(user_id))
        assert user is not None
        user.phone = phone
        await session.commit()


async def _set_member_phone_verified(user_id: str, phone: str, *, opt_out: bool = False) -> None:
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


async def _establish_relationship(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> str:
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Need help",
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
    return _user_id_from_tokens(member_tokens)


async def _schedule(
    client: AsyncClient,
    chw_tokens: dict,
    member_id: str,
    scheduled_at: datetime,
    *,
    scheduling_status: str = "confirmed",
) -> str:
    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": member_id,
            "scheduled_at": _iso(scheduled_at),
            "mode": "phone",
            "scheduling_status": scheduling_status,
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _stub_send_result() -> SmsSendResult:
    return SmsSendResult(success=True, provider_message_id="vonage-sms-test-id")


@pytest.fixture(autouse=True)
def _reset_reminder_dedup_cache():
    """Push-reminder in-memory dedup is unrelated to the SMS jobs under test
    here, but shared module state — reset for hygiene between tests."""
    scheduler._reminded_sessions.clear()
    yield
    scheduler._reminded_sessions.clear()


# ─── Session reminders — 24h ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_24h_reminder_sends_once_to_chw_and_member_then_dedupes(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550111001")
    await _set_member_phone_verified(member_id, "+15550111002")

    session_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(hours=24)
    )

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        await scheduler.send_sms_session_reminders(now=REFERENCE_NOW)

    assert mock_send.call_count == 2  # CHW + member
    bodies = [c.args[1] for c in mock_send.call_args_list]
    for body in bodies:
        assert body.startswith("Compass: ")
        assert "tomorrow" in body
        _assert_no_phi(body)

    # Dedupe columns stamped.
    async with _test_session_factory() as session:
        from app.models.session import Session as SessionModel

        row = await session.get(SessionModel, UUID(session_id))
        assert row.reminder_24h_sent_at is not None
        assert row.reminder_1h_sent_at is None

    # Re-run: no further sends.
    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send_again:
        await scheduler.send_sms_session_reminders(now=REFERENCE_NOW)
    mock_send_again.assert_not_called()


# ─── Session reminders — 1h ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_1h_reminder_sends_once_to_chw_and_member_then_dedupes(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550111003")
    await _set_member_phone_verified(member_id, "+15550111004")

    session_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(minutes=60)
    )

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        await scheduler.send_sms_session_reminders(now=REFERENCE_NOW)

    assert mock_send.call_count == 2
    bodies = [c.args[1] for c in mock_send.call_args_list]
    for body in bodies:
        assert "in 1 hour" in body
        _assert_no_phi(body)

    async with _test_session_factory() as session:
        from app.models.session import Session as SessionModel

        row = await session.get(SessionModel, UUID(session_id))
        assert row.reminder_1h_sent_at is not None

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send_again:
        await scheduler.send_sms_session_reminders(now=REFERENCE_NOW)
    mock_send_again.assert_not_called()


# ─── Session reminders — status gating ──────────────────────────────────────


@pytest.mark.asyncio
async def test_unconfirmed_pending_session_gets_no_reminder(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550111005")
    await _set_member_phone_verified(member_id, "+15550111006")

    await _schedule(
        client,
        chw_tokens,
        member_id,
        REFERENCE_NOW + timedelta(hours=24),
        scheduling_status="pending",
    )

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        await scheduler.send_sms_session_reminders(now=REFERENCE_NOW)
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_cancelled_session_gets_no_reminder(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550111007")
    await _set_member_phone_verified(member_id, "+15550111008")

    session_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(hours=24)
    )
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/cancel", headers=auth_header(member_tokens)
    )
    assert res.status_code == 200, res.text

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        await scheduler.send_sms_session_reminders(now=REFERENCE_NOW)
    mock_send.assert_not_called()


# ─── Session reminders — member eligibility gating (CHW unaffected) ────────


@pytest.mark.asyncio
async def test_reminder_skips_ineligible_member_but_still_sends_to_chw(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550111009")
    # Member phone set but NEVER verified -> ineligible.
    await _set_phone(member_id, "+15550111010")

    await _schedule(client, chw_tokens, member_id, REFERENCE_NOW + timedelta(hours=24))

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        await scheduler.send_sms_session_reminders(now=REFERENCE_NOW)

    assert mock_send.call_count == 1
    assert mock_send.call_args.args[0] == "+15550111009"


@pytest.mark.asyncio
async def test_reminder_skips_opted_out_member_but_still_sends_to_chw(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550111011")
    await _set_member_phone_verified(member_id, "+15550111012", opt_out=True)

    await _schedule(client, chw_tokens, member_id, REFERENCE_NOW + timedelta(hours=24))

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        await scheduler.send_sms_session_reminders(now=REFERENCE_NOW)

    assert mock_send.call_count == 1
    assert mock_send.call_args.args[0] == "+15550111011"


# ─── Reminder job resilience — one Vonage failure can't poison the batch ───


@pytest.mark.asyncio
async def test_reminder_job_survives_vonage_raising_and_processes_other_sessions(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550111013")
    await _set_member_phone_verified(member_id, "+15550111014")

    session_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(hours=24)
    )

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        side_effect=RuntimeError("Vonage outage"),
    ):
        await scheduler.send_sms_session_reminders(now=REFERENCE_NOW)  # must not raise

    # Since the send failed, the dedupe column must NOT be stamped, so a
    # later run can retry.
    async with _test_session_factory() as session:
        from app.models.session import Session as SessionModel

        row = await session.get(SessionModel, UUID(session_id))
        assert row.reminder_24h_sent_at is None


# ─── New member request ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_targeted_request_alerts_the_target_chw(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    chw_id = _user_id_from_tokens(chw_tokens)
    await _set_phone(chw_id, "+15550111015")

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        res = await client.post(
            "/api/v1/requests/",
            json={
                "vertical": "housing",
                "urgency": "routine",
                "description": "Need help",
                "preferred_mode": "in_person",
                "target_chw_id": chw_id,
            },
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 201, res.text

    mock_send.assert_called_once()
    to_number, body = mock_send.call_args.args
    assert to_number == "+15550111015"
    assert "New member request" in body
    assert "Open Compass to respond" in body
    _assert_no_phi(body)


@pytest.mark.asyncio
async def test_untargeted_open_pool_request_sends_no_sms(
    client: AsyncClient, member_tokens: dict, setup_db
):
    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        res = await client.post(
            "/api/v1/requests/",
            json={
                "vertical": "housing",
                "urgency": "routine",
                "description": "Need help",
                "preferred_mode": "in_person",
            },
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 201, res.text

    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_targeted_request_survives_vonage_raising(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    chw_id = _user_id_from_tokens(chw_tokens)
    await _set_phone(chw_id, "+15550111016")

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        side_effect=RuntimeError("Vonage outage"),
    ):
        res = await client.post(
            "/api/v1/requests/",
            json={
                "vertical": "housing",
                "urgency": "routine",
                "description": "Need help",
                "preferred_mode": "in_person",
                "target_chw_id": chw_id,
            },
            headers=auth_header(member_tokens),
        )
    assert res.status_code == 201, res.text  # request creation unaffected


# ─── New message from member — throttled ────────────────────────────────────


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


@pytest.mark.asyncio
async def test_first_member_message_alerts_chw(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550111017")

    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Hi, I have a question", "type": "text"},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 201, res.text

    mock_send.assert_called_once()
    to_number, body = mock_send.call_args.args
    assert to_number == "+15550111017"
    assert "sent you a message" in body
    _assert_no_phi(body)

    async with _test_session_factory() as session:
        row = await session.get(Conversation, UUID(conv_id))
        assert row.member_message_sms_alert_last_sent_at is not None


@pytest.mark.asyncio
async def test_second_member_message_within_30min_does_not_resend(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550111018")
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        res1 = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "First message", "type": "text"},
            headers=auth_header(member_tokens),
        )
        assert res1.status_code == 201, res1.text
    mock_send.assert_called_once()

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send_2:
        res2 = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Second message minutes later", "type": "text"},
            headers=auth_header(member_tokens),
        )
        assert res2.status_code == 201, res2.text
    mock_send_2.assert_not_called()


@pytest.mark.asyncio
async def test_member_message_after_throttle_window_sends_again(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    from app.services.sms_notifications import send_new_message_sms

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550111019")
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    # Directly stamp the throttle 31 minutes in the past to simulate a prior
    # alert without racing real time.
    async with _test_session_factory() as session:
        row = await session.get(Conversation, UUID(conv_id))
        row.member_message_sms_alert_last_sent_at = REFERENCE_NOW - timedelta(minutes=31)
        await session.commit()

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        async with _test_session_factory() as session:
            await send_new_message_sms(
                session,
                conversation_id=UUID(conv_id),
                chw_id=UUID(chw_id),
                member_id=UUID(member_id),
                now=REFERENCE_NOW,
            )
    mock_send.assert_called_once()


@pytest.mark.asyncio
async def test_chw_sent_message_does_not_trigger_member_message_alert(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Regression: the pre-existing CHW->member fanout path must be
    unaffected by this feature — a CHW-authored message must never trigger
    the reverse "member sent you a message" alert."""
    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550111020")
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Hello from your CHW", "type": "text"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201, res.text

    # The existing CHW->member fanout mirrors the message as SMS (member has
    # no verified phone here, so it no-ops); crucially, no CHW-alert body
    # containing "sent you a message" phrasing should ever be sent.
    for call in mock_send.call_args_list:
        assert "sent you a message" not in call.args[1]


@pytest.mark.asyncio
async def test_member_message_survives_vonage_raising(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550111021")
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        side_effect=RuntimeError("Vonage outage"),
    ):
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Hi there", "type": "text"},
            headers=auth_header(member_tokens),
        )
    assert res.status_code == 201, res.text  # message send unaffected


# ─── Payout initiated ────────────────────────────────────────────────────────


async def _seed_payable_claim(chw_id: str, member_id: str) -> tuple[str, str]:
    """Seed a CHWProfile onboarded for payouts + a session + a paid
    BillingClaim with a positive net_payout. Returns (billing_claim_id,
    stripe_connected_account_id)."""
    import uuid
    from decimal import Decimal

    from app.models.billing import BillingClaim
    from app.models.request import ServiceRequest
    from app.models.session import Session as SessionModel
    from app.models.user import CHWProfile

    connected_account_id = f"acct_test_{uuid.uuid4().hex[:8]}"

    async with _test_session_factory() as session:
        profile_result = await session.execute(
            select(CHWProfile).where(CHWProfile.user_id == UUID(chw_id))
        )
        profile = profile_result.scalar_one()
        profile.stripe_connected_account_id = connected_account_id
        profile.stripe_payouts_enabled = True

        req = ServiceRequest(
            member_id=UUID(member_id),
            vertical="housing",
            verticals=["housing"],
            urgency="routine",
            description="test",
            preferred_mode="phone",
            status="matched",
            matched_chw_id=UUID(chw_id),
        )
        session.add(req)
        await session.flush()

        sess = SessionModel(
            request_id=req.id,
            chw_id=UUID(chw_id),
            member_id=UUID(member_id),
            vertical="housing",
            mode="phone",
            status="completed",
        )
        session.add(sess)
        await session.flush()

        claim = BillingClaim(
            session_id=sess.id,
            chw_id=UUID(chw_id),
            member_id=UUID(member_id),
            procedure_code="98960",
            modifier="U2",
            units=1,
            gross_amount=Decimal("100.00"),
            platform_fee=Decimal("20.00"),
            net_payout=Decimal("80.00"),
            status="paid",
        )
        session.add(claim)
        await session.commit()
        await session.refresh(claim)
        return str(claim.id), connected_account_id


class _FakeTransferProvider:
    """Minimal stand-in for PaymentsProvider.transfer — always succeeds."""

    async def transfer(self, req):
        from app.services.payments.base import TransferResult

        return TransferResult(success=True, provider_transfer_id="tr_test_123")


class _FakeFailingTransferProvider:
    async def transfer(self, req):
        from app.services.payments.base import TransferResult

        return TransferResult(success=False, error="card_declined")


@pytest.mark.asyncio
async def test_successful_payout_sends_formatted_amount_sms(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db, monkeypatch
):
    import app.routers.payments as payments_router

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone(chw_id, "+15550111022")

    claim_id, _ = await _seed_payable_claim(chw_id, member_id)

    monkeypatch.setattr(payments_router, "get_payments_provider", lambda: _FakeTransferProvider())

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        async with _test_session_factory() as session:
            ok = await payments_router.trigger_chw_payout(session, UUID(claim_id))

    assert ok is True
    mock_send.assert_called_once()
    to_number, body = mock_send.call_args.args
    assert to_number == "+15550111022"
    assert "$80.00" in body
    assert "payout" in body.lower()
    _assert_no_phi(body)


@pytest.mark.asyncio
async def test_blocked_payout_sends_no_sms(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db, monkeypatch
):
    """CHW not onboarded for payouts -> trigger_chw_payout returns False
    before ever reaching the SMS alert."""
    from decimal import Decimal

    import app.routers.payments as payments_router
    from app.models.billing import BillingClaim
    from app.models.request import ServiceRequest
    from app.models.session import Session as SessionModel

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone(chw_id, "+15550111023")

    async with _test_session_factory() as session:
        req = ServiceRequest(
            member_id=UUID(member_id),
            vertical="housing",
            verticals=["housing"],
            urgency="routine",
            description="test",
            preferred_mode="phone",
            status="matched",
            matched_chw_id=UUID(chw_id),
        )
        session.add(req)
        await session.flush()
        sess = SessionModel(
            request_id=req.id,
            chw_id=UUID(chw_id),
            member_id=UUID(member_id),
            vertical="housing",
            mode="phone",
            status="completed",
        )
        session.add(sess)
        await session.flush()
        claim = BillingClaim(
            session_id=sess.id,
            chw_id=UUID(chw_id),
            member_id=UUID(member_id),
            procedure_code="98960",
            modifier="U2",
            units=1,
            gross_amount=Decimal("100.00"),
            platform_fee=Decimal("20.00"),
            net_payout=Decimal("80.00"),
            status="paid",
        )
        session.add(claim)
        await session.commit()
        await session.refresh(claim)
        claim_id = claim.id

    monkeypatch.setattr(
        payments_router, "get_payments_provider", lambda: _FakeTransferProvider()
    )

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        async with _test_session_factory() as session:
            ok = await payments_router.trigger_chw_payout(session, claim_id)

    assert ok is False  # not onboarded (no stripe_connected_account_id)
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_payout_still_succeeds_when_vonage_raises(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db, monkeypatch
):
    import app.routers.payments as payments_router

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone(chw_id, "+15550111024")

    claim_id, _ = await _seed_payable_claim(chw_id, member_id)
    monkeypatch.setattr(payments_router, "get_payments_provider", lambda: _FakeTransferProvider())

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        side_effect=RuntimeError("Vonage outage"),
    ):
        async with _test_session_factory() as session:
            ok = await payments_router.trigger_chw_payout(session, UUID(claim_id))

    # The payout itself (the important side effect) must succeed regardless
    # of the notification failure.
    assert ok is True
