"""Phase 1B test additions — accept side-effects + Vonage IVR consent."""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from tests.conftest import auth_header
from tests.conftest import test_session as _test_session_factory


# ─── Accept-side-effects: calendar events ────────────────────────────────────


@pytest.mark.asyncio
async def test_accept_request_creates_calendar_events_for_both_parties(
    client: AsyncClient, member_tokens, chw_tokens
):
    """When a CHW accepts, BOTH the CHW and the member must get a calendar
    row so each side's "Upcoming Session" widget renders without a join."""
    from app.models.calendar import CalendarEvent

    # Member submits a request
    create_res = await client.post(
        "/api/v1/requests/",
        headers=auth_header(member_tokens),
        json={
            "vertical": "food",
            "urgency": "soon",
            "description": "Need help applying for CalFresh",
            "preferred_mode": "phone",
            "estimated_units": 2,
        },
    )
    assert create_res.status_code == 201, create_res.text
    request_id = create_res.json()["id"]

    # CHW accepts
    accept_res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert accept_res.status_code == 200
    body = accept_res.json()
    session_id = uuid.UUID(body["session_id"])

    # Two calendar events should have been written: one per party.
    async with _test_session_factory() as db:
        result = await db.execute(
            select(CalendarEvent).where(CalendarEvent.session_id == session_id)
        )
        events = list(result.scalars().all())
        assert len(events) == 2, f"Expected 2 calendar events, got {len(events)}"

        user_ids = {e.user_id for e in events}
        # No user_id repeats — one for CHW, one for member
        assert len(user_ids) == 2

        # Both events have a non-null date (not '0000-00-00')
        for ev in events:
            assert ev.date is not None
            assert ev.start_time is not None
            assert ev.title.startswith("Session with ")
            assert ev.event_type == "session"


@pytest.mark.asyncio
async def test_accept_request_still_returns_session_id_when_email_fails(
    client: AsyncClient, member_tokens, chw_tokens, monkeypatch
):
    """Email send failures must NOT fail the accept transaction."""
    # Force the email helper to raise
    async def boom(*args, **kwargs):
        raise RuntimeError("SES outage simulated")

    import app.services.email as email_module
    monkeypatch.setattr(email_module, "send_request_accepted_email", boom)

    create_res = await client.post(
        "/api/v1/requests/",
        headers=auth_header(member_tokens),
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Eviction-prevention support",
            "preferred_mode": "virtual",
            "estimated_units": 1,
        },
    )
    request_id = create_res.json()["id"]

    accept_res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert accept_res.status_code == 200
    assert "session_id" in accept_res.json()


# ─── Vonage IVR consent gate ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_voice_answer_returns_consent_aware_ncco(client: AsyncClient):
    """The /voice/answer endpoint must NOT include a top-level record action.
    Recording is only allowed AFTER the member presses 1 in the IVR.
    """
    res = await client.post(
        "/api/v1/communication/voice/answer?session=test&member=15551234567",
        json={},
    )
    assert res.status_code == 200
    ncco = res.json()
    assert isinstance(ncco, list)

    # No top-level record action — consent must be captured first
    actions = [item.get("action") for item in ncco]
    assert "record" not in actions, (
        "voice/answer NCCO must not record before consent IVR runs"
    )

    # The member-leg onAnswer must point at the consent-prompt webhook
    connect = next((item for item in ncco if item.get("action") == "connect"), None)
    assert connect is not None, "Expected a connect action in voice/answer NCCO"
    endpoint = (connect.get("endpoint") or [{}])[0]
    on_answer_url = (endpoint.get("onAnswer") or {}).get("url", "")
    assert "/voice/consent-prompt" in on_answer_url


@pytest.mark.asyncio
async def test_voice_consent_result_records_audio_only_when_dtmf_is_one(
    client: AsyncClient,
):
    """DTMF "1" → record + bridge. Anything else → polite hangup, no record."""
    # Decline path (no DTMF)
    res = await client.post(
        "/api/v1/communication/voice/consent-result?session=11111111-1111-1111-1111-111111111111",
        json={"dtmf": ""},
    )
    assert res.status_code == 200
    ncco = res.json()
    actions = [item.get("action") for item in ncco]
    assert "record" not in actions, "Decline path must never record"

    # Wrong digit path
    res = await client.post(
        "/api/v1/communication/voice/consent-result?session=22222222-2222-2222-2222-222222222222",
        json={"dtmf": {"digits": "9"}},
    )
    assert res.status_code == 200
    actions = [item.get("action") for item in res.json()]
    assert "record" not in actions
