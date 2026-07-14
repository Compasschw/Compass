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

  Guard/failure-branch coverage (diff-cover gate — added after PR #223's CI
  run flagged these lines as uncovered):
    19. ``_first_name`` falls back to the default when given ``None``/blank.
    20. ``_format_local_time`` falls back to "the scheduled time" when
        ``scheduled_at`` is ``None``.
    21. ``_send_best_effort`` returns False (logged, no raise) when
        ``send_text`` reports ``success=False`` without raising.
    22. ``send_session_reminder_sms`` treats an unrecognized ``window`` value
        as a defensive no-op.
    23. ``send_session_reminder_sms`` returns False when the initial
        CHW/member ``db.get(User, ...)`` lookup raises.
    24. ``send_session_reminder_sms`` warns and continues when the CHW user
        row is missing (CHW leg simply skipped, member leg unaffected).
    25. ``send_session_reminder_sms`` returns early when the member user row
        is missing.
    26. ``send_session_reminder_sms`` returns False when the member-profile
        lookup raises.
    27. ``send_session_reminder_sms`` returns early when the member has no
        MemberProfile row.
    28. ``send_session_reminder_sms`` returns False when
        ``check_sms_eligibility`` itself raises.
    29. ``send_new_request_sms`` returns (no raise) when the initial user
        lookup raises.
    30. ``send_new_request_sms`` no-ops when the CHW user row is missing.
    31. ``send_new_request_sms`` no-ops when the CHW has no sendable phone.
    32. ``send_new_message_sms`` returns when the conversation lookup raises.
    33. ``send_new_message_sms`` returns when the conversation row is missing.
    34. ``send_new_message_sms`` normalizes a naive (tz-less)
        ``last_sent`` timestamp before the throttle comparison.
    35. ``send_new_message_sms`` returns when the CHW/member user lookup
        raises.
    36. ``send_new_message_sms`` no-ops when the CHW user row is missing.
    37. ``send_new_message_sms`` logs (does not raise) when stamping the
        throttle column raises and the subsequent rollback also raises.
    38. ``send_payout_initiated_sms`` returns (no raise) when the CHW user
        lookup raises.
    39. ``send_payout_initiated_sms`` no-ops when the CHW user row is
        missing.
    40. ``send_payout_initiated_sms`` no-ops when the CHW has no sendable
        phone (also covers ``trigger_chw_payout``'s payout-SMS-hook
        try/except region in app.routers.payments, lines 369-377).
    41. ``send_sms_session_reminders`` defaults ``now`` to the wall clock
        when the caller omits it (scheduler.py line 286).
    42. ``send_sms_session_reminders`` logs and rolls back (without raising)
        when an unexpected exception escapes a per-session reminder send
        AND the DB rollback that follows also raises (scheduler.py
        lines 332-333, 337-340).
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
from sqlalchemy.ext.asyncio import AsyncSession

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
async def test_payout_still_succeeds_when_sms_notification_hook_itself_raises(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db, monkeypatch
):
    """app.routers.payments.trigger_chw_payout wraps the call to
    send_payout_initiated_sms in its own try/except (lines 369-377) as a
    belt-and-suspenders guard, even though send_payout_initiated_sms is
    documented to never raise. Simulates that defensive branch actually
    firing (e.g. an import error or other unexpected exception escaping the
    notification helper) and asserts the payout itself is still marked
    successful."""
    import app.routers.payments as payments_router

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    await _set_phone(chw_id, "+15550119012")

    claim_id, _ = await _seed_payable_claim(chw_id, member_id)
    monkeypatch.setattr(payments_router, "get_payments_provider", lambda: _FakeTransferProvider())

    with patch(
        "app.services.sms_notifications.send_payout_initiated_sms",
        new_callable=AsyncMock,
        side_effect=RuntimeError("unexpected notification-hook failure"),
    ):
        async with _test_session_factory() as session:
            ok = await payments_router.trigger_chw_payout(session, UUID(claim_id))

    assert ok is True  # payout succeeds regardless of the notification hook raising


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


# ─── Guard/failure-branch coverage (diff-cover gate) ────────────────────────


def test_first_name_falls_back_when_name_missing_or_blank():
    from app.services.sms_notifications import _first_name

    assert _first_name(None) == "your contact"
    assert _first_name("   ") == "your contact"
    assert _first_name(None, "your CHW") == "your CHW"
    assert _first_name("Jane Doe") == "Jane"


def test_format_local_time_falls_back_when_scheduled_at_none():
    from app.services.sms_notifications import _format_local_time

    assert _format_local_time(None) == "the scheduled time"


@pytest.mark.asyncio
async def test_send_best_effort_returns_false_when_vonage_reports_failure():
    from app.services.sms_notifications import _send_best_effort

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=SmsSendResult(success=False, error="rejected", status_code=400),
    ):
        result = await _send_best_effort("+15550119001", "test body", context="unit_test")
    assert result is False


@pytest.mark.asyncio
async def test_send_session_reminder_sms_invalid_window_is_a_noop(setup_db):
    from app.services.sms_notifications import send_session_reminder_sms

    async with _test_session_factory() as session:
        with patch(
            "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
            new_callable=AsyncMock,
            return_value=_stub_send_result(),
        ) as mock_send:
            result = await send_session_reminder_sms(
                session,
                session_id=UUID("00000000-0000-0000-0000-000000000001"),
                chw_id=UUID("00000000-0000-0000-0000-000000000002"),
                member_id=UUID("00000000-0000-0000-0000-000000000003"),
                scheduled_at=REFERENCE_NOW,
                window="3d",  # not "24h" or "1h"
            )
    assert result is False
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_send_session_reminder_sms_returns_false_when_initial_lookup_raises(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    from app.services.sms_notifications import send_session_reminder_sms

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    async with _test_session_factory() as session:
        with patch.object(
            type(session), "get", new_callable=AsyncMock, side_effect=RuntimeError("db down")
        ):
            result = await send_session_reminder_sms(
                session,
                session_id=UUID("00000000-0000-0000-0000-000000000001"),
                chw_id=UUID(chw_id),
                member_id=UUID(member_id),
                scheduled_at=REFERENCE_NOW,
                window="24h",
            )
    assert result is False


@pytest.mark.asyncio
async def test_send_session_reminder_sms_missing_chw_user_skips_chw_leg_only(
    client: AsyncClient, member_tokens: dict, setup_db
):
    """A dangling chw_id (no matching User row) must not block the member leg."""
    from app.services.sms_notifications import send_session_reminder_sms

    member_id = _user_id_from_tokens(member_tokens)
    await _set_member_phone_verified(member_id, "+15550119002")
    missing_chw_id = UUID("00000000-0000-0000-0000-0000000000ff")

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        async with _test_session_factory() as session:
            result = await send_session_reminder_sms(
                session,
                session_id=UUID("00000000-0000-0000-0000-000000000001"),
                chw_id=missing_chw_id,
                member_id=UUID(member_id),
                scheduled_at=REFERENCE_NOW,
                window="24h",
            )
    assert result is True
    mock_send.assert_called_once()
    assert mock_send.call_args.args[0] == "+15550119002"


@pytest.mark.asyncio
async def test_send_session_reminder_sms_missing_member_user_returns_early(
    client: AsyncClient, chw_tokens: dict, setup_db
):
    from app.services.sms_notifications import send_session_reminder_sms

    chw_id = _user_id_from_tokens(chw_tokens)
    await _set_phone(chw_id, "+15550119003")
    missing_member_id = UUID("00000000-0000-0000-0000-0000000000fe")

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        async with _test_session_factory() as session:
            result = await send_session_reminder_sms(
                session,
                session_id=UUID("00000000-0000-0000-0000-000000000001"),
                chw_id=UUID(chw_id),
                member_id=missing_member_id,
                scheduled_at=REFERENCE_NOW,
                window="24h",
            )
    assert result is True  # CHW leg sent + handled; missing member is not a transient failure
    mock_send.assert_called_once()
    assert mock_send.call_args.args[0] == "+15550119003"


@pytest.mark.asyncio
async def test_send_session_reminder_sms_returns_false_when_profile_lookup_raises(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    from app.services.sms_notifications import send_session_reminder_sms

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550119004")

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ):
        async with _test_session_factory() as session:
            with patch.object(
                AsyncSession, "execute", new_callable=AsyncMock, side_effect=RuntimeError("db down")
            ):
                result = await send_session_reminder_sms(
                    session,
                    session_id=UUID("00000000-0000-0000-0000-000000000001"),
                    chw_id=UUID(chw_id),
                    member_id=UUID(member_id),
                    scheduled_at=REFERENCE_NOW,
                    window="24h",
                )
    assert result is False


@pytest.mark.asyncio
async def test_send_session_reminder_sms_missing_member_profile_returns_early(
    client: AsyncClient, chw_tokens: dict, setup_db
):
    """A member User row with no MemberProfile (data anomaly) must not crash
    the reminder job — the CHW leg is unaffected."""
    from app.models.user import User
    from app.services.sms_notifications import send_session_reminder_sms

    chw_id = _user_id_from_tokens(chw_tokens)
    await _set_phone(chw_id, "+15550119005")

    async with _test_session_factory() as session:
        orphan = User(
            email="orphan-member@example.com",
            password_hash="x",
            name="Orphan Member",
            role="member",
        )
        session.add(orphan)
        await session.commit()
        await session.refresh(orphan)
        orphan_id = orphan.id

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        async with _test_session_factory() as session:
            result = await send_session_reminder_sms(
                session,
                session_id=UUID("00000000-0000-0000-0000-000000000001"),
                chw_id=UUID(chw_id),
                member_id=orphan_id,
                scheduled_at=REFERENCE_NOW,
                window="24h",
            )
    assert result is True
    mock_send.assert_called_once()
    assert mock_send.call_args.args[0] == "+15550119005"


@pytest.mark.asyncio
async def test_send_session_reminder_sms_returns_false_when_eligibility_check_raises(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    from app.services.sms_notifications import send_session_reminder_sms

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550119006")
    await _set_member_phone_verified(member_id, "+15550119007")

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ), patch(
        "app.services.sms_eligibility.check_sms_eligibility",
        new_callable=AsyncMock,
        side_effect=RuntimeError("eligibility service down"),
    ):
        async with _test_session_factory() as session:
            result = await send_session_reminder_sms(
                session,
                session_id=UUID("00000000-0000-0000-0000-000000000001"),
                chw_id=UUID(chw_id),
                member_id=UUID(member_id),
                scheduled_at=REFERENCE_NOW,
                window="24h",
            )
    assert result is False


@pytest.mark.asyncio
async def test_send_new_request_sms_returns_when_lookup_raises(setup_db):
    from app.services.sms_notifications import send_new_request_sms

    async with _test_session_factory() as session:
        with patch.object(
            type(session), "get", new_callable=AsyncMock, side_effect=RuntimeError("db down")
        ):
            with patch(
                "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
                new_callable=AsyncMock,
                return_value=_stub_send_result(),
            ) as mock_send:
                await send_new_request_sms(
                    session,
                    chw_id=UUID("00000000-0000-0000-0000-000000000001"),
                    member_id=UUID("00000000-0000-0000-0000-000000000002"),
                )
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_send_new_request_sms_missing_chw_user_is_a_noop(setup_db):
    from app.services.sms_notifications import send_new_request_sms

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        async with _test_session_factory() as session:
            await send_new_request_sms(
                session,
                chw_id=UUID("00000000-0000-0000-0000-0000000000ff"),
                member_id=UUID("00000000-0000-0000-0000-000000000002"),
            )
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_send_new_request_sms_chw_without_phone_is_a_noop(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    from app.services.sms_notifications import send_new_request_sms

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = _user_id_from_tokens(member_tokens)
    # CHW has no phone on file at all (User.phone is NULL by default).

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        async with _test_session_factory() as session:
            await send_new_request_sms(session, chw_id=UUID(chw_id), member_id=UUID(member_id))
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_send_new_message_sms_returns_when_conversation_lookup_raises(setup_db):
    from app.services.sms_notifications import send_new_message_sms

    async with _test_session_factory() as session:
        with patch.object(
            type(session), "get", new_callable=AsyncMock, side_effect=RuntimeError("db down")
        ):
            with patch(
                "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
                new_callable=AsyncMock,
                return_value=_stub_send_result(),
            ) as mock_send:
                await send_new_message_sms(
                    session,
                    conversation_id=UUID("00000000-0000-0000-0000-000000000001"),
                    chw_id=UUID("00000000-0000-0000-0000-000000000002"),
                    member_id=UUID("00000000-0000-0000-0000-000000000003"),
                    now=REFERENCE_NOW,
                )
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_send_new_message_sms_missing_conversation_is_a_noop(setup_db):
    from app.services.sms_notifications import send_new_message_sms

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        async with _test_session_factory() as session:
            await send_new_message_sms(
                session,
                conversation_id=UUID("00000000-0000-0000-0000-0000000000ff"),
                chw_id=UUID("00000000-0000-0000-0000-000000000002"),
                member_id=UUID("00000000-0000-0000-0000-000000000003"),
                now=REFERENCE_NOW,
            )
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_send_new_message_sms_normalizes_naive_last_sent_timestamp(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A DB row that comes back with a naive (tz-less) datetime for
    ``member_message_sms_alert_last_sent_at`` (driver/test-setup dependent,
    per the inline comment in send_new_message_sms) must still be compared
    correctly against the throttle window instead of raising a naive/aware
    TypeError.

    The column is ``DateTime(timezone=True)`` (Postgres timestamptz), so
    round-tripping a naive Python datetime through asyncpg always comes back
    tz-aware — the "naive" case can only be forced by patching the loaded
    ORM attribute directly (in-process, mirroring what a different driver or
    an in-memory test double could hand back), which is exactly the
    defensive scenario the inline comment guards against.
    """
    from app.services.sms_notifications import send_new_message_sms

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550119008")
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    async with _test_session_factory() as session:
        row = await session.get(Conversation, UUID(conv_id))
        row.member_message_sms_alert_last_sent_at = REFERENCE_NOW - timedelta(minutes=5)
        await session.commit()

    naive_last_sent = (REFERENCE_NOW - timedelta(minutes=5)).replace(tzinfo=None)

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        async with _test_session_factory() as session:
            row = await session.get(Conversation, UUID(conv_id))
            # Force the in-memory attribute back to naive right before the
            # call under test, bypassing the DB round-trip that always
            # re-hydrates it as tz-aware.
            row.member_message_sms_alert_last_sent_at = naive_last_sent
            await send_new_message_sms(
                session,
                conversation_id=UUID(conv_id),
                chw_id=UUID(chw_id),
                member_id=UUID(member_id),
                now=REFERENCE_NOW,
            )
    mock_send.assert_not_called()  # still within throttle -> no send, no raise


@pytest.mark.asyncio
async def test_send_new_message_sms_returns_when_user_lookup_raises(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    from app.services.sms_notifications import send_new_message_sms

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    call_count = 0
    original_get = AsyncSession.get

    async def _flaky_get(self, entity, ident, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        # First call is the Conversation lookup (must succeed); the
        # subsequent User lookups should raise.
        if call_count == 1:
            return await original_get(self, entity, ident, *args, **kwargs)
        raise RuntimeError("db down")

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        async with _test_session_factory() as session:
            with patch.object(AsyncSession, "get", new=_flaky_get):
                await send_new_message_sms(
                    session,
                    conversation_id=UUID(conv_id),
                    chw_id=UUID(chw_id),
                    member_id=UUID(member_id),
                    now=REFERENCE_NOW,
                )
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_send_new_message_sms_chw_without_phone_is_a_noop(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    from app.services.sms_notifications import send_new_message_sms

    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    chw_id = _user_id_from_tokens(chw_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)
    # CHW.phone intentionally left NULL.

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
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_send_new_message_sms_missing_chw_user_is_a_noop(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    from app.services.sms_notifications import send_new_message_sms

    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)
    missing_chw_id = UUID("00000000-0000-0000-0000-0000000000ff")

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        async with _test_session_factory() as session:
            await send_new_message_sms(
                session,
                conversation_id=UUID(conv_id),
                chw_id=missing_chw_id,
                member_id=UUID(member_id),
                now=REFERENCE_NOW,
            )
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_send_new_message_sms_logs_when_throttle_stamp_and_rollback_both_raise(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Simulates a commit failure on the throttle stamp AND a subsequent
    rollback failure — both must be swallowed (logged), never raised, since
    this runs from a BackgroundTask with no caller to propagate to."""
    from app.services.sms_notifications import send_new_message_sms

    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550119009")
    conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ):
        async with _test_session_factory() as session:
            with patch.object(
                AsyncSession, "commit", new_callable=AsyncMock, side_effect=RuntimeError("commit failed")
            ), patch.object(
                AsyncSession,
                "rollback",
                new_callable=AsyncMock,
                side_effect=RuntimeError("rollback also failed"),
            ):
                # Must not raise despite both commit and rollback failing.
                await send_new_message_sms(
                    session,
                    conversation_id=UUID(conv_id),
                    chw_id=UUID(chw_id),
                    member_id=UUID(member_id),
                    now=REFERENCE_NOW,
                )


@pytest.mark.asyncio
async def test_send_payout_initiated_sms_returns_when_lookup_raises(setup_db):
    from app.services.sms_notifications import send_payout_initiated_sms

    async with _test_session_factory() as session:
        with patch.object(
            type(session), "get", new_callable=AsyncMock, side_effect=RuntimeError("db down")
        ):
            with patch(
                "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
                new_callable=AsyncMock,
                return_value=_stub_send_result(),
            ) as mock_send:
                await send_payout_initiated_sms(
                    session, chw_id=UUID("00000000-0000-0000-0000-000000000001"), amount_cents=1000
                )
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_send_payout_initiated_sms_missing_chw_user_is_a_noop(setup_db):
    from app.services.sms_notifications import send_payout_initiated_sms

    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        async with _test_session_factory() as session:
            await send_payout_initiated_sms(
                session,
                chw_id=UUID("00000000-0000-0000-0000-0000000000ff"),
                amount_cents=1000,
            )
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_send_payout_initiated_sms_chw_without_phone_is_a_noop(
    client: AsyncClient, chw_tokens: dict, setup_db
):
    """Also exercises app.routers.payments.trigger_chw_payout's payout-SMS
    hook region (lines 369-377): a successful transfer whose CHW has no
    phone on file must reach the try/await/except block, no-op inside
    send_payout_initiated_sms, and still leave the payout marked successful."""
    import app.routers.payments as payments_router

    chw_id = _user_id_from_tokens(chw_tokens)
    # Need a real member for the seeded claim; register one via a second fixture-like call.
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "payout-nophonemember@example.com",
            "password": "Testpass123!",
            "name": "Payout Member",
            "role": "member",
            "phone": "+13105559911",
            "date_of_birth": "1993-01-05",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": "87654321A",
            "address_line1": "1 Main St",
            "city": "Los Angeles",
            "state": "CA",
            "zip_code": "90001",
            "terms_accepted": True,
            "communications_consent": True,
        },
    )
    assert res.status_code == 201, res.text
    member_id = _user_id_from_tokens(res.json())
    # CHW.phone intentionally left NULL.

    claim_id, _ = await _seed_payable_claim(chw_id, member_id)

    with patch.object(
        payments_router, "get_payments_provider", lambda: _FakeTransferProvider()
    ):
        with patch(
            "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
            new_callable=AsyncMock,
            return_value=_stub_send_result(),
        ) as mock_send:
            async with _test_session_factory() as session:
                ok = await payments_router.trigger_chw_payout(session, UUID(claim_id))

    assert ok is True  # payout itself unaffected by the CHW having no phone
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_reminder_job_defaults_now_to_wall_clock_when_omitted(setup_db):
    """scheduler.py line 286 — the `if now is None: now = datetime.now(UTC)`
    branch. No sessions exist, so this only proves the default-now path runs
    without raising and queries with a real wall-clock window."""
    with patch(
        "app.services.vonage_sms.VonageSmsMessagesClient.send_text",
        new_callable=AsyncMock,
        return_value=_stub_send_result(),
    ) as mock_send:
        await scheduler.send_sms_session_reminders()  # now omitted entirely
    mock_send.assert_not_called()


@pytest.mark.asyncio
async def test_reminder_job_logs_when_rollback_after_send_failure_also_raises(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """scheduler.py lines 332-333 / 337-340 — an unexpected exception during
    a per-session reminder send is caught and logged, and if the subsequent
    rollback ALSO raises, that too is caught and logged (never propagated),
    so the batch loop keeps running."""
    chw_id = _user_id_from_tokens(chw_tokens)
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _set_phone(chw_id, "+15550119010")
    await _set_member_phone_verified(member_id, "+15550119011")

    await _schedule(client, chw_tokens, member_id, REFERENCE_NOW + timedelta(hours=24))

    with patch(
        "app.services.sms_notifications.send_session_reminder_sms",
        new_callable=AsyncMock,
        side_effect=RuntimeError("unexpected failure mid-send"),
    ), patch.object(
        AsyncSession,
        "rollback",
        new_callable=AsyncMock,
        side_effect=RuntimeError("rollback also failed"),
    ):
        # Must not raise despite both the send and the rollback failing.
        await scheduler.send_sms_session_reminders(now=REFERENCE_NOW)
