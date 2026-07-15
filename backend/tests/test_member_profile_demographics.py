"""Tests for member self-service demographics edit via PUT /api/v1/member/profile.

Coverage:
  - A member can update the full demographic set (name, preferred name, DOB,
    sex, address, ZIP, language, insurance, CIN); the response + a follow-up GET
    reflect the normalized values.
  - Invalid CIN, gender, and state are rejected with 422 (invariant-violation
    path, not just the happy path — see backend/TESTING.md).
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


@pytest.mark.asyncio
async def test_member_can_edit_all_demographics(
    client: AsyncClient, member_tokens: dict, setup_db
):
    res = await client.put(
        "/api/v1/member/profile",
        json={
            "name": "Jane Q Doe",
            "preferred_name": "Janey",
            "date_of_birth": "1990-05-21",
            "gender": "female",        # normalized -> "Female"
            "address_line1": "1 Main St",
            "address_line2": "Apt 2",
            "city": "Los Angeles",
            "state": "ca",             # normalized -> "CA"
            "zip_code": "90001",
            "primary_language": "Spanish",
            "insurance_company": "Health Net",
            "medi_cal_id": "12345678a",  # normalized -> "12345678A"
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["name"] == "Jane Q Doe"
    assert body["preferred_name"] == "Janey"
    assert body["date_of_birth"] == "1990-05-21"
    assert body["gender"] == "Female"
    assert body["address_line1"] == "1 Main St"
    assert body["city"] == "Los Angeles"
    assert body["state"] == "CA"
    assert body["insurance_company"] == "Health Net"
    assert body["medi_cal_id"] == "12345678A"

    # A follow-up GET returns the same persisted, normalized values.
    res = await client.get("/api/v1/member/profile", headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
    got = res.json()
    assert got["medi_cal_id"] == "12345678A"
    assert got["date_of_birth"] == "1990-05-21"
    assert got["gender"] == "Female"
    assert got["state"] == "CA"


@pytest.mark.asyncio
async def test_member_invalid_cin_rejected(
    client: AsyncClient, member_tokens: dict, setup_db
):
    res = await client.put(
        "/api/v1/member/profile",
        json={"medi_cal_id": "1234"},  # not 8 digits + letter
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_member_invalid_gender_rejected(
    client: AsyncClient, member_tokens: dict, setup_db
):
    res = await client.put(
        "/api/v1/member/profile",
        json={"gender": "Robot"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_member_invalid_state_rejected(
    client: AsyncClient, member_tokens: dict, setup_db
):
    res = await client.put(
        "/api/v1/member/profile",
        json={"state": "California"},  # must be 2-letter code
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_member_profile_exposes_phone_verified_at(
    client: AsyncClient, member_tokens: dict, setup_db
):
    """GET /member/profile surfaces phone_verified_at so the Settings "Text
    messages" card (SMS Output Spec 1) can render its on/off state. A freshly
    registered member has never verified their phone, so it is null."""
    res = await client.get("/api/v1/member/profile", headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
    body = res.json()
    assert "phone_verified_at" in body
    assert body["phone_verified_at"] is None
