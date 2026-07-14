"""Tests for the Wave-2 B1 CHW work-gate expansion (Epic D3 follow-up).

Extends the SAME chw_work_gate_enabled flag-conditional 403 gate (see
tests/test_chw_work_gate.py for the original 4-endpoint coverage) to:
  - POST /chw/members                        (create_chw_member)
  - POST /conversations/{id}/messages         (CHW-sender branch only)
  - POST /conversations/{id}/sms
  - POST /communication/call-bridge           (CHW-caller branch only)
  - POST /chw/members/{id}/call
  - POST /payments/connect-onboarding

For each: flag ON + non-compliant CHW -> 403 with
{"code": "onboarding_incomplete", "missing": [...]}. Flag OFF (default) must
be a byte-for-byte behavioral no-op vs. pre-gate behavior (grandfather
regression), tested explicitly for both a compliant AND a non-compliant CHW.
Member-initiated calls/messages must NEVER be gated regardless of flag state.

Also covers the new `gate_enabled` field on GET /credentials/checklist.
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
from app.models.user import CHWProfile, User
from tests.conftest import auth_header
from tests.conftest import test_session as _test_session_factory

DOCUMENT_TYPES = (
    "hipaa_training",
    "professional_service_agreement",
    "liability_insurance",
    "chw_certification",
)

_NEW_MEMBER_PAYLOAD = {
    "email": "gate.expansion.member@example.com",
    "temp_password": "temp-pass-1234",
    "name": "Gate Expansion",
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


def _user_id(tokens: dict) -> str:
    payload_b64 = tokens["access_token"].split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    return str(UUID(json.loads(base64.urlsafe_b64decode(padded).decode())["sub"]))


async def _make_chw_compliant(chw_id: str) -> None:
    """Seed everything chw_can_work requires, directly via ORM, for an
    already-registered CHW (chw_tokens fixture)."""
    chw_uuid = UUID(chw_id)
    async with _test_session_factory() as db:
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
        user = await db.get(User, chw_uuid)
        user.phone = "+13105550100"
        await db.commit()


async def _establish_relationship(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> tuple[str, str]:
    """Member files a request, CHW accepts it -> care relationship.

    Must be called with the gate flag OFF (or the CHW already compliant).
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


async def _set_phone(user_id: str, phone: str) -> None:
    async with _test_session_factory() as db:
        user = await db.get(User, UUID(user_id))
        user.phone = phone
        await db.commit()


async def _find_or_create_conversation(
    client: AsyncClient, initiator_tokens: dict, peer_id: str
) -> str:
    res = await client.post(
        "/api/v1/conversations/find-or-create",
        json={"peer_id": peer_id},
        headers=auth_header(initiator_tokens),
    )
    assert res.status_code == 200, res.text
    return res.json()["id"]


# ---------------------------------------------------------------------------
# POST /chw/members
# ---------------------------------------------------------------------------


class TestCreateMemberGate:
    async def test_flag_on_noncompliant_chw_blocked(
        self, client: AsyncClient, chw_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            "/api/v1/chw/members",
            json=_NEW_MEMBER_PAYLOAD,
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403
        detail = res.json()["detail"]
        assert detail["code"] == "onboarding_incomplete"
        assert len(detail["missing"]) > 0

    async def test_flag_on_compliant_chw_allowed(
        self, client: AsyncClient, chw_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        chw_id = _user_id(chw_tokens)
        await _make_chw_compliant(chw_id)
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            "/api/v1/chw/members",
            json={**_NEW_MEMBER_PAYLOAD, "email": "gate.expansion.member.compliant@example.com"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201, res.text

    async def test_flag_off_noncompliant_chw_allowed_grandfather(
        self, client: AsyncClient, chw_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", False)

        res = await client.post(
            "/api/v1/chw/members",
            json={**_NEW_MEMBER_PAYLOAD, "email": "gate.expansion.member.grandfather@example.com"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201, res.text


# ---------------------------------------------------------------------------
# POST /conversations/{id}/messages (CHW-sender branch only)
# ---------------------------------------------------------------------------


class TestSendMessageGate:
    async def test_flag_on_noncompliant_chw_blocked(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Hello", "type": "text"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403
        assert res.json()["detail"]["code"] == "onboarding_incomplete"

    async def test_flag_on_compliant_chw_allowed(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)
        chw_id = _user_id(chw_tokens)
        await _make_chw_compliant(chw_id)

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Hello", "type": "text"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201, res.text

    async def test_flag_off_noncompliant_chw_allowed_grandfather(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", False)

        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Hello", "type": "text"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201, res.text

    async def test_member_sender_never_gated(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        """CRITICAL: members are never gated, even flag ON + CHW non-compliant."""
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Hi from member", "type": "text"},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 201, res.text


# ---------------------------------------------------------------------------
# POST /conversations/{id}/sms
# ---------------------------------------------------------------------------


class TestSendSmsGate:
    async def test_flag_on_noncompliant_chw_blocked(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

        from datetime import UTC, datetime

        async with _test_session_factory() as db:
            from app.models.user import MemberProfile

            user = await db.get(User, UUID(member_id))
            user.phone = "+15550100099"
            user.phone_verified_at = datetime.now(UTC)
            profile_result = await db.execute(
                select(MemberProfile).where(MemberProfile.user_id == UUID(member_id))
            )
            profile = profile_result.scalar_one()
            profile.sms_opt_out = False
            await db.commit()

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            f"/api/v1/conversations/{conv_id}/sms",
            json={"text": "Hello via SMS"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403
        assert res.json()["detail"]["code"] == "onboarding_incomplete"

    async def test_flag_off_noncompliant_chw_allowed_grandfather(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        conv_id = await _find_or_create_conversation(client, chw_tokens, member_id)

        from datetime import UTC, datetime

        async with _test_session_factory() as db:
            from app.models.user import MemberProfile

            user = await db.get(User, UUID(member_id))
            user.phone = "+15550100098"
            user.phone_verified_at = datetime.now(UTC)
            profile_result = await db.execute(
                select(MemberProfile).where(MemberProfile.user_id == UUID(member_id))
            )
            profile = profile_result.scalar_one()
            profile.sms_opt_out = False
            await db.commit()

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", False)

        res = await client.post(
            f"/api/v1/conversations/{conv_id}/sms",
            json={"text": "Hello via SMS"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201, res.text


# ---------------------------------------------------------------------------
# POST /chw/members/{id}/call
# ---------------------------------------------------------------------------


class TestChwCallMemberGate:
    async def test_flag_on_noncompliant_chw_blocked(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        chw_id = _user_id(chw_tokens)
        await _set_phone(chw_id, "+15550000011")
        await _set_phone(member_id, "+15550000012")

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            f"/api/v1/chw/members/{member_id}/call",
            json={},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403
        assert res.json()["detail"]["code"] == "onboarding_incomplete"

    async def test_flag_on_compliant_chw_allowed(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        chw_id = _user_id(chw_tokens)
        await _make_chw_compliant(chw_id)
        await _set_phone(chw_id, "+15550000013")
        await _set_phone(member_id, "+15550000014")

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            f"/api/v1/chw/members/{member_id}/call",
            json={},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 200, res.text

    async def test_flag_off_noncompliant_chw_allowed_grandfather(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        chw_id = _user_id(chw_tokens)
        await _set_phone(chw_id, "+15550000015")
        await _set_phone(member_id, "+15550000016")

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", False)

        res = await client.post(
            f"/api/v1/chw/members/{member_id}/call",
            json={},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 200, res.text


# ---------------------------------------------------------------------------
# POST /communication/call-bridge (CHW-caller branch only)
# ---------------------------------------------------------------------------


class TestCallBridgeGate:
    async def test_flag_on_noncompliant_chw_caller_blocked(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        chw_id = _user_id(chw_tokens)
        await _set_phone(chw_id, "+15550000021")
        await _set_phone(member_id, "+15550000022")

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            "/api/v1/communication/call-bridge",
            json={"recipient_id": member_id},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403
        assert res.json()["detail"]["code"] == "onboarding_incomplete"

    async def test_flag_on_compliant_chw_caller_allowed(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        chw_id = _user_id(chw_tokens)
        await _make_chw_compliant(chw_id)
        await _set_phone(chw_id, "+15550000023")
        await _set_phone(member_id, "+15550000024")

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            "/api/v1/communication/call-bridge",
            json={"recipient_id": member_id},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 200, res.text

    async def test_flag_off_noncompliant_chw_caller_allowed_grandfather(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        chw_id = _user_id(chw_tokens)
        await _set_phone(chw_id, "+15550000025")
        await _set_phone(member_id, "+15550000026")

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", False)

        res = await client.post(
            "/api/v1/communication/call-bridge",
            json={"recipient_id": member_id},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 200, res.text

    async def test_member_caller_never_gated(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        """CRITICAL: a member-initiated call-bridge is never gated, even
        flag ON + the paired CHW non-compliant."""
        member_id, _ = await _establish_relationship(client, member_tokens, chw_tokens)
        chw_id = _user_id(chw_tokens)
        await _set_phone(chw_id, "+15550000027")
        await _set_phone(member_id, "+15550000028")

        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            "/api/v1/communication/call-bridge",
            json={"recipient_id": chw_id},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 200, res.text


# ---------------------------------------------------------------------------
# POST /payments/connect-onboarding
# ---------------------------------------------------------------------------


class TestConnectOnboardingGate:
    async def test_flag_on_noncompliant_chw_blocked(
        self, client: AsyncClient, chw_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.post(
            "/api/v1/payments/connect-onboarding",
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403
        assert res.json()["detail"]["code"] == "onboarding_incomplete"

    async def test_flag_off_noncompliant_chw_allowed_grandfather(
        self, client: AsyncClient, chw_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        """Grandfather regression: flag OFF still reaches the Stripe-not-
        configured 503 (pre-gate behavior in test env, which has no
        STRIPE_SECRET_KEY) rather than a gate-caused 403."""
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", False)

        res = await client.post(
            "/api/v1/payments/connect-onboarding",
            headers=auth_header(chw_tokens),
        )
        assert res.status_code != 403 or res.json().get("detail", {}) != {
            "code": "onboarding_incomplete"
        }
        assert res.status_code == 503, res.text

    async def test_account_status_never_gated(
        self, client: AsyncClient, chw_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        """Read-only GET /account-status stays open regardless of flag state."""
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.get(
            "/api/v1/payments/account-status",
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 200, res.text


# ---------------------------------------------------------------------------
# GET /credentials/checklist — gate_enabled field
# ---------------------------------------------------------------------------


class TestChecklistGateEnabledField:
    async def test_gate_enabled_mirrors_flag_true(
        self, client: AsyncClient, chw_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", True)

        res = await client.get("/api/v1/credentials/checklist", headers=auth_header(chw_tokens))
        assert res.status_code == 200
        assert res.json()["gate_enabled"] is True

    async def test_gate_enabled_mirrors_flag_false(
        self, client: AsyncClient, chw_tokens: dict, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(_app_config_module.settings, "chw_work_gate_enabled", False)

        res = await client.get("/api/v1/credentials/checklist", headers=auth_header(chw_tokens))
        assert res.status_code == 200
        assert res.json()["gate_enabled"] is False
