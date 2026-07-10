"""Regression tests for POST /api/v1/chw/members — CHW-initiated member onboarding.

Covers the end-to-end contract the feature promises:
  - A CHW can create a brand-new member account (201) and get back id/name/email.
  - The full Pear-required demographic set is persisted onto the MemberProfile
    so the CHW-created member is as complete as a self-service signup.
  - The new member can immediately log in with the CHW-supplied temp password.
  - The CHW↔member care relationship is established, so the CHW can schedule a
    session with the new member without any prior request (relationship gate).
  - Duplicate email is rejected with 400 (mirrors /auth/register).
  - A member-role caller is rejected with 403 (require_role("chw")).
  - A single-token name (no last name) is rejected with 422.
  - Missing a Pear-required demographic field is rejected with 422 (not 500).
"""
from datetime import UTC, date, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from tests.conftest import auth_header
from tests.conftest import test_session as _session_factory

pytestmark = pytest.mark.asyncio


# Full Pear-ready payload — mirrors the member self-signup field set so the
# CHW-created member is complete and immediately billable.
_NEW_MEMBER_PAYLOAD = {
    "email": "brand.new.member@example.com",
    "temp_password": "temp-pass-1234",
    "name": "Brand New",
    "phone": "+13105550142",
    "date_of_birth": "1990-04-12",
    "gender": "Female",
    "insurance_company": "Health Net",
    "medi_cal_id": "91234567A",
    "address_line1": "742 Evergreen Ter",
    "address_line2": "Apt 3",
    "city": "Los Angeles",
    "state": "CA",
    "zip_code": "90001",
}


async def test_chw_creates_member_returns_201(client: AsyncClient, chw_tokens: dict):
    """Happy path: CHW onboards a member and receives the created record."""
    res = await client.post(
        "/api/v1/chw/members",
        json=_NEW_MEMBER_PAYLOAD,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["name"] == "Brand New"
    assert body["email"] == "brand.new.member@example.com"
    assert "id" in body and body["id"]


async def test_full_demographics_persisted_on_profile(
    client: AsyncClient, chw_tokens: dict
):
    """The full Pear-required field set lands on the MemberProfile row, so the
    CHW-created member is as complete as a self-service /auth/register signup."""
    from uuid import UUID

    from app.models.user import MemberProfile

    res = await client.post(
        "/api/v1/chw/members",
        json=_NEW_MEMBER_PAYLOAD,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    member_id = UUID(res.json()["id"])

    async with _session_factory() as session:
        profile = (
            await session.execute(
                select(MemberProfile).where(MemberProfile.user_id == member_id)
            )
        ).scalar_one()

    assert profile.date_of_birth == date(1990, 4, 12)
    assert profile.gender == "Female"
    assert profile.insurance_company == "Health Net"
    assert profile.medi_cal_id == "91234567A"  # decrypted via EncryptedString
    assert profile.address_line1 == "742 Evergreen Ter"
    assert profile.address_line2 == "Apt 3"
    assert profile.city == "Los Angeles"
    assert profile.state == "CA"
    assert profile.zip_code == "90001"


@pytest.mark.parametrize(
    "missing_field",
    ["date_of_birth", "gender", "insurance_company", "medi_cal_id", "zip_code"],
)
async def test_missing_required_field_returns_422(
    client: AsyncClient, chw_tokens: dict, missing_field: str
):
    """Dropping any Pear-required demographic is a 422 (boundary-validated,
    never an unhandled 500)."""
    payload = {k: v for k, v in _NEW_MEMBER_PAYLOAD.items() if k != missing_field}
    res = await client.post(
        "/api/v1/chw/members",
        json=payload,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


async def test_invalid_cin_returns_422(client: AsyncClient, chw_tokens: dict):
    """A garbage member ID is rejected at the boundary (mirrors /auth/register)."""
    res = await client.post(
        "/api/v1/chw/members",
        json={**_NEW_MEMBER_PAYLOAD, "medi_cal_id": "!!!"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


async def test_created_member_can_log_in(client: AsyncClient, chw_tokens: dict):
    """The member can authenticate with the CHW-supplied temporary password."""
    create = await client.post(
        "/api/v1/chw/members",
        json=_NEW_MEMBER_PAYLOAD,
        headers=auth_header(chw_tokens),
    )
    assert create.status_code == 201, create.text

    login = await client.post(
        "/api/v1/auth/login",
        json={
            "email": _NEW_MEMBER_PAYLOAD["email"],
            "password": _NEW_MEMBER_PAYLOAD["temp_password"],
        },
    )
    assert login.status_code == 200, login.text
    tokens = login.json()
    assert tokens["role"] == "member"
    assert tokens["access_token"]


async def test_relationship_lets_chw_schedule_with_member(
    client: AsyncClient, chw_tokens: dict
):
    """The matched ServiceRequest satisfies the schedule_session relationship gate."""
    create = await client.post(
        "/api/v1/chw/members",
        json=_NEW_MEMBER_PAYLOAD,
        headers=auth_header(chw_tokens),
    )
    assert create.status_code == 201, create.text
    member_id = create.json()["id"]

    # New member surfaces in the CHW's roster (relationship is visible).
    roster = await client.get("/api/v1/chw/members", headers=auth_header(chw_tokens))
    assert roster.status_code == 200, roster.text
    assert any(row["id"] == member_id for row in roster.json())

    # And the CHW can schedule directly — no pre-existing request needed because
    # create_chw_member already wrote the matched ServiceRequest.
    scheduled_at = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    schedule = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": member_id,
            "scheduled_at": scheduled_at,
            "mode": "in_person",
            "scheduling_status": "confirmed",
        },
        headers=auth_header(chw_tokens),
    )
    assert schedule.status_code == 201, schedule.text
    session = schedule.json()
    assert session["member_id"] == member_id


async def test_duplicate_email_returns_400(client: AsyncClient, chw_tokens: dict):
    """A second create with the same email is rejected (mirrors /auth/register)."""
    first = await client.post(
        "/api/v1/chw/members",
        json=_NEW_MEMBER_PAYLOAD,
        headers=auth_header(chw_tokens),
    )
    assert first.status_code == 201, first.text

    dup = await client.post(
        "/api/v1/chw/members",
        json={**_NEW_MEMBER_PAYLOAD, "name": "Different Name"},
        headers=auth_header(chw_tokens),
    )
    assert dup.status_code == 400, dup.text
    assert "already registered" in dup.json()["detail"].lower()


async def test_member_caller_forbidden(client: AsyncClient, member_tokens: dict):
    """A member-role caller cannot create members (require_role('chw'))."""
    res = await client.post(
        "/api/v1/chw/members",
        json=_NEW_MEMBER_PAYLOAD,
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403, res.text


async def test_single_token_name_rejected(client: AsyncClient, chw_tokens: dict):
    """Name without a last name is a 422 — Pear billing needs first + last."""
    res = await client.post(
        "/api/v1/chw/members",
        json={**_NEW_MEMBER_PAYLOAD, "name": "Mononym"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text
