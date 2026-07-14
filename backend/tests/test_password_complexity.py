"""Regression tests for QA-batch #8/#10 — platform-wide password complexity.

Coverage:
  Unit (pure — no DB, no network):
    U1-U4. `validate_password_complexity` rejects missing-uppercase,
       missing-digit, missing-special-character, and too-short with a
       descriptive ValueError naming exactly what's missing.
    U5. A fully compliant password passes and is returned unchanged.
    U6. Multiple simultaneous violations are named together in one message.

  Schema-level (pydantic 422 boundary), one test per requirement per schema:
    RegisterRequest.password
    ChangePasswordRequest.new_password
    CHWCreateMemberRequest.temp_password

  Each schema gets: missing-uppercase -> 422, missing-digit -> 422,
  missing-special -> 422, too-short -> 422, compliant -> passes (201/200).
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient
from pydantic import ValidationError

from app.schemas.auth import ChangePasswordRequest, RegisterRequest
from app.schemas.chw import CHWCreateMemberRequest
from app.utils.passwords import validate_password_complexity
from tests.conftest import auth_header

# NOTE: no module-level `pytestmark = pytest.mark.asyncio` — this file mixes
# pure-sync unit tests (validate_password_complexity, direct schema
# construction) with async HTTP integration tests, so each async test is
# marked individually with @pytest.mark.asyncio instead (mirrors
# test_chw_profile_bio_length.py's pattern).

_COMPLIANT_PASSWORD = "Testpass123!"

# ─── Unit tests: validate_password_complexity ──────────────────────────────


def test_u1_missing_uppercase_is_rejected() -> None:
    with pytest.raises(ValueError, match="uppercase"):
        validate_password_complexity("lowercase123!")


def test_u2_missing_digit_is_rejected() -> None:
    with pytest.raises(ValueError, match="digit"):
        validate_password_complexity("NoDigitsHere!")


def test_u3_missing_special_character_is_rejected() -> None:
    with pytest.raises(ValueError, match="special character"):
        validate_password_complexity("NoSpecial123")


def test_u4_too_short_is_rejected() -> None:
    with pytest.raises(ValueError, match="at least 8 characters"):
        validate_password_complexity("Sh0rt!")


def test_u5_compliant_password_passes_unchanged() -> None:
    assert validate_password_complexity(_COMPLIANT_PASSWORD) == _COMPLIANT_PASSWORD


def test_u6_multiple_violations_named_together() -> None:
    """A password missing BOTH uppercase and special char (but long enough,
    with a digit) names both in one message."""
    with pytest.raises(ValueError) as exc_info:
        validate_password_complexity("lowercase123")
    message = str(exc_info.value)
    assert "uppercase" in message
    assert "special character" in message


# ─── Schema-level: RegisterRequest.password ────────────────────────────────


def _register_kwargs(password: str) -> dict:
    return {
        "email": "schema_test@example.com",
        "password": password,
        "name": "Schema Tester",
        "role": "chw",
    }


def test_register_request_rejects_missing_uppercase() -> None:
    with pytest.raises(ValidationError, match="uppercase"):
        RegisterRequest(**_register_kwargs("lowercase123!"))


def test_register_request_rejects_missing_digit() -> None:
    with pytest.raises(ValidationError, match="digit"):
        RegisterRequest(**_register_kwargs("NoDigitsHere!"))


def test_register_request_rejects_missing_special() -> None:
    with pytest.raises(ValidationError, match="special character"):
        RegisterRequest(**_register_kwargs("NoSpecial123"))


def test_register_request_rejects_too_short() -> None:
    with pytest.raises(ValidationError, match="at least 8 characters"):
        RegisterRequest(**_register_kwargs("Sh0rt!"))


def test_register_request_accepts_compliant_password() -> None:
    req = RegisterRequest(**_register_kwargs(_COMPLIANT_PASSWORD))
    assert req.password == _COMPLIANT_PASSWORD


@pytest.mark.asyncio
async def test_register_endpoint_rejects_weak_password_with_422(
    client: AsyncClient,
) -> None:
    res = await client.post(
        "/api/v1/auth/register",
        json=_register_kwargs("lowercase123!") | {"email": "weakpw_endpoint@example.com"},
    )
    assert res.status_code == 422, res.text
    assert "uppercase" in res.text


# ─── Schema-level: ChangePasswordRequest.new_password ──────────────────────


def test_change_password_request_rejects_missing_uppercase() -> None:
    with pytest.raises(ValidationError, match="uppercase"):
        ChangePasswordRequest(current_password="whatever", new_password="lowercase123!")


def test_change_password_request_rejects_missing_digit() -> None:
    with pytest.raises(ValidationError, match="digit"):
        ChangePasswordRequest(current_password="whatever", new_password="NoDigitsHere!")


def test_change_password_request_rejects_missing_special() -> None:
    with pytest.raises(ValidationError, match="special character"):
        ChangePasswordRequest(current_password="whatever", new_password="NoSpecial123")


def test_change_password_request_rejects_too_short() -> None:
    with pytest.raises(ValidationError, match="at least 8 characters"):
        ChangePasswordRequest(current_password="whatever", new_password="Sh0rt!")


def test_change_password_request_accepts_compliant_password() -> None:
    req = ChangePasswordRequest(current_password="whatever", new_password=_COMPLIANT_PASSWORD)
    assert req.new_password == _COMPLIANT_PASSWORD


@pytest.mark.asyncio
async def test_change_password_endpoint_rejects_weak_new_password_with_422(
    client: AsyncClient, chw_tokens: dict
) -> None:
    res = await client.post(
        "/api/v1/auth/change-password",
        json={"current_password": _COMPLIANT_PASSWORD, "new_password": "nouppercase123!"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text
    assert "uppercase" in res.text


# ─── Schema-level: CHWCreateMemberRequest.temp_password ────────────────────


def _chw_create_member_kwargs(temp_password: str) -> dict:
    return {
        "email": "new_member_schema@example.com",
        "temp_password": temp_password,
        "name": "New Member",
        "date_of_birth": "1990-01-01",
        "gender": "Female",
        "insurance_company": "Health Net",
        "medi_cal_id": "91234567A",
        "zip_code": "90001",
        "terms_accepted": True,
        "communications_consent": True,
    }


def test_chw_create_member_request_rejects_missing_uppercase() -> None:
    with pytest.raises(ValidationError, match="uppercase"):
        CHWCreateMemberRequest(**_chw_create_member_kwargs("lowercase123!"))


def test_chw_create_member_request_rejects_missing_digit() -> None:
    with pytest.raises(ValidationError, match="digit"):
        CHWCreateMemberRequest(**_chw_create_member_kwargs("NoDigitsHere!"))


def test_chw_create_member_request_rejects_missing_special() -> None:
    with pytest.raises(ValidationError, match="special character"):
        CHWCreateMemberRequest(**_chw_create_member_kwargs("NoSpecial123"))


def test_chw_create_member_request_rejects_too_short() -> None:
    with pytest.raises(ValidationError, match="at least 8 characters"):
        CHWCreateMemberRequest(**_chw_create_member_kwargs("Sh0rt!"))


def test_chw_create_member_request_accepts_compliant_password() -> None:
    req = CHWCreateMemberRequest(**_chw_create_member_kwargs(_COMPLIANT_PASSWORD))
    assert req.temp_password == _COMPLIANT_PASSWORD


@pytest.mark.asyncio
async def test_chw_members_endpoint_rejects_weak_temp_password_with_422(
    client: AsyncClient, chw_tokens: dict
) -> None:
    res = await client.post(
        "/api/v1/chw/members",
        json=_chw_create_member_kwargs("nouppercase123!")
        | {"email": "weak_temp_pw@example.com"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text
    assert "uppercase" in res.text
