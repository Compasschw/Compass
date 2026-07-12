"""Tests for the scheduler's session-reminder jobs.

Covers three jobs in app/services/scheduler.py:
  - send_session_reminders            (existing 15-min job — regression only)
  - send_day_before_session_reminders (new — ~24h-before, MEMBER only)
  - send_hour_before_session_reminders(new — ~1h-before, MEMBER only)

All three accept an optional `now` so tests can pin the reference time
instead of racing the wall clock, then seed sessions at controlled offsets
from that same reference. Each test exercises: an in-window session fires,
sessions outside the window are skipped, a cancelled (non-"scheduled")
session in-window is skipped, and calling the job twice for the same window
only notifies once (dedup via the module-level `_reminded_sessions` set).
"""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from httpx import AsyncClient

from app.services import scheduler
from app.services.availability import to_clinic_local
from tests.conftest import auth_header

REFERENCE_NOW = datetime(2026, 7, 15, 12, 0, 0, tzinfo=UTC)


def _member_id(tokens: dict) -> str:
    payload_b64 = tokens["access_token"].split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    return str(UUID(json.loads(base64.urlsafe_b64decode(padded).decode())["sub"]))


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


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
    return _member_id(member_tokens)


async def _schedule(
    client: AsyncClient, chw_tokens: dict, member_id: str, scheduled_at: datetime
) -> str:
    """CHW directly schedules a confirmed session with the related member."""
    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": member_id,
            "scheduled_at": _iso(scheduled_at),
            "mode": "phone",
            "scheduling_status": "confirmed",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["status"] == "scheduled"
    return res.json()["id"]


def _notified_session_ids(mock_notify: AsyncMock) -> set[str]:
    return {c.args[2].data["session_id"] for c in mock_notify.call_args_list}


@pytest.fixture(autouse=True)
def _reset_reminder_dedup_cache():
    """The dedup set is module-level (survives across tests in-process);
    each test needs a clean slate since the DB (and session IDs) reset too."""
    scheduler._reminded_sessions.clear()
    yield
    scheduler._reminded_sessions.clear()


# ─── Day-before reminder (~24h) ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_day_before_reminder_windows_status_and_dedup(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    in_window_at = REFERENCE_NOW + timedelta(hours=24)
    in_window_id = await _schedule(client, chw_tokens, member_id, in_window_at)
    too_soon_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(hours=20)
    )
    too_far_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(hours=30)
    )
    cancelled_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(hours=24, minutes=5)
    )
    res = await client.patch(
        f"/api/v1/sessions/{cancelled_id}/cancel", headers=auth_header(member_tokens)
    )
    assert res.status_code == 200, res.text

    with patch(
        "app.services.notifications.notify_user", new_callable=AsyncMock
    ) as mock_notify:
        await scheduler.send_day_before_session_reminders(now=REFERENCE_NOW)

    notified = _notified_session_ids(mock_notify)
    assert notified == {in_window_id}
    assert too_soon_id not in notified
    assert too_far_id not in notified
    assert cancelled_id not in notified

    # Only the member is notified (not the CHW).
    _db_arg, notified_user_id, payload = mock_notify.call_args.args
    assert str(notified_user_id) == member_id
    assert "tomorrow" in payload.body.lower()
    # The embedded time is rendered via the same clinic-local conversion
    # (`to_clinic_local` / CLINIC_TZ_NAME) the confirm-approval push and the
    # in-thread scheduling message use — locks the reminder body format to
    # that single source of truth rather than an independently-computed one.
    expected_time = to_clinic_local(in_window_at).strftime("%I:%M %p").lstrip("0")
    assert expected_time in payload.body

    # Dedup: calling again for the same window does not re-notify.
    with patch(
        "app.services.notifications.notify_user", new_callable=AsyncMock
    ) as mock_notify_again:
        await scheduler.send_day_before_session_reminders(now=REFERENCE_NOW)
    mock_notify_again.assert_not_called()


# ─── Hour-before reminder (~1h) ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_hour_before_reminder_windows_status_and_dedup(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    in_window_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(minutes=60)
    )
    too_soon_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(minutes=30)
    )
    too_far_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(minutes=90)
    )
    cancelled_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(minutes=60)
    )
    res = await client.patch(
        f"/api/v1/sessions/{cancelled_id}/cancel", headers=auth_header(member_tokens)
    )
    assert res.status_code == 200, res.text

    with patch(
        "app.services.notifications.notify_user", new_callable=AsyncMock
    ) as mock_notify:
        await scheduler.send_hour_before_session_reminders(now=REFERENCE_NOW)

    notified = _notified_session_ids(mock_notify)
    assert notified == {in_window_id}
    assert too_soon_id not in notified
    assert too_far_id not in notified
    assert cancelled_id not in notified

    _db_arg, notified_user_id, payload = mock_notify.call_args.args
    assert str(notified_user_id) == member_id
    assert "1 hour" in payload.body.lower()

    with patch(
        "app.services.notifications.notify_user", new_callable=AsyncMock
    ) as mock_notify_again:
        await scheduler.send_hour_before_session_reminders(now=REFERENCE_NOW)
    mock_notify_again.assert_not_called()


# ─── Existing 15-minute reminder — regression only ─────────────────────────


@pytest.mark.asyncio
async def test_fifteen_minute_reminder_still_notifies_both_parties_once(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Guards the pre-existing job: must still fire to BOTH member and CHW for
    an in-window session, skip out-of-window/cancelled sessions, and dedup."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    chw_id = _member_id(chw_tokens)

    in_window_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(minutes=15)
    )
    too_soon_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(minutes=10)
    )
    too_far_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(minutes=20)
    )
    cancelled_id = await _schedule(
        client, chw_tokens, member_id, REFERENCE_NOW + timedelta(minutes=15)
    )
    res = await client.patch(
        f"/api/v1/sessions/{cancelled_id}/cancel", headers=auth_header(member_tokens)
    )
    assert res.status_code == 200, res.text

    with patch(
        "app.services.notifications.notify_user", new_callable=AsyncMock
    ) as mock_notify:
        await scheduler.send_session_reminders(now=REFERENCE_NOW)

    notified = _notified_session_ids(mock_notify)
    assert notified == {in_window_id}
    assert too_soon_id not in notified
    assert too_far_id not in notified
    assert cancelled_id not in notified

    notified_user_ids = {str(c.args[1]) for c in mock_notify.call_args_list}
    assert notified_user_ids == {member_id, chw_id}
    assert mock_notify.call_count == 2  # one per party, once each

    with patch(
        "app.services.notifications.notify_user", new_callable=AsyncMock
    ) as mock_notify_again:
        await scheduler.send_session_reminders(now=REFERENCE_NOW)
    mock_notify_again.assert_not_called()


# ─── Delivery-failure resilience — a push failure must never crash a job ──


@pytest.mark.asyncio
async def test_day_before_reminder_survives_notification_failure(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _schedule(client, chw_tokens, member_id, REFERENCE_NOW + timedelta(hours=24))

    with patch(
        "app.services.notifications.notify_user",
        new_callable=AsyncMock,
        side_effect=RuntimeError("Expo push provider unreachable"),
    ) as mock_notify:
        await scheduler.send_day_before_session_reminders(now=REFERENCE_NOW)  # must not raise

    mock_notify.assert_called_once()


@pytest.mark.asyncio
async def test_hour_before_reminder_survives_notification_failure(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    await _schedule(client, chw_tokens, member_id, REFERENCE_NOW + timedelta(minutes=60))

    with patch(
        "app.services.notifications.notify_user",
        new_callable=AsyncMock,
        side_effect=RuntimeError("Expo push provider unreachable"),
    ) as mock_notify:
        await scheduler.send_hour_before_session_reminders(now=REFERENCE_NOW)  # must not raise

    mock_notify.assert_called_once()


# ─── Default `now` (real wall-clock) fallback ──────────────────────────────


@pytest.mark.asyncio
async def test_reminder_jobs_default_now_to_wall_clock_when_omitted(setup_db):
    """Calling the jobs with no `now` (as the real APScheduler cadence does)
    exercises the `now = datetime.now(UTC)` fallback branch. No sessions are
    seeded, so this just proves the jobs run cleanly against real time."""
    with patch(
        "app.services.notifications.notify_user", new_callable=AsyncMock
    ) as mock_notify:
        await scheduler.send_session_reminders()
        await scheduler.send_day_before_session_reminders()
        await scheduler.send_hour_before_session_reminders()
    mock_notify.assert_not_called()


def test_format_local_time_falls_back_when_scheduled_at_missing():
    assert scheduler._format_local_time(None) == "the scheduled time"


# ─── start_scheduler wiring ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_start_scheduler_registers_day_and_hour_before_reminder_jobs(setup_db):
    """The two new jobs are wired into the live APScheduler instance with the
    documented cadence, alongside the pre-existing 15-minute job. Run inside
    an async test so AsyncIOScheduler has a running event loop to attach to,
    matching how `start_scheduler()` is actually invoked from the FastAPI
    lifespan in `main.py`."""
    scheduler.stop_scheduler()  # idempotent — ensures a clean slate
    try:
        scheduler.start_scheduler()
        status = scheduler.scheduler_status()
        job_ids = {job["id"] for job in status["jobs"]}
        assert {"session_reminders", "session_reminders_1d", "session_reminders_1h"} <= job_ids

        jobs_by_id = {job.id: job for job in scheduler._scheduler.get_jobs()}
        assert jobs_by_id["session_reminders_1d"].trigger.interval == timedelta(minutes=30)
        assert jobs_by_id["session_reminders_1h"].trigger.interval == timedelta(minutes=2)
    finally:
        scheduler.stop_scheduler()
