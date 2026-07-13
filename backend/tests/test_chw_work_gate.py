"""Tests for the Epic D3 feature-flagged CHW work gate.

Covers the 4 gated endpoints:
  - PATCH /requests/{id}/accept
  - POST  /sessions/            (legacy create)
  - POST  /sessions/schedule
  - PATCH /sessions/{id}/start

For each: flag ON + non-compliant CHW -> 403 with
{"code": "onboarding_incomplete", "missing": [...]}. Flag OFF (default) must
be a byte-for-byte behavioral no-op vs. pre-gate behavior — this is the
"grandfather regression" the epic calls out as critical, tested explicitly
for both a compliant AND a non-compliant CHW.

`chw_tokens`/`member_tokens` fixtures (conftest.py) register via the public
API, which produces a CHW with NO compliance data at all (no zip, no bio, no
credentials, background_check_status defaults to "pending" per Epic D) — so
they are non-compliant by construction and perfect for the "blocked" side of
every test. A `_make_chw_compliant` helper seeds the missing pieces directly
via ORM for the "flag on but compliant -> allowed" side.
"""

from __future__ import annotations

import base64
import json
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select

import app.config as _app_config_module
from app.models.credential import Credential
from app.models.user import CHWProfile
from tests.conftest import auth_header
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


async def _make_chw_compliant(chw_id: str) -> None:
    """Seed everything chw_can_work requires, directly via ORM, for an
    already-registered CHW (chw_tokens fixture)."""
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


async def _establish_relationship(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> tuple[str, str]:
    """Member files a request, CHW accepts it -> care relationship.

    Must be called with the gate flag OFF (or the CHW already compliant) —
    accept_request is itself gated, so tests that need a relationship AND
    want to test a downstream endpoint (schedule/start) with an
    otherwise-non-compliant CHW must establish the relationship first, then
    revoke compliance afterward if needed.
    """
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Need help",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]
    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    return _user_id(member_tokens), request_id


# ---------------------------------------------------------------------------
# PATCH /requests/{id}/accept
# ---------------------------------------------------------------------------


class TestAcceptRequestGate:
    async def test_flag_on_noncompliant_chw_blocked(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            "/api/v1/requests/",
            json={
                "vertical": "housing",
                "urgency": "routine",
                "description": "Need help",
                "preferred_mode": "in_person",
            },
            headers=auth_header(member_tokens),
        )
        request_id = res.json()["id"]

        res = await client.patch(
            f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
        )
        assert res.status_code == 403
        detail = res.json()["detail"]
        assert detail["code"] == "onboarding_incomplete"
        assert isinstance(detail["missing"], list)
        assert len(detail["missing"]) > 0

    async def test_flag_on_compliant_chw_allowed(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        chw_id = _user_id(chw_tokens)
        await _make_chw_compliant(chw_id)
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            "/api/v1/requests/",
            json={
                "vertical": "housing",
                "urgency": "routine",
                "description": "Need help",
                "preferred_mode": "in_person",
            },
            headers=auth_header(member_tokens),
        )
        request_id = res.json()["id"]

        res = await client.patch(
            f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
        )
        assert res.status_code == 200

    async def test_flag_off_noncompliant_chw_allowed_grandfather(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        """CRITICAL grandfather regression test: flag OFF (default) must
        behave EXACTLY as before this epic — a non-compliant CHW (the default
        state of the chw_tokens fixture) must still succeed."""
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", False)

        res = await client.post(
            "/api/v1/requests/",
            json={
                "vertical": "housing",
                "urgency": "routine",
                "description": "Need help",
                "preferred_mode": "in_person",
            },
            headers=auth_header(member_tokens),
        )
        request_id = res.json()["id"]

        res = await client.patch(
            f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
        )
        assert res.status_code == 200
        assert res.json()["status"] == "matched"


# ---------------------------------------------------------------------------
# POST /sessions/schedule
# ---------------------------------------------------------------------------


class TestScheduleSessionGate:
    async def test_flag_on_noncompliant_chw_blocked(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        # Establish relationship first with the flag OFF so accept_request succeeds.
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            "/api/v1/sessions/schedule",
            json={
                "member_id": member_id,
                "scheduled_at": "2026-08-01T17:00:00Z",
                "mode": "phone",
                "scheduling_status": "confirmed",
            },
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403
        detail = res.json()["detail"]
        assert detail["code"] == "onboarding_incomplete"

    async def test_flag_on_compliant_chw_allowed(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        chw_id = _user_id(chw_tokens)
        await _make_chw_compliant(chw_id)

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            "/api/v1/sessions/schedule",
            json={
                "member_id": member_id,
                "scheduled_at": "2026-08-01T17:00:00Z",
                "mode": "phone",
                "scheduling_status": "confirmed",
            },
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201

    async def test_flag_off_noncompliant_chw_allowed_grandfather(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", False)

        res = await client.post(
            "/api/v1/sessions/schedule",
            json={
                "member_id": member_id,
                "scheduled_at": "2026-08-01T17:00:00Z",
                "mode": "phone",
                "scheduling_status": "confirmed",
            },
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201


# ---------------------------------------------------------------------------
# POST /sessions/ (legacy create)
# ---------------------------------------------------------------------------


class TestLegacyCreateSessionGate:
    async def test_flag_on_noncompliant_chw_blocked(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        _, request_id = await _establish_relationship(client, member_tokens, chw_tokens)

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            "/api/v1/sessions/",
            json={
                "request_id": request_id,
                "scheduled_at": "2026-08-02T17:00:00Z",
                "mode": "phone",
            },
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403
        detail = res.json()["detail"]
        assert detail["code"] == "onboarding_incomplete"

    async def test_flag_on_compliant_chw_allowed(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        _, request_id = await _establish_relationship(client, member_tokens, chw_tokens)
        chw_id = _user_id(chw_tokens)
        await _make_chw_compliant(chw_id)

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            "/api/v1/sessions/",
            json={
                "request_id": request_id,
                "scheduled_at": "2026-08-02T17:00:00Z",
                "mode": "phone",
            },
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201

    async def test_flag_off_noncompliant_chw_allowed_grandfather(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        _, request_id = await _establish_relationship(client, member_tokens, chw_tokens)
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", False)

        res = await client.post(
            "/api/v1/sessions/",
            json={
                "request_id": request_id,
                "scheduled_at": "2026-08-02T17:00:00Z",
                "mode": "phone",
            },
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201


# ---------------------------------------------------------------------------
# PATCH /sessions/{id}/start
# ---------------------------------------------------------------------------


class TestStartSessionGate:
    async def _create_scheduled_session(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> str:
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        res = await client.post(
            "/api/v1/sessions/schedule",
            json={
                "member_id": member_id,
                "scheduled_at": "2026-08-03T17:00:00Z",
                "mode": "phone",
                "scheduling_status": "confirmed",
            },
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201, res.text
        return res.json()["id"]

    async def test_flag_on_noncompliant_chw_blocked(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        session_id = await self._create_scheduled_session(client, chw_tokens, member_tokens)

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.patch(
            f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens)
        )
        assert res.status_code == 403
        detail = res.json()["detail"]
        assert detail["code"] == "onboarding_incomplete"

    async def test_flag_on_compliant_chw_allowed(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        session_id = await self._create_scheduled_session(client, chw_tokens, member_tokens)
        chw_id = _user_id(chw_tokens)
        await _make_chw_compliant(chw_id)

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.patch(
            f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens)
        )
        assert res.status_code == 200
        assert res.json()["status"] == "in_progress"

    async def test_flag_off_noncompliant_chw_allowed_grandfather(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        session_id = await self._create_scheduled_session(client, chw_tokens, member_tokens)
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", False)

        res = await client.patch(
            f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens)
        )
        assert res.status_code == 200
        assert res.json()["status"] == "in_progress"


# ---------------------------------------------------------------------------
# Default flag value
# ---------------------------------------------------------------------------


class TestDefaultFlagValue:
    def test_flag_defaults_to_false(self):
        """Config-level regression guard: chw_work_gate_enabled must default
        False so existing deployments are unaffected until explicitly
        opted in."""
        from app.config import Settings

        # Constructing with only the two genuinely-required fields (no .env
        # dependency) confirms the class-level default independent of
        # whatever .env/environment this test run happens to have.
        assert Settings.model_fields["chw_work_gate_enabled"].default is False


# ─── Self-write lockdown (the gate's integrity depends on it) ─────────────────
#
# Before Epic D's integration, PATCH/PUT /chw/profile accepted
# background_check_status / hipaa_training_completed / chw_certification from
# the CHW's own payload — meaning a CHW could self-write "clear" and bypass
# chw_can_work entirely. The fields were removed from CHWProfileUpdate; these
# tests pin that the values can no longer reach the DB from the self-service
# route (pydantic drops the unknown keys, the rest of the update still works).


@pytest.mark.asyncio
async def test_chw_cannot_self_clear_background_check_via_profile_update(
    client: AsyncClient, chw_tokens: dict
):
    chw_id = _user_id(chw_tokens)

    res = await client.put(
        "/api/v1/chw/profile",
        json={
            "bio": "Legit bio update.",
            "background_check_status": "clear",
            "hipaa_training_completed": True,
            "chw_certification": "SELF-ATTESTED-999",
        },
        headers=auth_header(chw_tokens),
    )
    # The request itself succeeds (unknown fields are ignored, the legitimate
    # bio edit applies) — but none of the compliance fields may change.
    assert res.status_code == 200, res.text

    async with _test_session_factory() as session:
        result = await session.execute(
            select(CHWProfile).where(CHWProfile.user_id == UUID(chw_id))
        )
        profile = result.scalar_one()
        assert profile.bio == "Legit bio update."
        assert profile.background_check_status != "clear", (
            "CHW must NOT be able to self-write background_check_status "
            "via the profile route — that bypasses the work gate"
        )
        assert profile.hipaa_training_completed is not True
        assert profile.chw_certification != "SELF-ATTESTED-999"


@pytest.mark.asyncio
async def test_self_cleared_payload_does_not_unlock_the_work_gate(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch
):
    """End-to-end: even after POSTing a 'clear' payload to the profile route,
    the gate still blocks (flag ON) — proving the bypass is closed at the
    behavior level, not just the column level."""
    monkeypatch.setattr(
        _app_config_module.settings, "chw_work_gate_enabled", True
    )

    await client.put(
        "/api/v1/chw/profile",
        json={"background_check_status": "clear"},
        headers=auth_header(chw_tokens),
    )

    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "food",
            "urgency": "routine",
            "description": "gate bypass attempt check",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 403, (
        f"Gate must still block after a self-clear attempt, got {res.status_code}: {res.text}"
    )
    assert res.json()["detail"]["code"] == "onboarding_incomplete"
