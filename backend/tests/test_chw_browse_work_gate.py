"""Epic D follow-up: Find-a-CHW browse (and auto-match) must not surface CHWs
who can't work, when the work gate is enabled.

Covers:
  - GET /api/v1/chw/browse
  - GET /api/v1/matching/chws

For each: flag ON -> a non-compliant CHW is absent from results, a compliant
CHW is present. Flag OFF (default) must be a byte-for-byte no-op vs. pre-gate
behavior — both a compliant AND a non-compliant CHW still appear. This is the
"grandfather regression" TESTING.md calls out as critical.

Reuses the `_make_chw_compliant` seeding helper and the
`monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", ...)`
pattern from tests/test_chw_work_gate.py.
"""

from __future__ import annotations

import base64
import json
from uuid import UUID

import pytest
from httpx import AsyncClient

import app.config as _app_config_module
from app.models.credential import Credential
from app.models.user import CHWProfile
from tests.conftest import test_session as _test_session_factory

DOCUMENT_TYPES = (
    "hipaa_training",
    "professional_service_agreement",
    "liability_insurance",
    "chw_certification",
)


def _user_id(tokens: dict) -> str:
    payload_b64 = tokens["access_token"].split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    return str(UUID(json.loads(base64.urlsafe_b64decode(padded).decode())["sub"]))


def _auth_header(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


async def _register_chw(client: AsyncClient, *, email: str, name: str) -> dict:
    res = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "testpass123", "name": name, "role": "chw"},
    )
    assert res.status_code == 201, res.text
    return res.json()


async def _register_member(client: AsyncClient, *, email: str) -> dict:
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "testpass123",
            "name": "Test Member",
            "role": "member",
            "phone": "+13105550100",
            "date_of_birth": "1993-01-05",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": "12345678A",
            "address_line1": "1 Main St",
            "city": "Los Angeles",
            "state": "CA",
            "zip_code": "90001",
            "terms_accepted": True,
            "communications_consent": True,
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


async def _make_chw_compliant(chw_id: str) -> None:
    """Seed everything chw_can_work requires, directly via ORM, for an
    already-registered CHW. Mirrors tests/test_chw_work_gate.py's helper."""
    chw_uuid = UUID(chw_id)
    async with _test_session_factory() as db:
        from sqlalchemy import select

        result = await db.execute(select(CHWProfile).where(CHWProfile.user_id == chw_uuid))
        profile = result.scalar_one()
        profile.zip_code = "90001"
        profile.bio = "Community health worker with 5 years of experience."
        profile.background_check_status = "clear"
        for cred_type in DOCUMENT_TYPES:
            db.add(
                Credential(
                    chw_id=chw_uuid,
                    type=cred_type,
                    label=cred_type,
                    status="verified",
                )
            )
        await db.commit()

    async with _test_session_factory() as db:
        from app.models.user import User

        user = await db.get(User, chw_uuid)
        user.phone = "+13105550100"
        await db.commit()


# ---------------------------------------------------------------------------
# GET /api/v1/chw/browse
# ---------------------------------------------------------------------------


class TestBrowseChwsWorkGate:
    async def test_flag_on_noncompliant_chw_absent_compliant_chw_present(
        self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        compliant_tokens = await _register_chw(
            client, email="compliant.browse@example.com", name="Compliant CHW"
        )
        noncompliant_tokens = await _register_chw(
            client, email="noncompliant.browse@example.com", name="Noncompliant CHW"
        )
        await _make_chw_compliant(_user_id(compliant_tokens))
        member_tokens = await _register_member(client, email="member.browse1@example.com")

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.get("/api/v1/chw/browse", headers=_auth_header(member_tokens))
        assert res.status_code == 200, res.text
        returned_user_ids = {row["user_id"] for row in res.json()}

        assert _user_id(compliant_tokens) in returned_user_ids
        assert _user_id(noncompliant_tokens) not in returned_user_ids

    async def test_flag_off_noncompliant_chw_still_present_grandfather(
        self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        """CRITICAL grandfather regression test: flag OFF (default) must
        behave EXACTLY as before this change — a non-compliant CHW (the
        default state of every freshly registered CHW) must still appear in
        browse results."""
        noncompliant_tokens = await _register_chw(
            client, email="noncompliant.browse2@example.com", name="Noncompliant CHW"
        )
        member_tokens = await _register_member(client, email="member.browse2@example.com")

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", False)

        res = await client.get("/api/v1/chw/browse", headers=_auth_header(member_tokens))
        assert res.status_code == 200, res.text
        returned_user_ids = {row["user_id"] for row in res.json()}

        assert _user_id(noncompliant_tokens) in returned_user_ids


# ---------------------------------------------------------------------------
# GET /api/v1/matching/chws (auto-match candidate selection)
# ---------------------------------------------------------------------------


class TestFindMatchingChwsWorkGate:
    async def test_flag_on_noncompliant_chw_absent_compliant_chw_present(
        self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        compliant_tokens = await _register_chw(
            client, email="compliant.match@example.com", name="Compliant CHW"
        )
        noncompliant_tokens = await _register_chw(
            client, email="noncompliant.match@example.com", name="Noncompliant CHW"
        )
        await _make_chw_compliant(_user_id(compliant_tokens))
        member_tokens = await _register_member(client, email="member.match1@example.com")

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.get(
            "/api/v1/matching/chws",
            params={"vertical": "housing"},
            headers=_auth_header(member_tokens),
        )
        assert res.status_code == 200, res.text
        returned_chw_ids = {m["chw_id"] for m in res.json()["matches"]}

        assert _user_id(compliant_tokens) in returned_chw_ids
        assert _user_id(noncompliant_tokens) not in returned_chw_ids

    async def test_flag_off_noncompliant_chw_still_present_grandfather(
        self, client: AsyncClient, monkeypatch: pytest.MonkeyPatch
    ):
        """CRITICAL grandfather regression test: flag OFF (default) must
        behave EXACTLY as before this change — a non-compliant CHW must still
        be a candidate in auto-match results."""
        noncompliant_tokens = await _register_chw(
            client, email="noncompliant.match2@example.com", name="Noncompliant CHW"
        )
        member_tokens = await _register_member(client, email="member.match2@example.com")

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", False)

        res = await client.get(
            "/api/v1/matching/chws",
            params={"vertical": "housing"},
            headers=_auth_header(member_tokens),
        )
        assert res.status_code == 200, res.text
        returned_chw_ids = {m["chw_id"] for m in res.json()["matches"]}

        assert _user_id(noncompliant_tokens) in returned_chw_ids
