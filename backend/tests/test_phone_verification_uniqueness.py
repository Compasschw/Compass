"""Regression test: POST /phone/confirm-verification must not 500 when the
verified phone collides with QA-batch #1's platform-wide unique index.

This endpoint sets User.phone directly (see app/routers/phone_verification.py
confirm_verification) WITHOUT going through auth_service.register_user's
pre-create duplicate-phone check — it's a second, independent write path onto
the same column. Before this fix, a second user verifying an already-taken
phone would hit the raw `uq_users_phone_not_null` IntegrityError unhandled,
violating TESTING.md rule #3 (no unhandled 500s). FAILS on the pre-fix code
with an unhandled 500; passes with a clean 409 after.
"""

from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header

pytestmark = pytest.mark.asyncio

_COMPLIANT_PASSWORD = "Testpass123!"


async def _register_member(client: AsyncClient, email: str, name: str) -> dict:
    res = await client.post(
        "/api/v1/auth/register",
        json={
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
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


async def _seed_verified_phone(user_id: str, phone: str) -> None:
    """Set User.phone/phone_verified_at directly, bypassing the OTP flow —
    equivalent end state to a real confirm-verification success."""
    from uuid import UUID

    from app.models.user import User
    from tests.conftest import test_session as _session_factory

    async with _session_factory() as db:
        user = await db.get(User, UUID(user_id))
        assert user is not None
        user.phone = phone
        user.phone_verified_at = datetime.now(UTC)
        await db.commit()


async def _seed_active_verification_code(
    user_id: str, phone: str, code: str
) -> None:
    import uuid as _uuid

    from app.models.phone_verification import PhoneVerification
    from app.utils.security import pwd_context
    from tests.conftest import test_session as _session_factory

    async with _session_factory() as db:
        db.add(
            PhoneVerification(
                id=_uuid.uuid4(),
                user_id=_uuid.UUID(user_id),
                phone_e164=phone,
                code_hash=pwd_context.hash(code),
                attempts_left=5,
                expires_at=datetime.now(UTC) + timedelta(minutes=10),
            )
        )
        await db.commit()


async def test_confirm_verification_duplicate_phone_returns_409_not_500(
    client: AsyncClient,
) -> None:
    """A second member confirming a phone another member already has
    verified gets a clean 409, not an unhandled IntegrityError/500."""
    member_a = await _register_member(client, "phoneverif_a@example.com", "Member A")
    member_b = await _register_member(client, "phoneverif_b@example.com", "Member B")

    shared_phone = "+13105558899"
    member_a_id = _decode_sub(member_a)
    await _seed_verified_phone(member_a_id, shared_phone)

    code = "482913"
    member_b_id = _decode_sub(member_b)
    await _seed_active_verification_code(member_b_id, shared_phone, code)

    res = await client.post(
        "/api/v1/phone/confirm-verification",
        json={"phone": shared_phone, "code": code},
        headers=auth_header(member_b),
    )
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == "An account with this phone number already exists."


def _decode_sub(tokens: dict) -> str:
    import base64
    import json

    payload_segment = tokens["access_token"].split(".")[1]
    padded = payload_segment + "=" * (4 - len(payload_segment) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded))
    return payload["sub"]
