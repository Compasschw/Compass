"""Tests for T03: Member-controlled Services Consent toggle + 403 gates.

Covers:
1. PATCH /services-consent flips status + stamps changed_at + changed_by
2. GET /services-consent returns the current state
3. call-bridge returns 403 when target member has refuse_services
4. message send (sessions + conversations) returns 403 when refuse_services
5. request accept returns 403 when requesting member has refuse_services
6. Reverting refuse_services -> consent_to_services re-enables call-bridge
7. PATCH /member/profile/insurance-cin updates fields + normalizes CIN
8. CIN format violation returns 422

Unit tests (no DB) for the schema validators also run here so they pass
even when local Postgres is down.
"""
import pytest
from httpx import AsyncClient

from tests.conftest import auth_header, complete_member_signup_payload


# ─── Schema-level unit tests (no DB, always run) ──────────────────────────────

class TestServicesConsentSchema:
    """Pydantic-level validation — no DB required."""

    def test_valid_consent_status(self):
        from app.schemas.member import ServicesConsentUpdate

        update = ServicesConsentUpdate(status="consent_to_services")
        assert update.status == "consent_to_services"

        update2 = ServicesConsentUpdate(status="refuse_services")
        assert update2.status == "refuse_services"

    def test_invalid_consent_status_raises(self):
        from pydantic import ValidationError

        from app.schemas.member import ServicesConsentUpdate

        with pytest.raises(ValidationError):
            ServicesConsentUpdate(status="maybe_services")

    def test_cin_valid_lowercase_normalized(self):
        from app.schemas.member import InsuranceCINUpdate

        obj = InsuranceCINUpdate(insurance_company="Health Net", medi_cal_id="12345678a")
        assert obj.medi_cal_id == "12345678A"

    def test_cin_valid_uppercase_passthrough(self):
        from app.schemas.member import InsuranceCINUpdate

        obj = InsuranceCINUpdate(insurance_company="Medi-Cal", medi_cal_id="99999999Z")
        assert obj.medi_cal_id == "99999999Z"

    def test_cin_too_short_raises(self):
        from pydantic import ValidationError

        from app.schemas.member import InsuranceCINUpdate

        with pytest.raises(ValidationError):
            InsuranceCINUpdate(insurance_company="Health Net", medi_cal_id="1234567A")

    def test_cin_missing_letter_raises(self):
        from pydantic import ValidationError

        from app.schemas.member import InsuranceCINUpdate

        with pytest.raises(ValidationError):
            InsuranceCINUpdate(insurance_company="Health Net", medi_cal_id="123456789")

    def test_cin_too_many_letters_raises(self):
        from pydantic import ValidationError

        from app.schemas.member import InsuranceCINUpdate

        with pytest.raises(ValidationError):
            InsuranceCINUpdate(insurance_company="Health Net", medi_cal_id="1234567AB")


# ─── Guard helper unit test ────────────────────────────────────────────────────

class TestAssertMemberConsentsToServices:
    """Unit-test the guard helper with a mock DB session."""

    async def test_raises_403_when_refused(self):
        """assert_member_consents_to_services raises HTTP 403 for refuse_services."""
        import uuid
        from unittest.mock import AsyncMock, MagicMock

        from fastapi import HTTPException

        from app.services.relationship_guards import assert_member_consents_to_services

        member_id = uuid.uuid4()

        # Mock the DB execute chain: scalar_one_or_none returns "refuse_services"
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = "refuse_services"
        mock_db = AsyncMock()
        mock_db.execute.return_value = mock_result

        with pytest.raises(HTTPException) as exc_info:
            await assert_member_consents_to_services(mock_db, member_id=member_id)

        assert exc_info.value.status_code == 403
        detail = exc_info.value.detail
        assert detail["code"] == "MEMBER_REFUSED_SERVICES"

    async def test_passes_when_consented(self):
        """assert_member_consents_to_services does NOT raise for consent_to_services."""
        import uuid
        from unittest.mock import AsyncMock, MagicMock

        from app.services.relationship_guards import assert_member_consents_to_services

        member_id = uuid.uuid4()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = "consent_to_services"
        mock_db = AsyncMock()
        mock_db.execute.return_value = mock_result

        # Should not raise
        await assert_member_consents_to_services(mock_db, member_id=member_id)

    async def test_passes_when_no_profile(self):
        """assert_member_consents_to_services does NOT raise when profile is missing."""
        import uuid
        from unittest.mock import AsyncMock, MagicMock

        from app.services.relationship_guards import assert_member_consents_to_services

        member_id = uuid.uuid4()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_db = AsyncMock()
        mock_db.execute.return_value = mock_result

        # Should not raise
        await assert_member_consents_to_services(mock_db, member_id=member_id)


# ─── Integration tests (require Postgres) ─────────────────────────────────────

pytestmark = pytest.mark.asyncio


async def _register_member(
    client: AsyncClient,
    *,
    email: str = "member@example.com",
) -> dict:
    """Register a full member and return the token response."""
    payload = complete_member_signup_payload(email=email)
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, f"Member register failed: {res.text}"
    return res.json()


async def _register_chw(
    client: AsyncClient,
    *,
    email: str = "chw@example.com",
) -> dict:
    """Register a CHW and return the token response."""
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "testpass123",
            "name": "Test CHW",
            "role": "chw",
        },
    )
    assert res.status_code == 201, f"CHW register failed: {res.text}"
    return res.json()


async def _create_open_request(client: AsyncClient, member_tokens: dict) -> str:
    """Create an open service request as the given member. Return request_id."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Need housing assistance.",
            "preferred_mode": "phone",
            "estimated_units": 1,
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, f"Create request failed: {res.text}"
    return res.json()["id"]


async def _chw_accept_request(
    client: AsyncClient, chw_tokens: dict, request_id: str
) -> dict:
    """CHW accepts the request. Returns the JSON body."""
    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Accept failed: {res.text}"
    return res.json()


async def _set_consent(
    client: AsyncClient, member_tokens: dict, status: str
) -> None:
    """PATCH the member's services-consent to the given status."""
    res = await client.patch(
        "/api/v1/member/services-consent",
        json={"status": status},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, f"Set consent failed: {res.text}"


class TestGetServicesConsent:
    """GET /api/v1/member/services-consent"""

    async def test_default_is_consent_to_services(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Freshly registered member should default to consent_to_services."""
        res = await client.get(
            "/api/v1/member/services-consent",
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["status"] == "consent_to_services"
        assert body["changed_at"] is None
        assert body["changed_by"] is None

    async def test_requires_auth(self, client: AsyncClient):
        """Unauthenticated request should return 401/403."""
        res = await client.get("/api/v1/member/services-consent")
        assert res.status_code in (401, 403)

    async def test_chw_requires_member_id(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """A CHW must specify whose consent to read; omitting member_id is 422.

        The endpoint now serves the CHW Messages rail / Member Profile widget, so
        CHW callers are allowed — but only for a specific, related member.
        """
        res = await client.get(
            "/api/v1/member/services-consent",
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 422, res.text

    async def test_chw_unrelated_member_forbidden(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """A CHW with no shared session with the member gets 403 (relationship gate)."""
        unrelated_member_id = "00000000-0000-0000-0000-0000000000ab"
        res = await client.get(
            f"/api/v1/member/services-consent?member_id={unrelated_member_id}",
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403, res.text


class TestUpdateServicesConsent:
    """PATCH /api/v1/member/services-consent"""

    async def test_flip_to_refuse_services(
        self, client: AsyncClient, member_tokens: dict
    ):
        """PATCH flips status to refuse_services, stamps changed_at and changed_by."""
        res = await client.patch(
            "/api/v1/member/services-consent",
            json={"status": "refuse_services"},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["status"] == "refuse_services"
        assert body["changed_at"] is not None
        assert body["changed_by"] is not None

    async def test_flip_back_to_consent(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Reverting to consent_to_services preserves changed_at + changed_by."""
        await client.patch(
            "/api/v1/member/services-consent",
            json={"status": "refuse_services"},
            headers=auth_header(member_tokens),
        )
        res = await client.patch(
            "/api/v1/member/services-consent",
            json={"status": "consent_to_services"},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["status"] == "consent_to_services"
        assert body["changed_at"] is not None
        assert body["changed_by"] is not None

    async def test_get_reflects_update(
        self, client: AsyncClient, member_tokens: dict
    ):
        """After a PATCH, GET returns the new state."""
        await _set_consent(client, member_tokens, "refuse_services")
        res = await client.get(
            "/api/v1/member/services-consent",
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 200
        assert res.json()["status"] == "refuse_services"

    async def test_invalid_status_returns_422(
        self, client: AsyncClient, member_tokens: dict
    ):
        """An unrecognized status value should be rejected with 422."""
        res = await client.patch(
            "/api/v1/member/services-consent",
            json={"status": "not_a_valid_value"},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 422


class TestCallBridge403Gate:
    """POST /api/v1/communication/call-bridge blocked when member refuses services."""

    async def test_call_bridge_blocked_when_refused(
        self, client: AsyncClient, member_tokens: dict, chw_tokens: dict
    ):
        """call-bridge returns 403 MEMBER_REFUSED_SERVICES when member has refused."""
        # Create a shared session so the relationship gate passes
        request_id = await _create_open_request(client, member_tokens)
        await _chw_accept_request(client, chw_tokens, request_id)

        # Member refuses services
        await _set_consent(client, member_tokens, "refuse_services")

        # Get member and CHW user IDs
        me_res = await client.get(
            "/api/v1/member/profile", headers=auth_header(member_tokens)
        )
        member_user_id = me_res.json()["user_id"]

        chw_me_res = await client.get(
            "/api/v1/chw/profile", headers=auth_header(chw_tokens)
        )
        chw_user_id = chw_me_res.json()["user_id"]

        # call-bridge validates that both parties have a phone on file (400)
        # BEFORE the relationship/consent gates run. The chw_tokens fixture
        # registers without a phone, so seed both phones directly via the ORM
        # so the request reaches the consent gate we are testing.
        from uuid import UUID

        from app.models.user import User
        from tests.conftest import test_session as _db_factory

        async with _db_factory() as db:
            chw_user = await db.get(User, UUID(chw_user_id))
            member_user = await db.get(User, UUID(member_user_id))
            assert chw_user is not None and member_user is not None
            chw_user.phone = "+15550003001"
            member_user.phone = member_user.phone or "+15550003002"
            await db.commit()

        # CHW tries to call member
        res = await client.post(
            "/api/v1/communication/call-bridge",
            json={"recipient_id": member_user_id},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403, res.text
        detail = res.json()["detail"]
        assert detail["code"] == "MEMBER_REFUSED_SERVICES"

    async def test_call_bridge_allowed_after_revert(
        self, client: AsyncClient, member_tokens: dict, chw_tokens: dict
    ):
        """call-bridge is unblocked immediately after member reverts to consent."""
        request_id = await _create_open_request(client, member_tokens)
        await _chw_accept_request(client, chw_tokens, request_id)

        # Refuse then revert
        await _set_consent(client, member_tokens, "refuse_services")
        await _set_consent(client, member_tokens, "consent_to_services")

        # Get member user ID
        me_res = await client.get(
            "/api/v1/member/profile", headers=auth_header(member_tokens)
        )
        member_user_id = me_res.json()["user_id"]

        # CHW tries to call — should not get MEMBER_REFUSED_SERVICES
        # (may still fail for other reasons like missing phone, but not 403 from consent)
        res = await client.post(
            "/api/v1/communication/call-bridge",
            json={"recipient_id": member_user_id},
            headers=auth_header(chw_tokens),
        )
        # The consent gate should NOT block this. Other gates (phone required, etc.)
        # may raise 400 but not 403 MEMBER_REFUSED_SERVICES.
        if res.status_code == 403:
            detail = res.json().get("detail", {})
            code = detail.get("code") if isinstance(detail, dict) else None
            assert code != "MEMBER_REFUSED_SERVICES", (
                "Call bridge incorrectly blocked after member reverted consent"
            )


class TestSessionMessageGate:
    """POST /api/v1/sessions/{id}/messages blocked when member refuses services."""

    async def test_send_session_message_blocked_when_refused(
        self, client: AsyncClient, member_tokens: dict, chw_tokens: dict
    ):
        """CHW cannot send a session message when member has refused services."""
        request_id = await _create_open_request(client, member_tokens)
        accept_body = await _chw_accept_request(client, chw_tokens, request_id)
        session_id = accept_body["session_id"]

        # Member refuses services
        await _set_consent(client, member_tokens, "refuse_services")

        # CHW attempts to send a message
        res = await client.post(
            f"/api/v1/sessions/{session_id}/messages",
            json={"body": "Hello, how are you?"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403, res.text
        detail = res.json()["detail"]
        assert detail["code"] == "MEMBER_REFUSED_SERVICES"

    async def test_member_cannot_send_session_message_when_refused(
        self, client: AsyncClient, member_tokens: dict, chw_tokens: dict
    ):
        """Member also cannot send messages to CHW while they have refused services.

        This prevents an awkward asymmetry where the member refuses services
        but can still contact the CHW.
        """
        request_id = await _create_open_request(client, member_tokens)
        accept_body = await _chw_accept_request(client, chw_tokens, request_id)
        session_id = accept_body["session_id"]

        # Member refuses services
        await _set_consent(client, member_tokens, "refuse_services")

        # Member attempts to send a message in the session
        res = await client.post(
            f"/api/v1/sessions/{session_id}/messages",
            json={"body": "Actually I changed my mind"},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 403, res.text
        detail = res.json()["detail"]
        assert detail["code"] == "MEMBER_REFUSED_SERVICES"


class TestConversationMessageGate:
    """POST /api/v1/conversations/{id}/messages blocked when member refuses services."""

    async def test_send_conversation_message_blocked_when_refused(
        self, client: AsyncClient, member_tokens: dict, chw_tokens: dict
    ):
        """CHW cannot send a conversation message when the member has refused services."""
        # First create a session to establish the care relationship
        request_id = await _create_open_request(client, member_tokens)
        await _chw_accept_request(client, chw_tokens, request_id)

        # Find the conversation for this pair
        convs_res = await client.get(
            "/api/v1/conversations/", headers=auth_header(chw_tokens)
        )
        assert convs_res.status_code == 200, convs_res.text
        convs = convs_res.json()
        assert len(convs) > 0, "No conversations found after request accept"
        conv_id = convs[0]["id"]

        # Member refuses services
        await _set_consent(client, member_tokens, "refuse_services")

        # CHW tries to send via conversations endpoint
        res = await client.post(
            f"/api/v1/conversations/{conv_id}/messages",
            json={"body": "Can I help you with anything?", "type": "text"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403, res.text
        detail = res.json()["detail"]
        assert detail["code"] == "MEMBER_REFUSED_SERVICES"


class TestRequestAcceptGate:
    """PATCH /api/v1/requests/{id}/accept blocked when member refuses services."""

    async def test_accept_blocked_when_member_refused(
        self, client: AsyncClient, member_tokens: dict, chw_tokens: dict
    ):
        """CHW cannot accept a service request when the member has refused services."""
        request_id = await _create_open_request(client, member_tokens)

        # Member refuses services BEFORE the CHW accepts
        await _set_consent(client, member_tokens, "refuse_services")

        # CHW tries to accept
        res = await client.patch(
            f"/api/v1/requests/{request_id}/accept",
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403, res.text
        detail = res.json()["detail"]
        assert detail["code"] == "MEMBER_REFUSED_SERVICES"

    async def test_accept_succeeds_after_revert(
        self, client: AsyncClient, member_tokens: dict, chw_tokens: dict
    ):
        """After member reverts to consent, request acceptance works again."""
        request_id = await _create_open_request(client, member_tokens)

        # Refuse then revert
        await _set_consent(client, member_tokens, "refuse_services")
        await _set_consent(client, member_tokens, "consent_to_services")

        # CHW accepts — should succeed
        res = await client.patch(
            f"/api/v1/requests/{request_id}/accept",
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 200, res.text
        assert res.json()["status"] == "matched"


class TestInsuranceCINEndpoint:
    """PATCH /api/v1/member/profile/insurance-cin"""

    async def test_update_insurance_cin(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Member can update insurance_company and medi_cal_id."""
        res = await client.patch(
            "/api/v1/member/profile/insurance-cin",
            json={"insurance_company": "Anthem Blue Cross", "medi_cal_id": "87654321B"},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["insurance_company"] == "Anthem Blue Cross"
        assert body["medi_cal_id"] == "87654321B"

    async def test_cin_normalized_to_uppercase(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Lowercase CIN letter is normalized to uppercase before storage."""
        res = await client.patch(
            "/api/v1/member/profile/insurance-cin",
            json={"insurance_company": "Health Net", "medi_cal_id": "11111111c"},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["medi_cal_id"] == "11111111C"

    async def test_invalid_cin_format_returns_422(
        self, client: AsyncClient, member_tokens: dict
    ):
        """A CIN that doesn't match ^\\d{8}[A-Z]$ returns 422."""
        res = await client.patch(
            "/api/v1/member/profile/insurance-cin",
            json={"insurance_company": "Health Net", "medi_cal_id": "ABCDEFGH1"},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 422, res.text

    async def test_cin_too_short_returns_422(
        self, client: AsyncClient, member_tokens: dict
    ):
        """CIN with only 7 digits + 1 letter returns 422."""
        res = await client.patch(
            "/api/v1/member/profile/insurance-cin",
            json={"insurance_company": "Health Net", "medi_cal_id": "1234567A"},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 422, res.text

    async def test_chw_cannot_use_insurance_cin_endpoint(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """CHW role is forbidden from the member-only insurance-cin endpoint."""
        res = await client.patch(
            "/api/v1/member/profile/insurance-cin",
            json={"insurance_company": "Health Net", "medi_cal_id": "12345678A"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403
