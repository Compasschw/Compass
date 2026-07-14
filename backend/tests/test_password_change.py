"""Epic G2 — first-login password change.

When a CHW creates a member (``POST /chw/members``), the member gets a
temporary password the CHW shares out-of-band. On the member's FIRST sign-in
the frontend must prompt them to set their own password. Self-registered
members (who chose their own password at signup) must NOT be prompted.

Two things under test:

1. The signal — ``User.must_change_password`` is True for a CHW-created
   member and False for a self-registered one, and is surfaced on both the
   login response (``TokenResponse.must_change_password``) and the member
   profile bootstrap (``MemberProfileResponse.must_change_password``).

2. The endpoint — ``POST /auth/change-password`` verifies the current
   password, enforces the same minimum-length rule as signup, and on success
   rotates the hash and clears the flag.

Per backend/TESTING.md's checklist for a new endpoint:
  - negative auth (no token) -> 401/403
  - wrong-current-password -> 401, AND the password is provably unchanged
    (old password still logs in)
  - weak new password -> 422
  - a seeded invariant-adjacent bad state (an unparseable password_hash)
    must not 500
  - the happy path, including that the flag is actually cleared afterward

Every test here is a regression test for the golden rule: none of them can
pass against the pre-Epic-G2 code (the endpoint/column didn't exist), so
they all fail on that baseline and pass only once this feature is built.
"""
from __future__ import annotations

from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.user import User
from tests.conftest import auth_header, complete_member_signup_payload
from tests.conftest import test_session as _session_factory

pytestmark = pytest.mark.asyncio

# NOTE: is_export_eligible() (member_csv_writer.py) excludes @example.com
# addresses, but member_csv_enabled defaults False in tests anyway, so no S3
# boundary is touched by any test below.
_CHW_NEW_MEMBER_PAYLOAD = {
    "email": "pwchange.member@compasschw-test.dev",
    "temp_password": "Temp-pass-1234!",
    "name": "Pw Change",
    "phone": "+13105550199",
    "date_of_birth": "1990-04-12",
    "gender": "Female",
    "insurance_company": "Health Net",
    "medi_cal_id": "91234567A",
    "address_line1": "742 Evergreen Ter",
    "city": "Los Angeles",
    "state": "CA",
    "zip_code": "90001",
    "terms_accepted": True,
    "communications_consent": True,
}


async def _get_user_by_id(user_id: UUID) -> User:
    async with _session_factory() as session:
        return (
            await session.execute(select(User).where(User.id == user_id))
        ).scalar_one()


async def _create_chw_member_and_login(
    client: AsyncClient, chw_tokens: dict
) -> tuple[UUID, dict]:
    """Create a member via the CHW-onboarding endpoint, then log that member
    in with their temp password. Returns (member_id, member_tokens)."""
    create_res = await client.post(
        "/api/v1/chw/members",
        json=_CHW_NEW_MEMBER_PAYLOAD,
        headers=auth_header(chw_tokens),
    )
    assert create_res.status_code == 201, create_res.text
    member_id = UUID(create_res.json()["id"])

    login_res = await client.post(
        "/api/v1/auth/login",
        json={
            "email": _CHW_NEW_MEMBER_PAYLOAD["email"],
            "password": _CHW_NEW_MEMBER_PAYLOAD["temp_password"],
        },
    )
    assert login_res.status_code == 200, login_res.text
    return member_id, login_res.json()


# ─── must_change_password signal ──────────────────────────────────────────────


async def test_chw_created_member_has_must_change_password_true(
    client: AsyncClient, chw_tokens: dict
) -> None:
    """The core G2 signal: a CHW-created member is flagged, on the DB row AND
    on the login response the frontend actually reads."""
    member_id, member_tokens = await _create_chw_member_and_login(client, chw_tokens)

    user = await _get_user_by_id(member_id)
    assert user.must_change_password is True
    assert member_tokens["must_change_password"] is True

    profile_res = await client.get(
        "/api/v1/member/profile", headers=auth_header(member_tokens)
    )
    assert profile_res.status_code == 200, profile_res.text
    assert profile_res.json()["must_change_password"] is True


async def test_self_registered_member_has_must_change_password_false(
    client: AsyncClient,
) -> None:
    """A member who chose their own password at signup must never be
    prompted — this is the false-positive this feature must avoid."""
    payload = complete_member_signup_payload(email="selfreg.pwchange@example.com")
    register_res = await client.post("/api/v1/auth/register", json=payload)
    assert register_res.status_code == 201, register_res.text
    assert register_res.json()["must_change_password"] is False

    login_res = await client.post(
        "/api/v1/auth/login",
        json={"email": payload["email"], "password": payload["password"]},
    )
    assert login_res.status_code == 200, login_res.text
    assert login_res.json()["must_change_password"] is False

    profile_res = await client.get(
        "/api/v1/member/profile", headers=auth_header(login_res.json())
    )
    assert profile_res.status_code == 200, profile_res.text
    assert profile_res.json()["must_change_password"] is False


async def test_self_registered_chw_has_must_change_password_false(
    client: AsyncClient, chw_tokens: dict
) -> None:
    """Sanity: the flag must default False for a normal CHW self-signup too
    (chw_tokens fixture registers via /auth/register), not just members."""
    assert chw_tokens["must_change_password"] is False


# ─── POST /auth/change-password ────────────────────────────────────────────────


async def test_change_password_requires_auth(client: AsyncClient) -> None:
    """Negative auth: no Bearer token -> hard reject. FastAPI's HTTPBearer
    returns 401 in current versions (was 403 historically) — accept either,
    matching the existing convention in tests/test_auth.py."""
    res = await client.post(
        "/api/v1/auth/change-password",
        json={"current_password": "whatever12", "new_password": "Newpassword123!"},
    )
    assert res.status_code in (401, 403)


async def test_change_password_wrong_current_password_is_rejected(
    client: AsyncClient, chw_tokens: dict
) -> None:
    """Wrong current password -> 401, AND the password must be provably
    unchanged afterward (the old password still logs in)."""
    member_id, member_tokens = await _create_chw_member_and_login(client, chw_tokens)

    res = await client.post(
        "/api/v1/auth/change-password",
        json={"current_password": "totally-wrong-password", "new_password": "Brand-new-password-1!"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 401, res.text

    # Post-failure DB state: the temp password must still work, and the flag
    # must still be set (the failed attempt must not have side-effects).
    relogin_res = await client.post(
        "/api/v1/auth/login",
        json={
            "email": _CHW_NEW_MEMBER_PAYLOAD["email"],
            "password": _CHW_NEW_MEMBER_PAYLOAD["temp_password"],
        },
    )
    assert relogin_res.status_code == 200, relogin_res.text
    assert relogin_res.json()["must_change_password"] is True

    user = await _get_user_by_id(member_id)
    assert user.must_change_password is True


async def test_change_password_weak_new_password_is_rejected(
    client: AsyncClient, chw_tokens: dict
) -> None:
    """New password shorter than 8 chars -> 422, matching the exact
    minimum-length rule RegisterRequest/CHWCreateMemberRequest enforce at
    signup — the strength bar must never silently diverge."""
    _member_id, member_tokens = await _create_chw_member_and_login(client, chw_tokens)

    res = await client.post(
        "/api/v1/auth/change-password",
        json={
            "current_password": _CHW_NEW_MEMBER_PAYLOAD["temp_password"],
            "new_password": "short",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 422, res.text


async def test_change_password_with_unparseable_stored_hash_does_not_500(
    client: AsyncClient, chw_tokens: dict
) -> None:
    """No-unhandled-500 (TESTING.md #3): passlib's verify_password raises
    UnknownHashError (not a boolean False) when the stored hash isn't in a
    format it recognizes — e.g. corrupted or pre-migration legacy data. The
    handler must catch this and return a clean 401, never a bare 500. FAILS
    on a version of change_password that calls verify_password unguarded."""
    member_id, member_tokens = await _create_chw_member_and_login(client, chw_tokens)

    async with _session_factory() as session:
        user = await session.get(User, member_id)
        assert user is not None
        user.password_hash = "not-a-real-argon2-hash"
        await session.commit()

    res = await client.post(
        "/api/v1/auth/change-password",
        json={"current_password": "anything-at-all", "new_password": "Brand-new-password-1!"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 401, res.text
    assert "detail" in res.json()


async def test_change_password_with_no_password_hash_is_rejected(
    client: AsyncClient, chw_tokens: dict
) -> None:
    """OAuth-only accounts have password_hash is None — nothing to "change
    from". Must be a clean 401, not a 500 from calling verify_password(None)."""
    member_id, member_tokens = await _create_chw_member_and_login(client, chw_tokens)

    async with _session_factory() as session:
        user = await session.get(User, member_id)
        assert user is not None
        user.password_hash = None
        await session.commit()

    res = await client.post(
        "/api/v1/auth/change-password",
        json={"current_password": "anything-at-all", "new_password": "Brand-new-password-1!"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 401, res.text


async def test_change_password_success_clears_flag_and_rotates_hash(
    client: AsyncClient, chw_tokens: dict
) -> None:
    """The happy path: correct current password + valid new password ->
    200, the flag clears, the OLD password stops working, and the NEW
    password logs in."""
    member_id, member_tokens = await _create_chw_member_and_login(client, chw_tokens)

    res = await client.post(
        "/api/v1/auth/change-password",
        json={
            "current_password": _CHW_NEW_MEMBER_PAYLOAD["temp_password"],
            "new_password": "Brand-new-password-1!",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["must_change_password"] is False

    # DB state: flag cleared, hash actually rotated.
    user = await _get_user_by_id(member_id)
    assert user.must_change_password is False

    # Old (temp) password no longer works.
    old_login_res = await client.post(
        "/api/v1/auth/login",
        json={
            "email": _CHW_NEW_MEMBER_PAYLOAD["email"],
            "password": _CHW_NEW_MEMBER_PAYLOAD["temp_password"],
        },
    )
    assert old_login_res.status_code == 401, old_login_res.text

    # New password works, and no longer reports must_change_password.
    new_login_res = await client.post(
        "/api/v1/auth/login",
        json={
            "email": _CHW_NEW_MEMBER_PAYLOAD["email"],
            "password": "Brand-new-password-1!",
        },
    )
    assert new_login_res.status_code == 200, new_login_res.text
    assert new_login_res.json()["must_change_password"] is False

    profile_res = await client.get(
        "/api/v1/member/profile", headers=auth_header(new_login_res.json())
    )
    assert profile_res.status_code == 200, profile_res.text
    assert profile_res.json()["must_change_password"] is False


async def test_change_password_works_for_a_chw_with_a_real_password_too(
    client: AsyncClient, chw_tokens: dict
) -> None:
    """The endpoint is not member-only — a CHW with a normal (self-chosen)
    password can also rotate it via the same endpoint."""
    res = await client.post(
        "/api/v1/auth/change-password",
        json={"current_password": "Testpass123!", "new_password": "A-new-chw-password-1!"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    relogin_res = await client.post(
        "/api/v1/auth/login",
        json={"email": "testchw@example.com", "password": "A-new-chw-password-1!"},
    )
    assert relogin_res.status_code == 200, relogin_res.text
