"""Regression tests for QA feedback batch (2026-07-14) Part 4 — CIN
(Medi-Cal ID) uniqueness across members.

Mirrors the style/rigor of tests/test_phone_uniqueness.py (QA-batch #1's
phone-uniqueness regression suite).

Coverage:
  1. Duplicate CIN at member signup (POST /auth/register) -> 409 with the
     exact documented detail message.
  2. Duplicate CIN at POST /chw/members (CHW-initiated member creation) -> 409.
  3. Duplicate CIN via PATCH /member/profile/insurance-cin -> 409.
  4. Duplicate CIN via PUT /member/profile -> 409.
  5. Self-update with an unchanged CIN never 409s against yourself, for BOTH
     PATCH .../insurance-cin and PUT /member/profile (proves exclude_user_id
     works).
  6. Different normalizations of the SAME underlying CIN still collide:
     spaces/dashes, case, and 14-char BIC -> 10-char CIN extraction.
  7. medi_cal_id_hash is populated correctly by the shared `set` event
     listener on MemberProfile.medi_cal_id, verified via a direct DB query
     after each of the 5 write paths (self-signup, OAuth-onboarding-
     completion, CHW-created member, PUT /member/profile, PATCH
     insurance-cin).
  8. DB-level partial unique index backstop (race-safety): a raw duplicate
     MemberProfile.medi_cal_id_hash INSERT that bypasses the application
     check entirely still fails at the DB layer.
"""

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.schemas.cin_config import normalize_cin
from app.utils.encryption import hash_cin
from tests.conftest import auth_header, unique_cin

pytestmark = pytest.mark.asyncio

_COMPLIANT_PASSWORD = "Testpass123!"
_DUPLICATE_CIN_DETAIL = "Another member already has this CIN (Medi-Cal ID)."


def _member_payload(email: str, cin: str | None, name: str = "Some Member") -> dict:
    payload: dict = {
        "email": email,
        "password": _COMPLIANT_PASSWORD,
        "name": name,
        "role": "member",
        "date_of_birth": "1990-01-01",
        "gender": "Female",
        "insurance_company": "Health Net",
        "zip_code": "90001",
        "terms_accepted": True,
        "communications_consent": True,
    }
    if cin is not None:
        payload["medi_cal_id"] = cin
    return payload


def _chw_created_member_payload(email: str, cin: str, name: str = "CHW Created Member") -> dict:
    return {
        "email": email,
        "temp_password": "Temp-pass-1234!",
        "name": name,
        "date_of_birth": "1988-02-02",
        "gender": "Male",
        "insurance_company": "Health Net",
        "medi_cal_id": cin,
        "zip_code": "90001",
        "terms_accepted": True,
        "communications_consent": True,
    }


async def _get_profile_and_user(email: str):
    from app.models.user import MemberProfile, User
    from tests.conftest import test_session as _session_factory

    async with _session_factory() as db:
        user_res = await db.execute(select(User).where(User.email == email))
        user = user_res.scalar_one()
        profile_res = await db.execute(
            select(MemberProfile).where(MemberProfile.user_id == user.id)
        )
        profile = profile_res.scalar_one()
        return user, profile


# ─── Duplicate CIN at signup ────────────────────────────────────────────────


async def test_duplicate_cin_member_register_returns_409(client: AsyncClient) -> None:
    cin = unique_cin()
    first = await client.post(
        "/api/v1/auth/register", json=_member_payload("cin_first@example.com", cin)
    )
    assert first.status_code == 201, first.text

    second = await client.post(
        "/api/v1/auth/register", json=_member_payload("cin_second@example.com", cin)
    )
    assert second.status_code == 409, second.text
    assert second.json()["detail"] == _DUPLICATE_CIN_DETAIL


async def test_member_signup_with_fresh_cin_unaffected(client: AsyncClient) -> None:
    """A member signing up with a CIN nobody else has on file registers
    normally — the guard only fires on an actual collision."""
    res = await client.post(
        "/api/v1/auth/register",
        json=_member_payload("cin_fresh@example.com", unique_cin()),
    )
    assert res.status_code == 201, res.text


# ─── Duplicate CIN via POST /chw/members ────────────────────────────────────


async def test_duplicate_cin_chw_created_member_returns_409(
    client: AsyncClient, chw_tokens: dict
) -> None:
    cin = unique_cin()
    existing = await client.post(
        "/api/v1/auth/register", json=_member_payload("cin_owner@example.com", cin)
    )
    assert existing.status_code == 201, existing.text

    res = await client.post(
        "/api/v1/chw/members",
        json=_chw_created_member_payload("cin_chw_created_dupe@example.com", cin),
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == _DUPLICATE_CIN_DETAIL


# ─── Duplicate CIN via edit endpoints ───────────────────────────────────────


async def test_duplicate_cin_via_insurance_cin_patch_returns_409(client: AsyncClient) -> None:
    cin_a = unique_cin()
    cin_b = unique_cin()
    a_res = await client.post(
        "/api/v1/auth/register", json=_member_payload("cin_patch_owner@example.com", cin_a)
    )
    assert a_res.status_code == 201, a_res.text

    b_tokens = (
        await client.post(
            "/api/v1/auth/register", json=_member_payload("cin_patch_editor@example.com", cin_b)
        )
    ).json()

    res = await client.patch(
        "/api/v1/member/profile/insurance-cin",
        json={"insurance_company": "Health Net", "medi_cal_id": cin_a},
        headers=auth_header(b_tokens),
    )
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == _DUPLICATE_CIN_DETAIL


async def test_duplicate_cin_via_profile_put_returns_409(client: AsyncClient) -> None:
    cin_a = unique_cin()
    cin_b = unique_cin()
    a_res = await client.post(
        "/api/v1/auth/register", json=_member_payload("cin_put_owner@example.com", cin_a)
    )
    assert a_res.status_code == 201, a_res.text

    b_tokens = (
        await client.post(
            "/api/v1/auth/register", json=_member_payload("cin_put_editor@example.com", cin_b)
        )
    ).json()

    res = await client.put(
        "/api/v1/member/profile",
        json={"medi_cal_id": cin_a},
        headers=auth_header(b_tokens),
    )
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == _DUPLICATE_CIN_DETAIL


# ─── Self-update with own unchanged CIN never 409s ──────────────────────────


async def test_self_update_with_unchanged_cin_succeeds_via_insurance_cin_patch(
    client: AsyncClient,
) -> None:
    cin = unique_cin()
    tokens = (
        await client.post(
            "/api/v1/auth/register", json=_member_payload("cin_self_patch@example.com", cin)
        )
    ).json()

    res = await client.patch(
        "/api/v1/member/profile/insurance-cin",
        json={"insurance_company": "Health Net", "medi_cal_id": cin},
        headers=auth_header(tokens),
    )
    assert res.status_code == 200, res.text


async def test_self_update_with_unchanged_cin_succeeds_via_profile_put(
    client: AsyncClient,
) -> None:
    cin = unique_cin()
    tokens = (
        await client.post(
            "/api/v1/auth/register", json=_member_payload("cin_self_put@example.com", cin)
        )
    ).json()

    res = await client.put(
        "/api/v1/member/profile",
        json={"medi_cal_id": cin},
        headers=auth_header(tokens),
    )
    assert res.status_code == 200, res.text


# ─── Different normalizations of the same CIN still collide ────────────────


async def test_duplicate_cin_spaces_and_dashes_still_collides(client: AsyncClient) -> None:
    base = unique_cin()  # e.g. "9000001A" (9 chars: 9 + 7 digits + letter)
    spaced = f"{base[0]} {base[1:5]}-{base[5:8]} {base[8]}"
    assert normalize_cin(spaced) == base

    first = await client.post(
        "/api/v1/auth/register", json=_member_payload("cin_fmt_a@example.com", base)
    )
    assert first.status_code == 201, first.text

    second = await client.post(
        "/api/v1/auth/register", json=_member_payload("cin_fmt_b@example.com", spaced)
    )
    assert second.status_code == 409, second.text
    assert second.json()["detail"] == _DUPLICATE_CIN_DETAIL


async def test_duplicate_cin_case_insensitive_still_collides(client: AsyncClient) -> None:
    base = unique_cin()
    lowered = base[:-1] + base[-1].lower()
    assert normalize_cin(lowered) == base

    first = await client.post(
        "/api/v1/auth/register", json=_member_payload("cin_case_a@example.com", base)
    )
    assert first.status_code == 201, first.text

    second = await client.post(
        "/api/v1/auth/register", json=_member_payload("cin_case_b@example.com", lowered)
    )
    assert second.status_code == 409, second.text
    assert second.json()["detail"] == _DUPLICATE_CIN_DETAIL


async def test_duplicate_cin_via_bic_extraction_collides(client: AsyncClient) -> None:
    """A 14-char BIC (10-char CIN + 4-digit Julian date) that extracts to the
    same 10-char CIN as an already-registered plain CIN must collide."""
    base10 = unique_cin() + "2"  # 10-char CIN: 9-char base + check digit
    bic14 = base10 + "2026"  # 14-char BIC: 10-char CIN + 4-digit Julian date
    assert normalize_cin(bic14) == base10

    first = await client.post(
        "/api/v1/auth/register", json=_member_payload("cin_bic_a@example.com", base10)
    )
    assert first.status_code == 201, first.text

    second = await client.post(
        "/api/v1/auth/register", json=_member_payload("cin_bic_b@example.com", bic14)
    )
    assert second.status_code == 409, second.text
    assert second.json()["detail"] == _DUPLICATE_CIN_DETAIL


# ─── medi_cal_id_hash correctness across write paths ────────────────────────


async def test_medi_cal_id_hash_populated_on_self_signup(client: AsyncClient) -> None:
    cin = unique_cin()
    res = await client.post(
        "/api/v1/auth/register", json=_member_payload("cin_hash_signup@example.com", cin)
    )
    assert res.status_code == 201, res.text

    _user, profile = await _get_profile_and_user("cin_hash_signup@example.com")
    assert profile.medi_cal_id_hash == hash_cin(normalize_cin(cin))


async def test_medi_cal_id_hash_updated_on_insurance_cin_patch(client: AsyncClient) -> None:
    cin_old = unique_cin()
    cin_new = unique_cin()
    tokens = (
        await client.post(
            "/api/v1/auth/register", json=_member_payload("cin_hash_patch@example.com", cin_old)
        )
    ).json()

    res = await client.patch(
        "/api/v1/member/profile/insurance-cin",
        json={"insurance_company": "Health Net", "medi_cal_id": cin_new},
        headers=auth_header(tokens),
    )
    assert res.status_code == 200, res.text

    _user, profile = await _get_profile_and_user("cin_hash_patch@example.com")
    assert profile.medi_cal_id_hash == hash_cin(normalize_cin(cin_new))


async def test_medi_cal_id_hash_updated_on_profile_put(client: AsyncClient) -> None:
    cin_old = unique_cin()
    cin_new = unique_cin()
    tokens = (
        await client.post(
            "/api/v1/auth/register", json=_member_payload("cin_hash_put@example.com", cin_old)
        )
    ).json()

    res = await client.put(
        "/api/v1/member/profile",
        json={"medi_cal_id": cin_new},
        headers=auth_header(tokens),
    )
    assert res.status_code == 200, res.text

    _user, profile = await _get_profile_and_user("cin_hash_put@example.com")
    assert profile.medi_cal_id_hash == hash_cin(normalize_cin(cin_new))


async def test_medi_cal_id_hash_populated_on_chw_created_member(
    client: AsyncClient, chw_tokens: dict
) -> None:
    cin = unique_cin()
    res = await client.post(
        "/api/v1/chw/members",
        json=_chw_created_member_payload("cin_hash_chwcreated@example.com", cin),
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text

    _user, profile = await _get_profile_and_user("cin_hash_chwcreated@example.com")
    assert profile.medi_cal_id_hash == hash_cin(normalize_cin(cin))


async def test_medi_cal_id_hash_populated_on_oauth_onboarding_completion(
    client: AsyncClient,
) -> None:
    """OAuth sign-up creates a member with no CIN; completing onboarding
    supplies one and the shared event listener must populate the hash."""
    from app.services.oauth_verification import OAuthIdentity

    identity = OAuthIdentity(
        email="cin_hash_oauth@example.com",
        email_verified=True,
        name="OAuth CIN Test",
        provider="google",
        subject="g-sub-cin-hash-oauth",
    )

    with patch("app.routers.auth._settings") as mock_s, \
         patch(
             "app.routers.auth.verify_google_id_token",
             new_callable=AsyncMock,
             return_value=identity,
         ), \
         patch("app.routers.auth._sync_new_member_to_pear", new_callable=AsyncMock), \
         patch("app.routers.auth._append_new_member_to_csv", new_callable=AsyncMock):
        mock_s.oauth_google_enabled = True
        mock_s.oauth_apple_enabled = False
        mock_s.refresh_token_expire_days = 7
        mock_s.access_token_expire_minutes = 15
        mock_s.secret_key = "test-secret-key-for-pytest-runner-placeholder-AABBCCDD"
        mock_s.member_csv_enabled = False
        mock_s.pear_suite_enabled = False

        signin_res = await client.post(
            "/api/v1/auth/oauth/google", json={"id_token": "valid.token"}
        )
    assert signin_res.status_code == 200, signin_res.text
    tokens = signin_res.json()

    cin = unique_cin()
    with patch("app.routers.auth._sync_new_member_to_pear", new_callable=AsyncMock), \
         patch("app.routers.auth._append_new_member_to_csv", new_callable=AsyncMock):
        res = await client.post(
            "/api/v1/auth/complete-member-onboarding",
            json={
                "date_of_birth": "1990-05-15",
                "gender": "Female",
                "insurance_company": "Health Net",
                "medi_cal_id": cin,
                "zip_code": "90001",
            },
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
    assert res.status_code == 200, res.text

    _user, profile = await _get_profile_and_user("cin_hash_oauth@example.com")
    assert profile.medi_cal_id_hash == hash_cin(normalize_cin(cin))


# ─── DB-level partial unique index backstop (race-safety) ──────────────────


async def test_db_level_partial_unique_index_backstops_races(client: AsyncClient) -> None:
    """The application-layer check is not the only guard — a raw duplicate
    MemberProfile INSERT that bypasses check_cin_uniqueness() entirely
    (simulating two concurrent requests that both pass the in-app pre-check
    before either commits) still fails at the DB layer via the partial
    unique index on medi_cal_id_hash."""
    from app.models.user import MemberProfile, User
    from app.utils.security import hash_password
    from tests.conftest import test_session as _session_factory

    user_a_id = uuid.uuid4()
    user_b_id = uuid.uuid4()

    async with _session_factory() as db:
        db.add(User(
            id=user_a_id,
            email="cin_race_a@example.com",
            password_hash=hash_password(_COMPLIANT_PASSWORD),
            name="CIN Race A",
            role="member",
            is_active=True,
        ))
        db.add(User(
            id=user_b_id,
            email="cin_race_b@example.com",
            password_hash=hash_password(_COMPLIANT_PASSWORD),
            name="CIN Race B",
            role="member",
            is_active=True,
        ))
        await db.commit()

    shared_cin = unique_cin()

    async with _session_factory() as db:
        db.add(MemberProfile(user_id=user_a_id, medi_cal_id=shared_cin))
        await db.commit()

    async with _session_factory() as db:
        db.add(MemberProfile(user_id=user_b_id, medi_cal_id=shared_cin))
        with pytest.raises(IntegrityError):
            await db.commit()
