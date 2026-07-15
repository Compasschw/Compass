"""Confirmation SMS sends + endpoint hooks (SMS Output Spec 1 §3).

Three best-effort member-facing confirmation functions:
  - send_request_received_sms
  - send_session_confirmed_sms
  - send_session_changed_sms  (cancelled / rescheduled)

For each function: an eligible member gets exactly one send with the exact
copy (no PHI beyond the CHW's first name + a session date/time); an ineligible
member and a flag-off environment both send nothing and never raise; a Vonage
error is swallowed.

For each hook (create_request member ack, request-accept, session confirm,
session cancel, session reschedule/schedule): the endpoint fires the right
function once, and a failure inside the function never breaks the endpoint
(TESTING.md rule 3 — best-effort, never fail the parent transition).
"""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select

import app.config as _app_config_module
from app.models.user import MemberProfile, User
from app.services.sms_notifications import (
    _format_local_date,
    _format_local_datetime,
    send_request_received_sms,
    send_session_changed_sms,
    send_session_confirmed_sms,
)
from app.services.vonage_sms import SmsSendResult
from tests.conftest import auth_header
from tests.conftest import test_session as _test_session_factory

STOP_LINE = "Reply STOP to opt out."
SCHEDULED_AT = datetime(2026, 7, 20, 21, 0, tzinfo=UTC)

_FORBIDDEN_PHI_TERMS = (
    "housing", "food", "transportation", "utilities", "mental health",
    "diagnosis", "medication", "medical", "clinical", "medi-cal",
)


def _assert_no_phi(body: str) -> None:
    lowered = body.lower()
    for term in _FORBIDDEN_PHI_TERMS:
        assert term not in lowered, f"PHI term {term!r} leaked into SMS body: {body!r}"


# ─── Registration / setup helpers ────────────────────────────────────────────


async def _register(client: AsyncClient, email: str, role: str, name: str) -> dict:
    payload: dict = {
        "email": email,
        "password": "Testpass123!",
        "name": name,
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


async def _verify_member(user_id: str, phone: str) -> None:
    async with _test_session_factory() as session:
        user = await session.get(User, UUID(user_id))
        assert user is not None
        user.phone = phone
        user.phone_verified_at = datetime.now(UTC)
        await session.commit()


async def _load_member_and_profile(user_id: str, db) -> tuple[User, MemberProfile]:
    user = await db.get(User, UUID(user_id))
    profile = (
        await db.execute(
            select(MemberProfile).where(MemberProfile.user_id == UUID(user_id))
        )
    ).scalar_one()
    return user, profile


async def _establish_relationship(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> None:
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


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


# ─── Function tests: send_request_received_sms ───────────────────────────────


@pytest.mark.asyncio
async def test_request_received_eligible_sends_exact_body(client: AsyncClient):
    member_tokens = await _register(client, "conf_rr1@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)
    await _verify_member(member_id, "+15550500001")

    captured: list[tuple[str, str]] = []

    async def fake_send_text(self, to, text):
        captured.append((to, text))
        return SmsSendResult(success=True, provider_message_id="mid-rr")

    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send_text):
        async with _test_session_factory() as db:
            mu, mp = await _load_member_and_profile(member_id, db)
            await send_request_received_sms(
                db, member_user=mu, member_profile=mp, chw_first_name="Alex"
            )

    assert len(captured) == 1
    to, body = captured[0]
    assert to == "+15550500001"
    assert body.startswith(
        "Compass: We got your session request — Alex will confirm a time shortly."
    )
    assert body.endswith(STOP_LINE)  # first send in the 24h window
    _assert_no_phi(body)


@pytest.mark.asyncio
async def test_request_received_ineligible_member_is_silent(client: AsyncClient):
    # No phone verification → ineligible.
    member_tokens = await _register(client, "conf_rr2@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)

    fake_send = AsyncMock()
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send):
        async with _test_session_factory() as db:
            mu, mp = await _load_member_and_profile(member_id, db)
            await send_request_received_sms(
                db, member_user=mu, member_profile=mp, chw_first_name="Alex"
            )
    fake_send.assert_not_awaited()


@pytest.mark.asyncio
async def test_request_received_flag_off_is_silent(client: AsyncClient, monkeypatch):
    member_tokens = await _register(client, "conf_rr3@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)
    await _verify_member(member_id, "+15550500003")

    monkeypatch.setattr(_app_config_module.settings, "sms_mirroring_enabled", False)

    fake_send = AsyncMock()
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send):
        async with _test_session_factory() as db:
            mu, mp = await _load_member_and_profile(member_id, db)
            await send_request_received_sms(
                db, member_user=mu, member_profile=mp, chw_first_name="Alex"
            )
    fake_send.assert_not_awaited()


# ─── Function tests: send_session_confirmed_sms ──────────────────────────────


@pytest.mark.asyncio
async def test_session_confirmed_eligible_sends_exact_body(client: AsyncClient):
    member_tokens = await _register(client, "conf_sc1@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)
    await _verify_member(member_id, "+15550500011")

    captured: list[str] = []

    async def fake_send_text(self, to, text):
        captured.append(text)
        return SmsSendResult(success=True, provider_message_id="mid-sc")

    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send_text):
        async with _test_session_factory() as db:
            mu, mp = await _load_member_and_profile(member_id, db)
            await send_session_confirmed_sms(
                db,
                member_user=mu,
                member_profile=mp,
                chw_first_name="Alex",
                scheduled_at=SCHEDULED_AT,
            )

    assert len(captured) == 1
    body = captured[0]
    expected_when = _format_local_datetime(SCHEDULED_AT)
    assert body.startswith(
        f"Compass: Your session with Alex is confirmed for {expected_when}."
    )
    assert body.endswith(STOP_LINE)
    _assert_no_phi(body)


@pytest.mark.asyncio
async def test_session_confirmed_ineligible_member_is_silent(client: AsyncClient):
    member_tokens = await _register(client, "conf_sc2@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)

    fake_send = AsyncMock()
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send):
        async with _test_session_factory() as db:
            mu, mp = await _load_member_and_profile(member_id, db)
            await send_session_confirmed_sms(
                db,
                member_user=mu,
                member_profile=mp,
                chw_first_name="Alex",
                scheduled_at=SCHEDULED_AT,
            )
    fake_send.assert_not_awaited()


@pytest.mark.asyncio
async def test_session_confirmed_swallows_vonage_error(client: AsyncClient):
    """A Vonage failure (success=False) is best-effort — never raises."""
    member_tokens = await _register(client, "conf_sc3@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)
    await _verify_member(member_id, "+15550500013")

    failing = AsyncMock(
        return_value=SmsSendResult(success=False, error="vonage_500", status_code=500)
    )
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", failing):
        async with _test_session_factory() as db:
            mu, mp = await _load_member_and_profile(member_id, db)
            # Must not raise.
            await send_session_confirmed_sms(
                db,
                member_user=mu,
                member_profile=mp,
                chw_first_name="Alex",
                scheduled_at=SCHEDULED_AT,
            )
    failing.assert_awaited_once()


# ─── Function tests: send_session_changed_sms ────────────────────────────────


@pytest.mark.asyncio
async def test_session_cancelled_sends_exact_body(client: AsyncClient):
    member_tokens = await _register(client, "conf_ch1@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)
    await _verify_member(member_id, "+15550500021")

    captured: list[str] = []

    async def fake_send_text(self, to, text):
        captured.append(text)
        return SmsSendResult(success=True, provider_message_id="mid-ch")

    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send_text):
        async with _test_session_factory() as db:
            mu, mp = await _load_member_and_profile(member_id, db)
            await send_session_changed_sms(
                db,
                member_user=mu,
                member_profile=mp,
                old_scheduled_at=SCHEDULED_AT,
                new_scheduled_at=None,
                cancelled=True,
            )

    assert len(captured) == 1
    body = captured[0]
    expected_date = _format_local_date(SCHEDULED_AT)
    assert body.startswith(f"Compass: Your {expected_date} session was cancelled.")
    _assert_no_phi(body)


@pytest.mark.asyncio
async def test_session_rescheduled_sends_exact_body(client: AsyncClient):
    member_tokens = await _register(client, "conf_ch2@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)
    await _verify_member(member_id, "+15550500022")

    captured: list[str] = []

    async def fake_send_text(self, to, text):
        captured.append(text)
        return SmsSendResult(success=True, provider_message_id="mid-ch2")

    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send_text):
        async with _test_session_factory() as db:
            mu, mp = await _load_member_and_profile(member_id, db)
            await send_session_changed_sms(
                db,
                member_user=mu,
                member_profile=mp,
                old_scheduled_at=None,
                new_scheduled_at=SCHEDULED_AT,
                cancelled=False,
            )

    assert len(captured) == 1
    body = captured[0]
    expected_when = _format_local_datetime(SCHEDULED_AT)
    assert body.startswith(f"Compass: Your session moved to {expected_when}.")
    _assert_no_phi(body)


@pytest.mark.asyncio
async def test_session_changed_ineligible_member_is_silent(client: AsyncClient):
    member_tokens = await _register(client, "conf_ch3@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)

    fake_send = AsyncMock()
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send):
        async with _test_session_factory() as db:
            mu, mp = await _load_member_and_profile(member_id, db)
            await send_session_changed_sms(
                db,
                member_user=mu,
                member_profile=mp,
                old_scheduled_at=SCHEDULED_AT,
                new_scheduled_at=None,
                cancelled=True,
            )
    fake_send.assert_not_awaited()


# ─── Hook tests: each endpoint fires the right function, failure never breaks ─


@pytest.mark.asyncio
async def test_create_request_fires_request_received_sms(client: AsyncClient):
    chw_tokens = await _register(client, "hook_rr_chw@test.com", "chw", "Alex Stone")
    member_tokens = await _register(client, "hook_rr_member@test.com", "member", "Jamie Rivera")
    chw_id = _user_id_from_tokens(chw_tokens)

    mock = AsyncMock()
    with patch("app.services.sms_notifications.send_request_received_sms", mock):
        res = await client.post(
            "/api/v1/requests/",
            json={
                "vertical": "housing",
                "urgency": "routine",
                "description": "Targeted request",
                "preferred_mode": "in_person",
                "target_chw_id": chw_id,
            },
            headers=auth_header(member_tokens),
        )
    assert res.status_code == 201, res.text
    mock.assert_awaited_once()
    assert mock.await_args.kwargs["chw_first_name"] == "Alex"


@pytest.mark.asyncio
async def test_create_request_hook_failure_does_not_break_endpoint(client: AsyncClient):
    member_tokens = await _register(client, "hook_rr2_member@test.com", "member", "Jamie Rivera")

    with patch(
        "app.services.sms_notifications.send_request_received_sms",
        AsyncMock(side_effect=RuntimeError("boom")),
    ):
        res = await client.post(
            "/api/v1/requests/",
            json={
                "vertical": "housing",
                "urgency": "routine",
                "description": "Untargeted request",
                "preferred_mode": "in_person",
            },
            headers=auth_header(member_tokens),
        )
    assert res.status_code == 201, res.text


@pytest.mark.asyncio
async def test_accept_request_fires_session_confirmed_sms(client: AsyncClient):
    chw_tokens = await _register(client, "hook_ac_chw@test.com", "chw", "Alex Stone")
    member_tokens = await _register(client, "hook_ac_member@test.com", "member", "Jamie Rivera")

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

    mock = AsyncMock()
    with patch("app.services.sms_notifications.send_session_confirmed_sms", mock):
        res = await client.patch(
            f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
        )
    assert res.status_code == 200, res.text
    mock.assert_awaited_once()
    assert mock.await_args.kwargs["chw_first_name"] == "Alex"


@pytest.mark.asyncio
async def test_accept_request_hook_failure_does_not_break_endpoint(client: AsyncClient):
    chw_tokens = await _register(client, "hook_ac2_chw@test.com", "chw", "Alex Stone")
    member_tokens = await _register(client, "hook_ac2_member@test.com", "member", "Jamie Rivera")

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
    request_id = res.json()["id"]

    with patch(
        "app.services.sms_notifications.send_session_confirmed_sms",
        AsyncMock(side_effect=RuntimeError("boom")),
    ):
        res = await client.patch(
            f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
        )
    assert res.status_code == 200, res.text


@pytest.mark.asyncio
async def test_confirm_session_fires_session_confirmed_sms(client: AsyncClient):
    chw_tokens = await _register(client, "hook_cf_chw@test.com", "chw", "Alex Stone")
    member_tokens = await _register(client, "hook_cf_member@test.com", "member", "Jamie Rivera")
    chw_id = _user_id_from_tokens(chw_tokens)
    await _establish_relationship(client, member_tokens, chw_tokens)

    # Member proposes a time → pending, proposed_by='member' → a CHW may confirm.
    res = await client.post(
        "/api/v1/sessions/schedule",
        json={"chw_id": chw_id, "scheduled_at": _iso(SCHEDULED_AT), "mode": "phone"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    session_id = res.json()["id"]

    mock = AsyncMock()
    with patch("app.services.sms_notifications.send_session_confirmed_sms", mock):
        res = await client.patch(
            f"/api/v1/sessions/{session_id}/confirm", headers=auth_header(chw_tokens)
        )
    assert res.status_code == 200, res.text
    mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_confirm_session_hook_failure_does_not_break_endpoint(client: AsyncClient):
    chw_tokens = await _register(client, "hook_cf2_chw@test.com", "chw", "Alex Stone")
    member_tokens = await _register(client, "hook_cf2_member@test.com", "member", "Jamie Rivera")
    chw_id = _user_id_from_tokens(chw_tokens)
    await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.post(
        "/api/v1/sessions/schedule",
        json={"chw_id": chw_id, "scheduled_at": _iso(SCHEDULED_AT), "mode": "phone"},
        headers=auth_header(member_tokens),
    )
    session_id = res.json()["id"]

    with patch(
        "app.services.sms_notifications.send_session_confirmed_sms",
        AsyncMock(side_effect=RuntimeError("boom")),
    ):
        res = await client.patch(
            f"/api/v1/sessions/{session_id}/confirm", headers=auth_header(chw_tokens)
        )
    assert res.status_code == 200, res.text


@pytest.mark.asyncio
async def test_cancel_session_fires_session_changed_sms(client: AsyncClient):
    chw_tokens = await _register(client, "hook_cn_chw@test.com", "chw", "Alex Stone")
    member_tokens = await _register(client, "hook_cn_member@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)
    await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.post(
        "/api/v1/sessions/schedule",
        json={"member_id": member_id, "scheduled_at": _iso(SCHEDULED_AT), "mode": "phone"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    session_id = res.json()["id"]

    mock = AsyncMock()
    with patch("app.services.sms_notifications.send_session_changed_sms", mock):
        res = await client.patch(
            f"/api/v1/sessions/{session_id}/cancel", headers=auth_header(chw_tokens)
        )
    assert res.status_code == 200, res.text
    mock.assert_awaited_once()
    assert mock.await_args.kwargs["cancelled"] is True


@pytest.mark.asyncio
async def test_cancel_session_hook_failure_does_not_break_endpoint(client: AsyncClient):
    chw_tokens = await _register(client, "hook_cn2_chw@test.com", "chw", "Alex Stone")
    member_tokens = await _register(client, "hook_cn2_member@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)
    await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.post(
        "/api/v1/sessions/schedule",
        json={"member_id": member_id, "scheduled_at": _iso(SCHEDULED_AT), "mode": "phone"},
        headers=auth_header(chw_tokens),
    )
    session_id = res.json()["id"]

    with patch(
        "app.services.sms_notifications.send_session_changed_sms",
        AsyncMock(side_effect=RuntimeError("boom")),
    ):
        res = await client.patch(
            f"/api/v1/sessions/{session_id}/cancel", headers=auth_header(chw_tokens)
        )
    assert res.status_code == 200, res.text


@pytest.mark.asyncio
async def test_schedule_session_fires_session_changed_sms_reschedule(client: AsyncClient):
    chw_tokens = await _register(client, "hook_sc_chw@test.com", "chw", "Alex Stone")
    member_tokens = await _register(client, "hook_sc_member@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)
    await _establish_relationship(client, member_tokens, chw_tokens)

    mock = AsyncMock()
    with patch("app.services.sms_notifications.send_session_changed_sms", mock):
        res = await client.post(
            "/api/v1/sessions/schedule",
            json={"member_id": member_id, "scheduled_at": _iso(SCHEDULED_AT), "mode": "phone"},
            headers=auth_header(chw_tokens),
        )
    assert res.status_code == 201, res.text
    mock.assert_awaited_once()
    assert mock.await_args.kwargs["cancelled"] is False


@pytest.mark.asyncio
async def test_schedule_session_hook_failure_does_not_break_endpoint(client: AsyncClient):
    chw_tokens = await _register(client, "hook_sc2_chw@test.com", "chw", "Alex Stone")
    member_tokens = await _register(client, "hook_sc2_member@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)
    await _establish_relationship(client, member_tokens, chw_tokens)

    with patch(
        "app.services.sms_notifications.send_session_changed_sms",
        AsyncMock(side_effect=RuntimeError("boom")),
    ):
        res = await client.post(
            "/api/v1/sessions/schedule",
            json={"member_id": member_id, "scheduled_at": _iso(SCHEDULED_AT), "mode": "phone"},
            headers=auth_header(chw_tokens),
        )
    assert res.status_code == 201, res.text


@pytest.mark.asyncio
async def test_member_schedule_does_not_fire_changed_sms(client: AsyncClient):
    """A member scheduling their own session is the member's action — no
    self-text; the schedule hook is gated to CHW callers only."""
    chw_tokens = await _register(client, "hook_ms_chw@test.com", "chw", "Alex Stone")
    member_tokens = await _register(client, "hook_ms_member@test.com", "member", "Jamie Rivera")
    chw_id = _user_id_from_tokens(chw_tokens)
    await _establish_relationship(client, member_tokens, chw_tokens)

    mock = AsyncMock()
    with patch("app.services.sms_notifications.send_session_changed_sms", mock):
        res = await client.post(
            "/api/v1/sessions/schedule",
            json={"chw_id": chw_id, "scheduled_at": _iso(SCHEDULED_AT), "mode": "phone"},
            headers=auth_header(member_tokens),
        )
    assert res.status_code == 201, res.text
    mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_untargeted_request_uses_your_chw_fallback(client: AsyncClient):
    """An untargeted request has no assigned CHW — the ack copy falls back to
    'your CHW'. Exercises the fallback branch of the create_request hook."""
    member_tokens = await _register(client, "hook_ut_member@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)
    await _verify_member(member_id, "+15550500099")

    captured: list[str] = []

    async def fake_send_text(self, to, text):
        captured.append(text)
        return SmsSendResult(success=True, provider_message_id="mid-ut")

    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", fake_send_text):
        res = await client.post(
            "/api/v1/requests/",
            json={
                "vertical": "housing",
                "urgency": "routine",
                "description": "Open pool request",
                "preferred_mode": "in_person",
            },
            headers=auth_header(member_tokens),
        )
    assert res.status_code == 201, res.text
    assert len(captured) == 1
    assert "your CHW will confirm a time shortly" in captured[0]
    _assert_no_phi(captured[0])


# ─── Defensive-branch coverage (diff-cover gate — exception branches) ─────────


def test_format_helpers_fall_back_when_scheduled_at_is_none():
    assert _format_local_datetime(None) == "the scheduled time"
    assert _format_local_date(None) == "recent"


@pytest.mark.asyncio
async def test_confirmation_commit_and_rollback_failures_are_swallowed(
    client: AsyncClient,
):
    """The stamp-persisting commit raising AND the follow-up rollback raising
    must both be swallowed — the confirmation is best-effort to the end."""
    member_tokens = await _register(client, "conf_rb@test.com", "member", "Jamie Rivera")
    member_id = _user_id_from_tokens(member_tokens)
    await _verify_member(member_id, "+15550500077")

    ok_send = AsyncMock(
        return_value=SmsSendResult(success=True, provider_message_id="mid-rb")
    )
    with patch("app.services.vonage_sms.VonageSmsMessagesClient.send_text", ok_send):
        async with _test_session_factory() as db:
            mu, mp = await _load_member_and_profile(member_id, db)
            with (
                patch.object(db, "commit", AsyncMock(side_effect=RuntimeError("commit boom"))),
                patch.object(db, "rollback", AsyncMock(side_effect=RuntimeError("rollback boom"))),
            ):
                # Must not raise despite both failures.
                await send_request_received_sms(
                    db, member_user=mu, member_profile=mp, chw_first_name="Alex"
                )
    ok_send.assert_awaited_once()
