"""Tests for the required signup-consent gate on both member-creation surfaces.

Two agreements are captured (A2P 10DLC documented opt-in + HIPAA consent audit):
  - ``terms_accepted``          → persisted as ``MemberProfile.terms_accepted_at``
  - ``communications_consent``  → persisted as ``MemberProfile.communications_consent_at``

Both booleans are REQUIRED (must be True) on:
  - self-service ``POST /auth/register`` (role == "member")
  - CHW-initiated ``POST /chw/members``

The backend enforces this independently of the UI (defense in depth): a missing
or ``False`` consent is a 422, and on success the two timestamps are stamped
NOW(UTC) on the created ``MemberProfile``. CHW *self*-registration (role == "chw")
is unaffected — the member-consent gate never applies to a CHW account.
"""
from datetime import UTC, datetime
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from tests.conftest import auth_header, complete_member_signup_payload
from tests.conftest import test_session as _session_factory

pytestmark = pytest.mark.asyncio


# Full Pear-ready CHW-create payload with both consents (mirrors the AddMemberModal
# wire shape). Individual tests strip/flip the consent keys to prove the gate.
_CHW_MEMBER_PAYLOAD = {
    "email": "consent.chw.member@example.com",
    "temp_password": "Temp-pass-1234!",
    "name": "Consent Member",
    "phone": "+13105550142",
    "date_of_birth": "1990-04-12",
    "gender": "Female",
    "insurance_company": "Health Net",
    "medi_cal_id": "91234567A",
    "zip_code": "90001",
    "terms_accepted": True,
    "communications_consent": True,
}


# ─── Self-service /auth/register ──────────────────────────────────────────────


async def test_register_member_missing_both_consents_rejected(client: AsyncClient):
    """A member signup with neither consent field present is a 422."""
    payload = complete_member_signup_payload(email="no-consent@example.com")
    payload.pop("terms_accepted")
    payload.pop("communications_consent")
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 422, res.text


@pytest.mark.parametrize("field", ["terms_accepted", "communications_consent"])
async def test_register_member_missing_one_consent_rejected(
    client: AsyncClient, field: str
):
    """Dropping EITHER consent field (absent) is a 422 — both are required."""
    payload = complete_member_signup_payload(email=f"missing-{field}@example.com")
    payload.pop(field)
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 422, res.text


@pytest.mark.parametrize("field", ["terms_accepted", "communications_consent"])
async def test_register_member_false_consent_rejected(client: AsyncClient, field: str):
    """An explicit ``False`` for either consent is a 422 (not just absence)."""
    payload = complete_member_signup_payload(email=f"false-{field}@example.com")
    payload[field] = False
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 422, res.text


async def test_register_member_with_consents_persists_timestamps(client: AsyncClient):
    """Happy path: both consents True → 201 AND both timestamps are stamped
    (queried from the DB, not inferred from the 201)."""
    from app.models.user import MemberProfile, User

    email = "consent-ok@example.com"
    before = datetime.now(UTC)
    res = await client.post(
        "/api/v1/auth/register",
        json=complete_member_signup_payload(email=email),
    )
    assert res.status_code == 201, res.text
    after = datetime.now(UTC)

    async with _session_factory() as session:
        profile = (
            await session.execute(
                select(MemberProfile)
                .join(User, MemberProfile.user_id == User.id)
                .where(User.email == email)
            )
        ).scalar_one()

    assert profile.terms_accepted_at is not None
    assert profile.communications_consent_at is not None
    # Stamped server-side at creation time (within the request window).
    assert before <= profile.terms_accepted_at <= after
    assert before <= profile.communications_consent_at <= after


async def test_register_chw_does_not_require_consent(client: AsyncClient):
    """CHW self-registration is unaffected by the member-consent gate — a CHW
    account is created with no consent fields (they don't apply to CHWs)."""
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "consent-not-required-chw@example.com",
            "password": "Test-password-1234!",
            "name": "Consent Chw",
            "role": "chw",
        },
    )
    assert res.status_code == 201, res.text


# ─── CHW-initiated /chw/members ───────────────────────────────────────────────


async def test_chw_create_member_missing_both_consents_rejected(
    client: AsyncClient, chw_tokens: dict
):
    """CHW member creation with neither consent field present is a 422."""
    payload = {
        k: v
        for k, v in _CHW_MEMBER_PAYLOAD.items()
        if k not in ("terms_accepted", "communications_consent")
    }
    res = await client.post(
        "/api/v1/chw/members", json=payload, headers=auth_header(chw_tokens)
    )
    assert res.status_code == 422, res.text


@pytest.mark.parametrize("field", ["terms_accepted", "communications_consent"])
async def test_chw_create_member_missing_one_consent_rejected(
    client: AsyncClient, chw_tokens: dict, field: str
):
    """Dropping EITHER consent field on the CHW path is a 422."""
    payload = {k: v for k, v in _CHW_MEMBER_PAYLOAD.items() if k != field}
    payload["email"] = f"chw-missing-{field}@example.com"
    res = await client.post(
        "/api/v1/chw/members", json=payload, headers=auth_header(chw_tokens)
    )
    assert res.status_code == 422, res.text


@pytest.mark.parametrize("field", ["terms_accepted", "communications_consent"])
async def test_chw_create_member_false_consent_rejected(
    client: AsyncClient, chw_tokens: dict, field: str
):
    """An explicit ``False`` for either consent on the CHW path is a 422."""
    payload = {**_CHW_MEMBER_PAYLOAD, field: False, "email": f"chw-false-{field}@example.com"}
    res = await client.post(
        "/api/v1/chw/members", json=payload, headers=auth_header(chw_tokens)
    )
    assert res.status_code == 422, res.text


async def test_chw_create_member_with_consents_persists_timestamps(
    client: AsyncClient, chw_tokens: dict
):
    """Happy path on the CHW path: 201 AND both consent timestamps are stamped
    on the created MemberProfile (queried from the DB)."""
    from app.models.user import MemberProfile

    before = datetime.now(UTC)
    res = await client.post(
        "/api/v1/chw/members",
        json=_CHW_MEMBER_PAYLOAD,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    after = datetime.now(UTC)
    member_id = UUID(res.json()["id"])

    async with _session_factory() as session:
        profile = (
            await session.execute(
                select(MemberProfile).where(MemberProfile.user_id == member_id)
            )
        ).scalar_one()

    assert profile.terms_accepted_at is not None
    assert profile.communications_consent_at is not None
    assert before <= profile.terms_accepted_at <= after
    assert before <= profile.communications_consent_at <= after
