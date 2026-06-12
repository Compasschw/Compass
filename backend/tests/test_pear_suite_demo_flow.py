"""Tests for the Pear Suite demo claim flow.

All tests mock httpx so no real Pear Suite API calls are made.
Covers:
- ensure_member_synced skips when already synced
- ensure_member_synced calls Pear and persists ID when not synced
- demo-claim endpoint 400 when CHW lacks pear_suite_user_id
- demo-claim endpoint 400 when the demo template ID is missing
- demo-claim endpoint orchestrates 4-step chain (schedule, complete, claim, status)
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.session import Session
from app.models.user import CHWProfile, MemberProfile, User


# ─── Helpers ──────────────────────────────────────────────────────────────────

async def _create_user(
    db: AsyncSession,
    *,
    role: str,
    name: str = "Test User",
    email: str | None = None,
) -> User:
    """Create and persist a minimal User for testing."""
    from app.utils.security import hash_password
    email = email or f"{role}-{uuid.uuid4().hex[:8]}@example.com"
    user = User(
        email=email,
        password_hash=hash_password("testpass123"),
        role=role,
        name=name,
        is_active=True,
        is_onboarded=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _create_member_profile(
    db: AsyncSession,
    user: User,
    *,
    pear_suite_member_id: str | None = None,
) -> MemberProfile:
    """Create and persist a MemberProfile."""
    profile = MemberProfile(
        user_id=user.id,
        primary_language="English",
        pear_suite_member_id=pear_suite_member_id,
        zip_code="90210",
    )
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    return profile


async def _create_chw_profile(
    db: AsyncSession,
    user: User,
    *,
    pear_suite_user_id: str | None = None,
) -> CHWProfile:
    """Create and persist a CHWProfile."""
    profile = CHWProfile(
        user_id=user.id,
        pear_suite_user_id=pear_suite_user_id,
    )
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    return profile


async def _create_session(
    db: AsyncSession,
    chw_user: User,
    member_user: User,
) -> Session:
    """Create and persist a completed Session."""
    from app.models.request import ServiceRequest

    sr = ServiceRequest(
        member_id=member_user.id,
        vertical="health_navigation",
        urgency="routine",
        preferred_mode="phone",
        status="completed",
        description="Test request for PearSuite demo flow integration test.",
    )
    db.add(sr)
    await db.flush()

    session = Session(
        request_id=sr.id,
        chw_id=chw_user.id,
        member_id=member_user.id,
        vertical="health_navigation",
        status="completed",
        mode="phone",
        scheduled_at=datetime.now(UTC),
        started_at=datetime.now(UTC),
        ended_at=datetime.now(UTC),
        duration_minutes=30,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


def _admin_headers(two_fa_token: str = "fake-2fa") -> dict[str, str]:
    # settings.admin_key, not a literal — CI's workflow env sets a different
    # ADMIN_KEY than conftest's local setdefault.
    return {
        "Authorization": f"Bearer {settings.admin_key}",
        "X-Admin-2FA-Token": two_fa_token,
    }


# ─── ensure_member_synced tests ───────────────────────────────────────────────


class TestEnsureMemberSynced:
    """Tests for app.services.pear_suite_member_sync.ensure_member_synced."""

    @pytest.mark.asyncio
    async def test_skips_when_already_synced(self, setup_db):
        """If pear_suite_member_id is already set, no API call is made."""
        from app.database import async_session
        from app.services.pear_suite_member_sync import ensure_member_synced

        async with async_session() as db:
            user = await _create_user(db, role="member", name="Already Synced")
            profile = await _create_member_profile(db, user, pear_suite_member_id="pear-member-existing")

        # Patch get_pear_suite_provider — should never be called
        with patch(
            "app.services.pear_suite_member_sync.get_pear_suite_provider",
        ) as mock_factory:
            async with async_session() as db:
                result_profile = (
                    await db.execute(select(MemberProfile).where(MemberProfile.user_id == user.id))
                ).scalar_one()
                result_user = await db.get(User, user.id)

                pear_id = await ensure_member_synced(db, result_profile, result_user)

            mock_factory.assert_not_called()
            assert pear_id == "pear-member-existing"

    @pytest.mark.asyncio
    async def test_calls_pear_and_persists_id_when_not_synced(self, setup_db):
        """If pear_suite_member_id is absent, calls Pear API and persists the returned ID."""
        from app.database import async_session
        from app.services.pear_suite_member_sync import ensure_member_synced

        async with async_session() as db:
            user = await _create_user(db, role="member", name="New Member", email="newmember@test.com")
            profile = await _create_member_profile(db, user, pear_suite_member_id=None)

        fake_pear_id = "pear-member-newly-created"

        mock_provider = AsyncMock()
        mock_provider.create_member = AsyncMock(return_value={"id": fake_pear_id})

        with patch(
            "app.services.pear_suite_member_sync.get_pear_suite_provider",
            return_value=mock_provider,
        ):
            async with async_session() as db:
                result_profile = (
                    await db.execute(select(MemberProfile).where(MemberProfile.user_id == user.id))
                ).scalar_one()
                result_user = await db.get(User, user.id)

                pear_id = await ensure_member_synced(db, result_profile, result_user)

        assert pear_id == fake_pear_id
        mock_provider.create_member.assert_awaited_once()

        # Verify persistence
        async with async_session() as db:
            refreshed = (
                await db.execute(select(MemberProfile).where(MemberProfile.user_id == user.id))
            ).scalar_one()
            assert refreshed.pear_suite_member_id == fake_pear_id

    @pytest.mark.asyncio
    async def test_raises_when_pear_returns_no_id(self, setup_db):
        """Raises ValueError if Pear Suite response has no 'id' field."""
        from app.database import async_session
        from app.services.pear_suite_member_sync import ensure_member_synced

        async with async_session() as db:
            user = await _create_user(db, role="member", name="No ID Member")
            profile = await _create_member_profile(db, user, pear_suite_member_id=None)

        mock_provider = AsyncMock()
        mock_provider.create_member = AsyncMock(return_value={"status": "ok"})  # no "id"

        with patch(
            "app.services.pear_suite_member_sync.get_pear_suite_provider",
            return_value=mock_provider,
        ):
            async with async_session() as db:
                result_profile = (
                    await db.execute(select(MemberProfile).where(MemberProfile.user_id == user.id))
                ).scalar_one()
                result_user = await db.get(User, user.id)

                with pytest.raises(ValueError, match="did not return a member ID"):
                    await ensure_member_synced(db, result_profile, result_user)


# ─── Demo-claim endpoint tests ────────────────────────────────────────────────


class TestDemoClaimEndpoint:
    """Integration tests for POST /api/v1/admin/pear-suite/demo-claim.

    Uses the ASGI test client with DB fixtures. 2FA token validation is patched
    out to keep tests focused on business logic — the 2FA mechanism is tested
    separately in test_admin_2fa.py.
    """

    @pytest.fixture(autouse=True)
    def _patch_2fa(self):
        """Bypass 2FA dependency for all tests in this class."""
        from app.routers.admin import require_2fa_token
        from app.main import app

        async def _noop_2fa():
            return None

        app.dependency_overrides[require_2fa_token] = _noop_2fa
        yield
        app.dependency_overrides.pop(require_2fa_token, None)

    @pytest.mark.asyncio
    async def test_400_when_session_not_found(self, client: AsyncClient):
        """Returns 400 when session_id does not exist."""
        non_existent = str(uuid.uuid4())
        resp = await client.post(
            "/api/v1/admin/pear-suite/demo-claim",
            json={"session_id": non_existent},
            headers=_admin_headers(),
        )
        assert resp.status_code == 400
        assert "not found" in resp.json()["detail"].lower()

    @pytest.mark.asyncio
    async def test_400_when_chw_missing_pear_user_id(
        self, client: AsyncClient, setup_db
    ):
        """Returns 400 when CHWProfile.pear_suite_user_id is not set."""
        from app.database import async_session

        async with async_session() as db:
            chw_user = await _create_user(db, role="chw", name="Jemal CHW", email="jemal@test.com")
            member_user = await _create_user(db, role="member", name="Demo Member", email="demo@test.com")
            await _create_member_profile(db, member_user)
            # CHW profile WITHOUT pear_suite_user_id
            await _create_chw_profile(db, chw_user, pear_suite_user_id=None)
            session = await _create_session(db, chw_user, member_user)

        with patch.object(settings, "pear_suite_demo_template_id", "template-demo"):
            resp = await client.post(
                "/api/v1/admin/pear-suite/demo-claim",
                json={"session_id": str(session.id)},
                headers=_admin_headers(),
            )

        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert "pear_suite_user_id" in detail

    @pytest.mark.asyncio
    async def test_400_when_t1016_template_id_missing(
        self, client: AsyncClient, setup_db
    ):
        """Returns 400 when PEAR_SUITE_DEMO_TEMPLATE_ID is not configured."""
        from app.database import async_session

        async with async_session() as db:
            chw_user = await _create_user(db, role="chw", name="Jemal CHW", email="jemal2@test.com")
            member_user = await _create_user(db, role="member", name="Demo Member", email="demo2@test.com")
            await _create_member_profile(db, member_user)
            # CHW profile WITH pear_suite_user_id
            await _create_chw_profile(db, chw_user, pear_suite_user_id="pear-chw-jemal")
            session = await _create_session(db, chw_user, member_user)

        # Ensure template_id is empty — patch the real settings object so every
        # other attribute (dx codes, admin key, etc.) keeps its real value.
        with patch.object(settings, "pear_suite_demo_template_id", ""):
            resp = await client.post(
                "/api/v1/admin/pear-suite/demo-claim",
                json={"session_id": str(session.id)},
                headers=_admin_headers(),
            )

        assert resp.status_code == 400
        detail = resp.json()["detail"]
        assert "PEAR_SUITE_DEMO_TEMPLATE_ID" in detail

    @pytest.mark.asyncio
    async def test_full_chain_orchestration(
        self, client: AsyncClient, setup_db
    ):
        """Happy path: the endpoint calls schedule, complete, generate, and status in order."""
        from app.database import async_session

        pear_member_id = "pear-member-demo"
        pear_activity_id = "pear-activity-demo"
        pear_claim_id = "pear-claim-demo"
        pear_chw_user_id = "pear-chw-jemal"

        async with async_session() as db:
            chw_user = await _create_user(db, role="chw", name="Jemal", email="jemal3@test.com")
            member_user = await _create_user(db, role="member", name="Demo Member", email="demo3@test.com")
            # Member already synced — skips create_member
            await _create_member_profile(db, member_user, pear_suite_member_id=pear_member_id)
            await _create_chw_profile(db, chw_user, pear_suite_user_id=pear_chw_user_id)
            session = await _create_session(db, chw_user, member_user)

        call_order: list[str] = []

        async def mock_schedule_activity(**kwargs):
            call_order.append("schedule")
            assert kwargs["activity_template_id"] == "template-demo"
            assert pear_member_id in kwargs["member_ids"]
            assert kwargs["chw_user_id"] == pear_chw_user_id
            return {"id": pear_activity_id}

        async def mock_complete_activity(**kwargs):
            call_order.append("complete")
            assert kwargs["pear_activity_id"] == pear_activity_id
            assert kwargs["pear_member_id"] == pear_member_id
            return {"id": pear_activity_id, "status": "Complete"}

        async def mock_generate_claim(**kwargs):
            call_order.append("generate")
            assert kwargs["pear_member_id"] == pear_member_id
            assert kwargs["pear_activity_id"] == pear_activity_id
            return {"success": True, "data": {"id": pear_claim_id}}

        async def mock_get_claim_status(provider_claim_id: str):
            call_order.append("status")
            assert provider_claim_id == pear_claim_id
            from app.services.billing.base import ClaimResult
            return ClaimResult(success=True, provider_claim_id=pear_claim_id, status="submitted")

        mock_provider = AsyncMock()
        mock_provider.schedule_activity = mock_schedule_activity
        mock_provider.complete_activity = mock_complete_activity
        mock_provider.generate_claim = mock_generate_claim
        mock_provider.get_claim_status = mock_get_claim_status

        with (
            patch("app.routers.admin_demo.get_pear_suite_provider", return_value=mock_provider),
            patch("app.routers.admin_demo.ensure_member_synced", new_callable=AsyncMock) as mock_sync,
            # Patch only the demo-specific settings the endpoint reads, on the
            # REAL settings object, so all other attributes keep real values
            # and the endpoint receives a real string template id.
            patch.object(settings, "pear_suite_demo_template_id", "template-demo"),
            patch.object(settings, "pear_suite_default_dx_codes", ["Z71.89"]),
        ):
            mock_sync.return_value = pear_member_id

            resp = await client.post(
                "/api/v1/admin/pear-suite/demo-claim",
                json={"session_id": str(session.id)},
                headers=_admin_headers(),
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()

        assert body["pear_member_id"] == pear_member_id
        assert body["pear_activity_id"] == pear_activity_id
        assert body["pear_claim_id"] == pear_claim_id
        assert body["claim_status"] == "submitted"
        assert "dashboard" in body["view_url_hint"].lower()

        # Assert chain order
        assert call_order == ["schedule", "complete", "generate", "status"]
        mock_sync.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_401_without_admin_key(self, client: AsyncClient):
        """Returns 401 when Authorization header is missing."""
        resp = await client.post(
            "/api/v1/admin/pear-suite/demo-claim",
            json={"session_id": str(uuid.uuid4())},
        )
        # The admin auth dependency rejects with 401 (no token) — HTTPBearer raises
        # 403 in some FastAPI versions and 401 in others depending on auto_error
        # settings. Accept either since both correctly indicate auth failure.
        assert resp.status_code in (401, 403)


# ─── PearSuiteProvider unit tests ─────────────────────────────────────────────


class TestPearSuiteProviderGenerateClaim:
    """Unit tests for the generate_claim fallback behavior."""

    @pytest.mark.asyncio
    async def test_falls_back_to_bill_id_on_first_attempt_4xx(self):
        """If first POST /claims 4xx-errors, retry with billId=activityId."""
        import httpx
        from app.services.billing.pear_suite_provider import PearSuiteProvider

        provider = PearSuiteProvider(api_key="test-key")

        call_count = 0

        async def mock_request(method, path, json=None, idempotency_key=None):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                # First attempt: memberId only — simulate 422 rejection
                mock_resp = MagicMock()
                mock_resp.status_code = 422
                mock_resp.text = '{"error": "no unbilled activities found"}'
                raise httpx.HTTPStatusError(
                    "422", request=MagicMock(), response=mock_resp
                )
            # Second attempt: with billId
            assert json is not None
            assert json.get("billId") == "pear-act-123"
            return {"success": True, "data": {"id": "pear-claim-from-fallback"}}

        provider._request = mock_request

        result = await provider.generate_claim(
            pear_member_id="pear-mem-1",
            pear_activity_id="pear-act-123",
            session_id=uuid.uuid4(),
        )

        assert call_count == 2
        assert result["data"]["id"] == "pear-claim-from-fallback"

    @pytest.mark.asyncio
    async def test_first_attempt_success_does_not_retry(self):
        """If first POST /claims succeeds, no fallback attempt is made."""
        from app.services.billing.pear_suite_provider import PearSuiteProvider

        provider = PearSuiteProvider(api_key="test-key")
        call_count = 0

        async def mock_request(method, path, json=None, idempotency_key=None):
            nonlocal call_count
            call_count += 1
            return {"success": True, "data": {"id": "pear-claim-first-try"}}

        provider._request = mock_request

        result = await provider.generate_claim(
            pear_member_id="pear-mem-2",
            pear_activity_id="pear-act-456",
            session_id=uuid.uuid4(),
        )

        assert call_count == 1
        assert result["data"]["id"] == "pear-claim-first-try"


class TestPearSuiteProviderGetClaimStatus:
    """Tests for get_claim_status status mapping."""

    @pytest.mark.asyncio
    async def test_maps_pear_paid_to_internal_paid(self):
        from app.services.billing.pear_suite_provider import PearSuiteProvider

        provider = PearSuiteProvider(api_key="test-key")

        async def mock_request(method, path, json=None, idempotency_key=None):
            return {"status": "Paid", "id": "pear-claim-789"}

        provider._request = mock_request

        result = await provider.get_claim_status("pear-claim-789")
        assert result.status == "paid"
        assert result.success is True

    @pytest.mark.asyncio
    async def test_maps_pear_denied_to_internal_denied(self):
        from app.services.billing.pear_suite_provider import PearSuiteProvider

        provider = PearSuiteProvider(api_key="test-key")

        async def mock_request(method, path, json=None, idempotency_key=None):
            return {"status": "Denied", "id": "pear-claim-000"}

        provider._request = mock_request

        result = await provider.get_claim_status("pear-claim-000")
        assert result.status == "denied"

    @pytest.mark.asyncio
    async def test_stub_id_returns_submitted_without_api_call(self):
        from app.services.billing.pear_suite_provider import PearSuiteProvider

        provider = PearSuiteProvider(api_key="test-key")
        call_count = 0

        async def mock_request(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            return {}

        provider._request = mock_request

        result = await provider.get_claim_status("pearsuite-stub-some-session-id")
        assert result.status == "submitted"
        assert call_count == 0  # no API call for stub IDs
