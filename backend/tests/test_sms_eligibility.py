"""Unit tests for app.services.sms_eligibility.check_sms_eligibility.

Covers every rule in the eligibility contract:
  - sentinel phone (555-555-5555 and formatting variants) excluded
  - non-E.164 / missing phone excluded
  - unverified phone excluded
  - opted-out member excluded
  - duplicate phone (shared by two otherwise-eligible members) excluded
  - happy path eligible

Uses the `client` fixture only to register real member accounts with all
Pear-required signup fields (mirrors the pattern in
tests/test_bidirectional_comms.py); phone/verification/opt-out state is then
set directly on the DB rows via `tests.conftest.test_session`, since
eligibility is a pure DB-state function with no HTTP surface of its own yet.
"""

from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.user import MemberProfile, User
from app.services.sms_eligibility import (
    SENTINEL_PHONE_E164,
    check_sms_eligibility,
    normalize_phone_e164,
)
from tests.conftest import test_session as _test_session_factory


async def _register_member(client: AsyncClient, email: str) -> str:
    payload = {
        "email": email,
        "password": "testpass123",
        "name": "Eligibility Test Member",
        "role": "member",
        "date_of_birth": "1990-01-01",
        "gender": "Female",
        "insurance_company": "Health Net",
        "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
        "zip_code": "90001",
    }
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, f"Register failed: {res.text}"

    import base64
    import json

    parts = res.json()["access_token"].split(".")
    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))["sub"]


async def _set_member_state(
    member_id: str,
    *,
    phone: str | None,
    phone_verified: bool,
    sms_opt_out: bool = False,
) -> None:
    from datetime import UTC, datetime

    async with _test_session_factory() as session:
        user = await session.get(User, UUID(member_id))
        assert user is not None
        user.phone = phone
        user.phone_verified_at = datetime.now(UTC) if phone_verified else None

        profile_result = await session.execute(
            select(MemberProfile).where(MemberProfile.user_id == UUID(member_id))
        )
        profile = profile_result.scalar_one()
        profile.sms_opt_out = sms_opt_out
        await session.commit()


async def _load_member_and_profile(member_id: str) -> tuple[User, MemberProfile]:
    async with _test_session_factory() as session:
        user = await session.get(User, UUID(member_id))
        assert user is not None
        profile_result = await session.execute(
            select(MemberProfile).where(MemberProfile.user_id == UUID(member_id))
        )
        profile = profile_result.scalar_one()
        return user, profile


# ─── normalize_phone_e164 ──────────────────────────────────────────────────────


def test_normalize_phone_e164_collapses_sentinel_variants():
    assert normalize_phone_e164("555-555-5555") == SENTINEL_PHONE_E164
    assert normalize_phone_e164("(555) 555-5555") == SENTINEL_PHONE_E164
    assert normalize_phone_e164("5555555555") == SENTINEL_PHONE_E164
    assert normalize_phone_e164("+1 555 555 5555") == SENTINEL_PHONE_E164


def test_normalize_phone_e164_none_and_empty():
    assert normalize_phone_e164(None) is None
    assert normalize_phone_e164("") is None
    assert normalize_phone_e164("   ") is None


# ─── check_sms_eligibility ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_happy_path_eligible(client: AsyncClient):
    member_id = await _register_member(client, "elig_happy@test.com")
    await _set_member_state(member_id, phone="+13105551111", phone_verified=True)

    async with _test_session_factory() as session:
        user, profile = await _load_member_and_profile(member_id)
        result = await check_sms_eligibility(session, member_user=user, member_profile=profile)

    assert result.eligible is True
    assert result.normalized_phone == "+13105551111"
    assert result.reason_code is None


@pytest.mark.asyncio
async def test_sentinel_phone_excluded(client: AsyncClient):
    member_id = await _register_member(client, "elig_sentinel@test.com")
    await _set_member_state(member_id, phone="555-555-5555", phone_verified=True)

    async with _test_session_factory() as session:
        user, profile = await _load_member_and_profile(member_id)
        result = await check_sms_eligibility(session, member_user=user, member_profile=profile)

    assert result.eligible is False
    assert result.reason_code == "sentinel_phone"


@pytest.mark.asyncio
async def test_no_phone_excluded(client: AsyncClient):
    member_id = await _register_member(client, "elig_nophone@test.com")
    await _set_member_state(member_id, phone=None, phone_verified=False)

    async with _test_session_factory() as session:
        user, profile = await _load_member_and_profile(member_id)
        result = await check_sms_eligibility(session, member_user=user, member_profile=profile)

    assert result.eligible is False
    assert result.reason_code == "no_phone"


@pytest.mark.asyncio
async def test_unverified_phone_excluded(client: AsyncClient):
    member_id = await _register_member(client, "elig_unverified@test.com")
    await _set_member_state(member_id, phone="+13105552222", phone_verified=False)

    async with _test_session_factory() as session:
        user, profile = await _load_member_and_profile(member_id)
        result = await check_sms_eligibility(session, member_user=user, member_profile=profile)

    assert result.eligible is False
    assert result.reason_code == "phone_not_verified"


@pytest.mark.asyncio
async def test_opted_out_excluded(client: AsyncClient):
    member_id = await _register_member(client, "elig_optout@test.com")
    await _set_member_state(
        member_id, phone="+13105553333", phone_verified=True, sms_opt_out=True
    )

    async with _test_session_factory() as session:
        user, profile = await _load_member_and_profile(member_id)
        result = await check_sms_eligibility(session, member_user=user, member_profile=profile)

    assert result.eligible is False
    assert result.reason_code == "opted_out"


@pytest.mark.asyncio
async def test_duplicate_phone_excludes_both_members(client: AsyncClient):
    """Two otherwise-eligible members sharing one phone are BOTH ineligible —
    inbound routing can't disambiguate them by from-number."""
    member1_id = await _register_member(client, "elig_dup1@test.com")
    member2_id = await _register_member(client, "elig_dup2@test.com")
    shared_phone = "+13105554444"
    await _set_member_state(member1_id, phone=shared_phone, phone_verified=True)
    await _set_member_state(member2_id, phone=shared_phone, phone_verified=True)

    async with _test_session_factory() as session:
        user1, profile1 = await _load_member_and_profile(member1_id)
        result1 = await check_sms_eligibility(session, member_user=user1, member_profile=profile1)
        user2, profile2 = await _load_member_and_profile(member2_id)
        result2 = await check_sms_eligibility(session, member_user=user2, member_profile=profile2)

    assert result1.eligible is False
    assert result1.reason_code == "duplicate_phone"
    assert result2.eligible is False
    assert result2.reason_code == "duplicate_phone"


@pytest.mark.asyncio
async def test_duplicate_phone_ignores_opted_out_duplicate(client: AsyncClient):
    """A shared phone doesn't block eligibility when the OTHER holder has
    opted out of SMS — they're no longer a routing collision risk."""
    member1_id = await _register_member(client, "elig_dupoptout1@test.com")
    member2_id = await _register_member(client, "elig_dupoptout2@test.com")
    shared_phone = "+13105555555"
    await _set_member_state(member1_id, phone=shared_phone, phone_verified=True)
    await _set_member_state(
        member2_id, phone=shared_phone, phone_verified=True, sms_opt_out=True
    )

    async with _test_session_factory() as session:
        user1, profile1 = await _load_member_and_profile(member1_id)
        result1 = await check_sms_eligibility(session, member_user=user1, member_profile=profile1)

    assert result1.eligible is True
