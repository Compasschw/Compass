"""Tests for push notifications fired on session confirm/decline.

Coverage:
  - CHW confirms a member's pending session → the MEMBER gets a push
    notification with the "session approved" payload (title/body/deeplink/
    category), and the CHW does NOT get one.
  - CHW declines a member's pending session → no push notification fires.

`notify_user` is imported locally inside `confirm_session` (mirrors the
existing pattern in routers/requests.py), so we patch it at its source —
`app.services.notifications.notify_user` — rather than the router module.
"""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from httpx import AsyncClient

from app.routers.sessions import _scheduled_at_label
from tests.conftest import auth_header

# Matches the scheduled_at used in `_member_pending_session_id` below —
# kept as a module constant so the expected notification body can be
# derived from the same `_scheduled_at_label` the endpoint uses (locking the
# push body format to the in-thread confirmation message's format).
_SCHEDULED_AT = datetime(2026, 8, 3, 17, 0, 0, tzinfo=UTC)


def _member_id(tokens: dict) -> str:
    payload_b64 = tokens["access_token"].split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    return str(UUID(json.loads(base64.urlsafe_b64decode(padded).decode())["sub"]))


async def _establish_relationship(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> str:
    """Member files a request, CHW accepts it → care relationship. Returns member_id."""
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


async def _member_pending_session_id(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> str:
    """Establish a relationship, member schedules → returns the pending session id."""
    await _establish_relationship(client, member_tokens, chw_tokens)
    chw_id = _member_id(chw_tokens)
    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "chw_id": chw_id,
            "scheduled_at": _SCHEDULED_AT.isoformat().replace("+00:00", "Z"),
            "mode": "phone",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["scheduling_status"] == "pending"
    return res.json()["id"]


@pytest.mark.asyncio
async def test_confirm_session_notifies_member_with_approval_payload(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _member_pending_session_id(client, member_tokens, chw_tokens)
    member_id = _member_id(member_tokens)
    chw_id = _member_id(chw_tokens)

    with patch(
        "app.services.notifications.notify_user", new_callable=AsyncMock
    ) as mock_notify:
        res = await client.patch(
            f"/api/v1/sessions/{sid}/confirm", headers=auth_header(chw_tokens)
        )
    assert res.status_code == 200, res.text
    assert res.json()["scheduling_status"] == "confirmed"

    # Exactly one push fired, and it went to the MEMBER — not the CHW.
    mock_notify.assert_called_once()
    _db_arg, notified_user_id, payload = mock_notify.call_args.args
    assert str(notified_user_id) == member_id
    assert str(notified_user_id) != chw_id

    assert payload.title == "Session approved"
    # The push body reuses `_scheduled_at_label` — the exact same formatter
    # that builds the "✅ Session confirmed for {label}." in-thread message —
    # so the push and the thread message read consistently.
    expected_label = _scheduled_at_label(SimpleNamespace(scheduled_at=_SCHEDULED_AT))
    assert payload.body == f"Your session was approved for {expected_label}."
    assert payload.deeplink == f"compasschw://sessions/{sid}"
    assert payload.category == "session.confirmed"
    assert payload.data == {"session_id": sid}


@pytest.mark.asyncio
async def test_confirm_session_succeeds_even_if_notification_delivery_fails(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A push-delivery failure is best-effort and must never fail the confirm
    action itself (mirrors the accept-request notification pattern in
    routers/requests.py — see the `try/except` around `notify_user`)."""
    sid = await _member_pending_session_id(client, member_tokens, chw_tokens)

    with patch(
        "app.services.notifications.notify_user",
        new_callable=AsyncMock,
        side_effect=RuntimeError("Expo push provider unreachable"),
    ) as mock_notify:
        res = await client.patch(
            f"/api/v1/sessions/{sid}/confirm", headers=auth_header(chw_tokens)
        )
    mock_notify.assert_called_once()
    assert res.status_code == 200, res.text
    assert res.json()["scheduling_status"] == "confirmed"
    assert res.json()["status"] == "scheduled"


@pytest.mark.asyncio
async def test_decline_session_does_not_notify(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _member_pending_session_id(client, member_tokens, chw_tokens)

    with patch(
        "app.services.notifications.notify_user", new_callable=AsyncMock
    ) as mock_notify:
        res = await client.patch(
            f"/api/v1/sessions/{sid}/decline", headers=auth_header(chw_tokens)
        )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"

    mock_notify.assert_not_called()
