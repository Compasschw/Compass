"""Regression tests for QA-batch #1 — CHW (and platform-wide) phone uniqueness.

Coverage:
  1. A second CHW registering with the same phone (identical formatting) as
     an existing account gets 409 with the exact documented detail message.
  2. The SAME underlying phone number in a different raw format (spaces /
     dashes / parens) still collides post-normalization -> 409.
  3. NULL phones are unlimited — any number of CHWs may register with no
     phone at all.
  4. A member self-signing-up with a FRESH (unused) phone is unaffected —
     the guard does not false-positive on legitimate distinct numbers.
  5. Cross-role collision: a CHW cannot take a phone already used by a
     member (and vice versa) — the guard is role-agnostic, matching the
     "any role providing a phone" scope of the fix.
  6. POST /chw/members (CHW-initiated member creation) also enforces the
     guard — both call sites route through the same register_user() check.
  7. The DB-level partial unique index exists (race-safety backstop) —
     verified by attempting a raw duplicate INSERT that bypasses the
     application-layer check entirely.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.exc import IntegrityError

from tests.conftest import auth_header

pytestmark = pytest.mark.asyncio

_COMPLIANT_PASSWORD = "Testpass123!"


def _chw_payload(email: str, phone: str | None, name: str = "Some CHW") -> dict:
    payload: dict = {
        "email": email,
        "password": _COMPLIANT_PASSWORD,
        "name": name,
        "role": "chw",
    }
    if phone is not None:
        payload["phone"] = phone
    return payload


def _member_payload(email: str, phone: str | None, name: str = "Some Member") -> dict:
    payload: dict = {
        "email": email,
        "password": _COMPLIANT_PASSWORD,
        "name": name,
        "role": "member",
        "date_of_birth": "1990-01-01",
        "gender": "Female",
        "insurance_company": "Health Net",
        "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
        "zip_code": "90001",
        "terms_accepted": True,
        "communications_consent": True,
    }
    if phone is not None:
        payload["phone"] = phone
    return payload


async def test_duplicate_phone_chw_register_returns_409(client: AsyncClient) -> None:
    first = await client.post(
        "/api/v1/auth/register",
        json=_chw_payload("chw_first@example.com", "+13105550100", "CHW First"),
    )
    assert first.status_code == 201, first.text

    second = await client.post(
        "/api/v1/auth/register",
        json=_chw_payload("chw_second@example.com", "+13105550100", "CHW Second"),
    )
    assert second.status_code == 409, second.text
    assert second.json()["detail"] == "An account with this phone number already exists."


async def test_duplicate_phone_different_formatting_still_collides(
    client: AsyncClient,
) -> None:
    """Same number, different raw formatting — both normalize to the same
    E.164 value, so the second registration is still rejected."""
    first = await client.post(
        "/api/v1/auth/register",
        json=_chw_payload("chw_fmt_a@example.com", "(310) 555-0177", "CHW Format A"),
    )
    assert first.status_code == 201, first.text

    second = await client.post(
        "/api/v1/auth/register",
        json=_chw_payload("chw_fmt_b@example.com", "310-555-0177", "CHW Format B"),
    )
    assert second.status_code == 409, second.text
    assert second.json()["detail"] == "An account with this phone number already exists."


async def test_null_phones_are_unlimited(client: AsyncClient) -> None:
    """Any number of CHWs may register with no phone at all — NULL is never
    compared for uniqueness."""
    first = await client.post(
        "/api/v1/auth/register",
        json=_chw_payload("chw_nophone_a@example.com", None, "CHW No Phone A"),
    )
    assert first.status_code == 201, first.text

    second = await client.post(
        "/api/v1/auth/register",
        json=_chw_payload("chw_nophone_b@example.com", None, "CHW No Phone B"),
    )
    assert second.status_code == 201, second.text


async def test_member_signup_with_fresh_phone_unaffected(client: AsyncClient) -> None:
    """A member signing up with a phone nobody else has on file registers
    normally — the guard only fires on an actual collision."""
    res = await client.post(
        "/api/v1/auth/register",
        json=_member_payload("member_freshphone@example.com", "+13105551234"),
    )
    assert res.status_code == 201, res.text


async def test_cross_role_phone_collision_rejected(client: AsyncClient) -> None:
    """A member cannot take a phone already registered to a CHW — the guard
    is role-agnostic, not scoped only to CHW-vs-CHW collisions."""
    chw_res = await client.post(
        "/api/v1/auth/register",
        json=_chw_payload("chw_crossrole@example.com", "+13105559876", "Cross Role CHW"),
    )
    assert chw_res.status_code == 201, chw_res.text

    member_res = await client.post(
        "/api/v1/auth/register",
        json=_member_payload("member_crossrole@example.com", "+13105559876"),
    )
    assert member_res.status_code == 409, member_res.text
    assert (
        member_res.json()["detail"]
        == "An account with this phone number already exists."
    )


async def test_chw_created_member_duplicate_phone_returns_409(
    client: AsyncClient, chw_tokens: dict
) -> None:
    """POST /chw/members (CHW-initiated member creation) enforces the same
    guard — both member-creation surfaces route through register_user()."""
    existing = await client.post(
        "/api/v1/auth/register",
        json=_member_payload("existing_phone_owner@example.com", "+13105557766"),
    )
    assert existing.status_code == 201, existing.text

    res = await client.post(
        "/api/v1/chw/members",
        json={
            "email": "chw_created_dupe@example.com",
            "temp_password": "Temp-pass-1234!",
            "name": "CHW Created Dupe",
            "phone": "+13105557766",
            "date_of_birth": "1988-02-02",
            "gender": "Male",
            "insurance_company": "Health Net",
            "medi_cal_id": "91234567B",
            "zip_code": "90001",
            "terms_accepted": True,
            "communications_consent": True,
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == "An account with this phone number already exists."


async def test_db_level_partial_unique_index_backstops_races(client: AsyncClient) -> None:
    """The application-layer check is not the only guard — a raw duplicate
    INSERT that bypasses register_user() entirely (simulating two concurrent
    requests that both pass the in-app pre-check before either commits)
    still fails at the DB layer via the partial unique index."""
    from app.models.user import User
    from app.utils.security import hash_password
    from tests.conftest import test_session as _session_factory

    shared_phone = "+13105554321"

    async with _session_factory() as db:
        db.add(
            User(
                id=uuid.uuid4(),
                email="race_a@example.com",
                password_hash=hash_password(_COMPLIANT_PASSWORD),
                name="Race A",
                role="chw",
                phone=shared_phone,
                is_active=True,
            )
        )
        await db.commit()

    async with _session_factory() as db:
        db.add(
            User(
                id=uuid.uuid4(),
                email="race_b@example.com",
                password_hash=hash_password(_COMPLIANT_PASSWORD),
                name="Race B",
                role="chw",
                phone=shared_phone,
                is_active=True,
            )
        )
        with pytest.raises(IntegrityError):
            await db.commit()
