"""Tests for the member close/reopen endpoints.

  POST /api/v1/chw/members/{member_id}/close   → set disposition + reason
  POST /api/v1/chw/members/{member_id}/reopen  → clear disposition

Coverage:
  - A CHW with an active relationship can close a member; the member detail
    reflects closure_status / closure_reason / closed_at.
  - Reopen clears the disposition back to null, and the detail reflects it.
  - Close is idempotent — re-closing overwrites the disposition.
  - Invalid status / reason slugs are rejected (422).
  - A CHW with no relationship is denied (403) for both close and reopen.

Mirrors tests/test_member_preferred_name.py for relationship setup + auth.
"""

from __future__ import annotations

import base64
import json
from uuid import UUID

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


def _member_id(tokens: dict) -> str:
    payload_b64 = tokens["access_token"].split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    return str(UUID(json.loads(base64.urlsafe_b64decode(padded).decode())["sub"]))


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
    assert res.status_code == 201
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    return _member_id(member_tokens)


@pytest.mark.asyncio
async def test_chw_can_close_member(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.post(
        f"/api/v1/chw/members/{member_id}/close",
        json={"status": "closed_successful", "reason": "successfully_completed"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["closure_status"] == "closed_successful"
    assert body["closure_reason"] == "successfully_completed"
    assert body["closed_at"] is not None

    # The full member profile reflects the closure.
    res = await client.get(
        f"/api/v1/chw/members/{member_id}",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    detail = res.json()
    assert detail["closure_status"] == "closed_successful"
    assert detail["closure_reason"] == "successfully_completed"
    assert detail["closed_at"] is not None


@pytest.mark.asyncio
async def test_reopen_clears_closure(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    await client.post(
        f"/api/v1/chw/members/{member_id}/close",
        json={"status": "declined", "reason": "declined_all_services"},
        headers=auth_header(chw_tokens),
    )
    res = await client.post(
        f"/api/v1/chw/members/{member_id}/reopen",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["closure_status"] is None
    assert body["closure_reason"] is None
    assert body["closed_at"] is None

    # Detail shows the member active again.
    res = await client.get(
        f"/api/v1/chw/members/{member_id}",
        headers=auth_header(chw_tokens),
    )
    assert res.json()["closure_status"] is None


@pytest.mark.asyncio
async def test_close_is_idempotent_overwrites_disposition(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    await client.post(
        f"/api/v1/chw/members/{member_id}/close",
        json={"status": "declined", "reason": "not_eligible"},
        headers=auth_header(chw_tokens),
    )
    # Re-close with a different disposition — should overwrite, not error.
    res = await client.post(
        f"/api/v1/chw/members/{member_id}/close",
        json={"status": "closed_unsuccessful", "reason": "lost_to_follow_up"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["closure_status"] == "closed_unsuccessful"
    assert res.json()["closure_reason"] == "lost_to_follow_up"


@pytest.mark.asyncio
async def test_invalid_status_rejected(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    res = await client.post(
        f"/api/v1/chw/members/{member_id}/close",
        json={"status": "archived", "reason": "successfully_completed"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_invalid_reason_rejected(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    res = await client.post(
        f"/api/v1/chw/members/{member_id}/close",
        json={"status": "declined", "reason": "changed_their_mind"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_unrelated_chw_cannot_close(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    # No request/accept -> no relationship.
    member_id = _member_id(member_tokens)
    res = await client.post(
        f"/api/v1/chw/members/{member_id}/close",
        json={"status": "declined", "reason": "other"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 403, res.text


@pytest.mark.asyncio
async def test_unrelated_chw_cannot_reopen(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    member_id = _member_id(member_tokens)
    res = await client.post(
        f"/api/v1/chw/members/{member_id}/reopen",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 403, res.text
