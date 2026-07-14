"""Integration tests for the member billing-status (billable/non-billable) toggle.

Coverage:
  - Default is_billable is True for a new member.
  - A CHW with an active care relationship can read and flip the toggle;
    the audit fields (changed_at / changed_by) are stamped.
  - A CHW WITHOUT a relationship is denied (403) on both read and write.
  - The member can read their own status but CANNOT change it (403).

Uses the shared conftest fixtures (client, chw_tokens, member_tokens, setup_db)
and the request->accept->session flow to establish the CHW<->member relationship,
mirroring tests/test_case_notes.py.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


async def _establish_relationship(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> str:
    """Create request -> accept -> session so CHW+member share a session.

    Returns the member's User id.
    """
    profile_res = await client.get(
        "/api/v1/member/profile", headers=auth_header(member_tokens)
    )
    assert profile_res.status_code == 200
    member_id = profile_res.json()["user_id"]

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

    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-06-10T10:00:00Z",
            "mode": "in_person",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201

    return member_id


async def _register(client: AsyncClient, email: str, role: str) -> dict:
    payload: dict = {
        "email": email,
        "password": "Testpass123!",
        "name": f"Test {role}",
        "role": role,
    }
    if role == "member":
        payload.update({
            "date_of_birth": "1990-01-01",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
            "zip_code": "90001",
            "terms_accepted": True,
            "communications_consent": True,
        })
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


@pytest.mark.asyncio
async def test_default_is_billable_true(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    """A newly registered member defaults to billable."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.get(
        f"/api/v1/members/{member_id}/billing-status",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["is_billable"] is True
    assert body["changed_at"] is None
    assert body["changed_by"] is None


@pytest.mark.asyncio
async def test_chw_can_toggle_non_billable(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    """A relationship-bearing CHW flips the member to non-billable; audit stamped."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.patch(
        f"/api/v1/members/{member_id}/billing-status",
        json={"is_billable": False},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["is_billable"] is False
    assert body["changed_at"] is not None
    assert body["changed_by"] is not None

    # Persisted: a fresh GET reflects the new value.
    res = await client.get(
        f"/api/v1/members/{member_id}/billing-status",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["is_billable"] is False


@pytest.mark.asyncio
async def test_unrelated_chw_denied(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    """A CHW with no care relationship is denied on read and write (403)."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    other_chw = await _register(client, "unrelated_chw@test.dev", "chw")

    res = await client.get(
        f"/api/v1/members/{member_id}/billing-status",
        headers=auth_header(other_chw),
    )
    assert res.status_code == 403

    res = await client.patch(
        f"/api/v1/members/{member_id}/billing-status",
        json={"is_billable": False},
        headers=auth_header(other_chw),
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_member_can_read_but_not_write(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    """The member may view their own status but cannot change it (403)."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.get(
        f"/api/v1/members/{member_id}/billing-status",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200
    assert res.json()["is_billable"] is True

    res = await client.patch(
        f"/api/v1/members/{member_id}/billing-status",
        json={"is_billable": False},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403
