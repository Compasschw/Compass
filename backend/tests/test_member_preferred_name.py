"""Tests for PATCH /api/v1/chw/members/{member_id}/preferred-name.

Coverage:
  - A CHW with an active care relationship can set the preferred name; a
    follow-up GET /chw/members/{id} reflects it.
  - A blank/whitespace value clears the preferred name (-> null).
  - A CHW with no relationship is denied (403).

Mirrors tests/test_chw_member_profile.py for relationship setup + auth.
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
async def test_chw_can_set_preferred_name(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/preferred-name",
        json={"preferred_name": "  Rosie  "},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["preferred_name"] == "Rosie"  # trimmed

    # The full member profile reflects it.
    res = await client.get(
        f"/api/v1/chw/members/{member_id}",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["preferred_name"] == "Rosie"


@pytest.mark.asyncio
async def test_blank_clears_preferred_name(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    await client.patch(
        f"/api/v1/chw/members/{member_id}/preferred-name",
        json={"preferred_name": "Rosie"},
        headers=auth_header(chw_tokens),
    )
    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/preferred-name",
        json={"preferred_name": "   "},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["preferred_name"] is None


@pytest.mark.asyncio
async def test_unrelated_chw_denied(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    # No request/accept -> no relationship.
    member_id = _member_id(member_tokens)
    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/preferred-name",
        json={"preferred_name": "Rosie"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 403
