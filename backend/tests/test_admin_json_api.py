"""PHI-redaction and response-shape contract tests for admin JSON API endpoints.

Covers GET /api/v1/admin/{chws,members,sessions,requests,claims}.

HIPAA boundary enforced here:
- medi_cal_id, insurance_provider, date_of_birth — never on /members
- diagnosis_codes, notes, transcript text — never on /sessions or /claims
- description (free-text PHI) — flagged on /requests (see FLAG below)
- CHW credential/ssn fields — never on /chws
- Each endpoint requires admin key + valid 2FA token
- Empty DB must return 200 with items=[] and total=0, never 500

FLAG — SCHEMA PHI LEAK (RequestAdminItem.description):
  ServiceRequest.description is a TEXT column that members fill with their
  own words describing their health situation. It is PHI under 45 CFR §164.
  RequestAdminItem (app/schemas/admin.py:94) currently serialises this field
  verbatim. The test below asserts it is absent; that test WILL FAIL against
  the current schema, confirming the leak. Fix: drop description from the
  SELECT in list_admin_requests and remove the field from RequestAdminItem.
"""

import os
import uuid
from datetime import UTC, date, datetime, timedelta

import pyotp
import pytest
from httpx import AsyncClient

from app.models.billing import BillingClaim
from app.models.request import ServiceRequest
from app.models.session import Session
from app.models.user import CHWProfile, MemberProfile, User
from tests.conftest import test_session as _test_session_factory

ADMIN_KEY = os.environ.get("ADMIN_KEY", "test-admin-key-16-chars-min")

_DEFAULT_LIMIT = 50
# Must match _MAX_LIMIT in app/routers/admin.py — server enforces le=_MAX_LIMIT.
_MAX_LIMIT = 500


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _admin_header() -> dict[str, str]:
    """Bearer header carrying the configured admin key."""
    return {"Authorization": f"Bearer {ADMIN_KEY}"}


def _full_admin_headers(two_fa_token: str) -> dict[str, str]:
    """Combined admin-key + 2FA-token headers required by all JSON API routes."""
    return {**_admin_header(), "X-Admin-2FA-Token": two_fa_token}


async def _setup_and_verify_2fa(client: AsyncClient) -> str:
    """Walk through TOTP setup → verify and return the 2fa_token JWT.

    Mirrors the helper in test_admin_2fa.py so each test class can obtain
    a fresh, valid token without depending on another test module.
    """
    setup_res = await client.post("/api/v1/admin/2fa/setup", headers=_admin_header())
    assert setup_res.status_code == 200, setup_res.text
    secret = setup_res.json()["secret"]
    assert secret, "Expected plain secret on first setup"

    code = pyotp.TOTP(secret).now()
    verify_res = await client.post(
        "/api/v1/admin/2fa/verify",
        headers=_admin_header(),
        json={"token": code},
    )
    assert verify_res.status_code == 200, verify_res.text
    return verify_res.json()["two_fa_token"]


# ---------------------------------------------------------------------------
# Database seed helpers
# ---------------------------------------------------------------------------


async def _create_user(
    role: str,
    *,
    email: str | None = None,
    name: str = "Test User",
) -> uuid.UUID:
    """Insert a minimal User row via ORM and return its UUID.

    Using the ORM ensures Python-side defaults (is_active=True, is_onboarded=False)
    are applied, avoiding NotNullViolationError from raw SQL that omits those columns.
    """
    user_id = uuid.uuid4()
    email = email or f"{user_id}@example.com"
    async with _test_session_factory() as db:
        user = User(
            id=user_id,
            email=email,
            password_hash="hashed",
            role=role,
            name=name,
        )
        db.add(user)
        await db.commit()
    return user_id


async def _create_chw_profile(user_id: uuid.UUID) -> uuid.UUID:
    """Insert a CHWProfile row via ORM and return its UUID."""
    profile_id = uuid.uuid4()
    async with _test_session_factory() as db:
        profile = CHWProfile(
            id=profile_id,
            user_id=user_id,
            specializations=[],
            languages=[],
            rating=0.0,
            years_experience=1,
            is_available=True,
            total_sessions=0,
        )
        db.add(profile)
        await db.commit()
    return profile_id


async def _create_member_profile(
    user_id: uuid.UUID,
    *,
    medi_cal_id: str = "MEDI-CAL-SENSITIVE-99",
    zip_code: str = "90210",
) -> uuid.UUID:
    """Insert a MemberProfile with a known medi_cal_id value via ORM and return UUID."""
    profile_id = uuid.uuid4()
    async with _test_session_factory() as db:
        profile = MemberProfile(
            id=profile_id,
            user_id=user_id,
            zip_code=zip_code,
            primary_language="English",
            medi_cal_id=medi_cal_id,
            rewards_balance=0,
        )
        db.add(profile)
        await db.commit()
    return profile_id


async def _create_service_request(
    member_user_id: uuid.UUID,
    *,
    description: str = "I have chest pain and need help with my CARDIAC meds",
    vertical: str = "health",
    status: str = "open",
) -> uuid.UUID:
    """Insert a ServiceRequest with free-text PHI in description via ORM."""
    req_id = uuid.uuid4()
    async with _test_session_factory() as db:
        request = ServiceRequest(
            id=req_id,
            member_id=member_user_id,
            vertical=vertical,
            urgency="routine",
            description=description,
            preferred_mode="video",
            status=status,
            estimated_units=1,
        )
        db.add(request)
        await db.commit()
    return req_id


async def _create_session_row(
    chw_user_id: uuid.UUID,
    member_user_id: uuid.UUID,
    request_id: uuid.UUID,
    *,
    notes: str = "Patient expressed concerns about DIAGNOSIS X and DIABETES treatment",
    status: str = "completed",
) -> uuid.UUID:
    """Insert a Session row with clinical notes PHI via ORM."""
    session_id = uuid.uuid4()
    async with _test_session_factory() as db:
        session = Session(
            id=session_id,
            request_id=request_id,
            chw_id=chw_user_id,
            member_id=member_user_id,
            vertical="health",
            status=status,
            mode="video",
            notes=notes,
        )
        db.add(session)
        await db.commit()
    return session_id


async def _create_billing_claim(
    chw_user_id: uuid.UUID,
    member_user_id: uuid.UUID,
    session_id: uuid.UUID,
    *,
    diagnosis_codes: list[str] | None = None,
    status: str = "pending",
) -> uuid.UUID:
    """Insert a BillingClaim row with diagnosis_codes (PHI) via ORM and return UUID."""
    claim_id = uuid.uuid4()
    codes = diagnosis_codes or ["Z00.00", "I10"]  # ICD-10 codes — PHI
    async with _test_session_factory() as db:
        claim = BillingClaim(
            id=claim_id,
            session_id=session_id,
            chw_id=chw_user_id,
            member_id=member_user_id,
            diagnosis_codes=codes,
            procedure_code="G9011",
            units=1,
            gross_amount="100.00",
            platform_fee="15.00",
            net_payout="85.00",
            status=status,
            service_date=date.today(),
        )
        db.add(claim)
        await db.commit()
    return claim_id


# ---------------------------------------------------------------------------
# Authentication gating — each new endpoint must require admin key + 2FA
# ---------------------------------------------------------------------------


class TestAuthGating:
    """All five JSON API routes must reject unauthenticated and 2FA-less requests."""

    _ENDPOINTS = [
        "/api/v1/admin/chws",
        "/api/v1/admin/members",
        "/api/v1/admin/sessions",
        "/api/v1/admin/requests",
        "/api/v1/admin/claims",
    ]

    @pytest.mark.parametrize("url", _ENDPOINTS)
    async def test_no_credentials_returns_401_or_403(
        self, client: AsyncClient, url: str
    ):
        res = await client.get(url)
        assert res.status_code in (401, 403), (
            f"{url} must reject requests with no credentials"
        )

    @pytest.mark.parametrize("url", _ENDPOINTS)
    async def test_wrong_admin_key_returns_401(self, client: AsyncClient, url: str):
        res = await client.get(
            url,
            headers={"Authorization": "Bearer not-the-right-key"},
        )
        assert res.status_code == 401

    @pytest.mark.parametrize("url", _ENDPOINTS)
    async def test_admin_key_only_returns_401_missing_2fa(
        self, client: AsyncClient, url: str
    ):
        """Admin key alone is insufficient — 2FA token is also required."""
        res = await client.get(url, headers=_admin_header())
        assert res.status_code == 401
        assert "2fa" in res.json()["detail"].lower()

    @pytest.mark.parametrize("url", _ENDPOINTS)
    async def test_valid_credentials_returns_200(self, client: AsyncClient, url: str):
        token = await _setup_and_verify_2fa(client)
        res = await client.get(url, headers=_full_admin_headers(token))
        assert res.status_code == 200


# ---------------------------------------------------------------------------
# Pagination contracts
# ---------------------------------------------------------------------------


class TestPagination:
    """limit/offset query params must work; default ≤ 50; max limit enforced."""

    async def test_chws_default_limit_is_at_most_50(self, client: AsyncClient):
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/chws", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        data = res.json()
        assert len(data["items"]) <= _DEFAULT_LIMIT

    async def test_members_offset_param_accepted(self, client: AsyncClient):
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/members?limit=10&offset=0",
            headers=_full_admin_headers(token),
        )
        assert res.status_code == 200
        assert "items" in res.json()
        assert "total" in res.json()

    async def test_sessions_exceeding_max_limit_returns_422(self, client: AsyncClient):
        """Requesting limit > _MAX_LIMIT must be rejected with 422."""
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            f"/api/v1/admin/sessions?limit={_MAX_LIMIT + 1}",
            headers=_full_admin_headers(token),
        )
        assert res.status_code == 422

    async def test_requests_negative_offset_returns_422(self, client: AsyncClient):
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/requests?offset=-1",
            headers=_full_admin_headers(token),
        )
        assert res.status_code == 422

    async def test_claims_limit_zero_returns_422(self, client: AsyncClient):
        """limit=0 is below ge=1 and must be rejected."""
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/claims?limit=0",
            headers=_full_admin_headers(token),
        )
        assert res.status_code == 422


# ---------------------------------------------------------------------------
# Empty database — 200 with zero items, never 500
# ---------------------------------------------------------------------------


class TestEmptyDatabase:
    """Each endpoint must handle an empty table gracefully."""

    async def test_chws_empty_db(self, client: AsyncClient):
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/chws", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        assert res.json() == {"items": [], "total": 0}

    async def test_members_empty_db(self, client: AsyncClient):
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/members", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        assert res.json() == {"items": [], "total": 0}

    async def test_sessions_empty_db(self, client: AsyncClient):
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/sessions", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        assert res.json() == {"items": [], "total": 0}

    async def test_requests_empty_db(self, client: AsyncClient):
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/requests", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        assert res.json() == {"items": [], "total": 0}

    async def test_claims_empty_db(self, client: AsyncClient):
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/claims", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        assert res.json() == {"items": [], "total": 0}


# ---------------------------------------------------------------------------
# /admin/members — PHI guard
# ---------------------------------------------------------------------------


class TestMembersPhiGuard:
    """Response body and raw text must not contain PHI fields from MemberProfile."""

    _PHI_FIELD_NAMES = [
        "medi_cal_id",
        "date_of_birth",
        "address",
        "additional_needs",
        "diagnosis_codes",
        "insurance_provider",
        "latitude",
        "longitude",
    ]

    async def test_phi_field_names_absent_from_response_text(
        self, client: AsyncClient
    ):
        """None of the PHI key names must appear anywhere in the raw response body."""
        member_user_id = await _create_user("member", email="phi-member@test.com")
        await _create_member_profile(
            member_user_id, medi_cal_id="MEDI-CAL-SENSITIVE-99"
        )

        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/members", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200

        body = res.text
        for field in self._PHI_FIELD_NAMES:
            assert field not in body, (
                f"PHI field '{field}' leaked into /admin/members response"
            )

    async def test_medi_cal_value_absent_from_response_text(
        self, client: AsyncClient
    ):
        """The actual medi_cal_id value must not appear anywhere in the response."""
        sentinel = f"MEDICALID-{uuid.uuid4().hex[:8].upper()}"
        member_user_id = await _create_user(
            "member", email=f"medcal-{uuid.uuid4().hex[:6]}@test.com"
        )
        await _create_member_profile(member_user_id, medi_cal_id=sentinel)

        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/members", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        assert sentinel not in res.text, (
            "Actual medi_cal_id value surfaced in /admin/members response"
        )

    async def test_response_includes_expected_non_phi_fields(
        self, client: AsyncClient
    ):
        """Items must include id, name, email, zip_code, primary_language, created_at."""
        member_user_id = await _create_user(
            "member", email="shape-member@test.com", name="Shape Member"
        )
        await _create_member_profile(member_user_id, zip_code="94103")

        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/members", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        items = res.json()["items"]
        assert len(items) == 1
        item = items[0]

        for expected_key in ("id", "name", "email", "zip_code", "primary_language", "created_at"):
            assert expected_key in item, (
                f"Expected field '{expected_key}' missing from /admin/members item"
            )

    async def test_total_reflects_actual_count(self, client: AsyncClient):
        for i in range(3):
            uid = await _create_user("member", email=f"m{i}@test.com")
            await _create_member_profile(uid)

        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/members", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        assert res.json()["total"] == 3


# ---------------------------------------------------------------------------
# /admin/chws — PHI guard
# ---------------------------------------------------------------------------


class TestChwsPhiGuard:
    """CHW response must not expose financial or credential PHI fields."""

    _PHI_FIELD_NAMES = [
        "stripe_connected_account_id",
        "stripe_transfer_id",
        "stripe_payouts_enabled",
        "stripe_details_submitted",
        "ssn",
        "latitude",
        "longitude",
        "availability_windows",
        "rating_count",
        "bio",
        "password_hash",
    ]

    async def test_phi_field_names_absent_from_response_text(
        self, client: AsyncClient
    ):
        chw_user_id = await _create_user("chw", email="phi-chw@test.com")
        await _create_chw_profile(chw_user_id)

        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/chws", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200

        body = res.text
        for field in self._PHI_FIELD_NAMES:
            assert field not in body, (
                f"Sensitive field '{field}' leaked into /admin/chws response"
            )

    async def test_response_includes_expected_operational_fields(
        self, client: AsyncClient
    ):
        chw_user_id = await _create_user(
            "chw", email="shape-chw@test.com", name="Shape CHW"
        )
        await _create_chw_profile(chw_user_id)

        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/chws", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        items = res.json()["items"]
        assert len(items) == 1
        item = items[0]

        for expected_key in (
            "id", "name", "email", "specializations",
            "languages", "rating", "is_available", "total_sessions", "created_at",
        ):
            assert expected_key in item, (
                f"Expected field '{expected_key}' missing from /admin/chws item"
            )

    async def test_total_reflects_actual_count(self, client: AsyncClient):
        for i in range(2):
            uid = await _create_user("chw", email=f"chw{i}@test.com")
            await _create_chw_profile(uid)

        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/chws", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        assert res.json()["total"] == 2


# ---------------------------------------------------------------------------
# /admin/sessions — PHI guard
# ---------------------------------------------------------------------------


class TestSessionsPhiGuard:
    """Session response must not expose clinical notes, documentation, or transcripts."""

    # Sentinel text written into session notes — must not surface
    _NOTES_SENTINEL = "CONFIDENTIAL-NOTE-SENTINEL-DO-NOT-EXPOSE"

    _PHI_FIELD_NAMES = [
        "notes",
        "gross_amount",
        "summary",
        "diagnosis_codes",
        "resources_referred",
        "member_goals",
        "transcript",
        "recording_url",
        "documentation",
        "follow_up",
    ]

    async def _seed_session(self) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
        """Seed one CHW, one member, one request, one session. Returns IDs."""
        chw_uid = await _create_user("chw", email=f"sess-chw-{uuid.uuid4().hex[:6]}@test.com")
        await _create_chw_profile(chw_uid)
        mem_uid = await _create_user("member", email=f"sess-mem-{uuid.uuid4().hex[:6]}@test.com")
        await _create_member_profile(mem_uid)
        req_id = await _create_service_request(mem_uid)
        sess_id = await _create_session_row(
            chw_uid, mem_uid, req_id, notes=self._NOTES_SENTINEL
        )
        return chw_uid, mem_uid, sess_id

    async def test_phi_field_names_absent_from_response_text(
        self, client: AsyncClient
    ):
        await self._seed_session()
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/sessions", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200

        body = res.text
        for field in self._PHI_FIELD_NAMES:
            assert field not in body, (
                f"PHI field '{field}' leaked into /admin/sessions response"
            )

    async def test_notes_value_absent_from_response_text(self, client: AsyncClient):
        """The actual notes content must not appear in the response."""
        await self._seed_session()
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/sessions", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        assert self._NOTES_SENTINEL not in res.text, (
            "Session notes value surfaced in /admin/sessions response"
        )

    async def test_response_includes_expected_operational_fields(
        self, client: AsyncClient
    ):
        await self._seed_session()
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/sessions", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        items = res.json()["items"]
        assert len(items) == 1
        item = items[0]

        for expected_key in (
            "id", "chw_name", "member_name", "vertical",
            "status", "mode", "scheduled_at", "duration_minutes",
            "units_billed", "net_amount", "created_at",
        ):
            assert expected_key in item, (
                f"Expected field '{expected_key}' missing from /admin/sessions item"
            )

    async def test_status_filter_returns_matching_sessions_only(
        self, client: AsyncClient
    ):
        chw_uid = await _create_user("chw", email=f"flt-chw-{uuid.uuid4().hex[:6]}@test.com")
        await _create_chw_profile(chw_uid)
        mem_uid = await _create_user("member", email=f"flt-mem-{uuid.uuid4().hex[:6]}@test.com")
        await _create_member_profile(mem_uid)
        req_id = await _create_service_request(mem_uid)

        await _create_session_row(chw_uid, mem_uid, req_id, status="completed")
        await _create_session_row(chw_uid, mem_uid, req_id, status="cancelled")

        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/sessions?status=completed",
            headers=_full_admin_headers(token),
        )
        assert res.status_code == 200
        data = res.json()
        assert data["total"] == 1
        assert all(item["status"] == "completed" for item in data["items"])


# ---------------------------------------------------------------------------
# /admin/requests — PHI guard
# ---------------------------------------------------------------------------


class TestRequestsPhiGuard:
    """Service request response must not include the free-text description field.

    NOTE: The test_description_field_absent_from_response test below is
    expected to FAIL against the current schema because RequestAdminItem
    includes `description: str`.  This is the regression canary — fix the
    schema and the test will pass.
    """

    _DESCRIPTION_SENTINEL = "CONFIDENTIAL-DESCRIPTION-PATIENT-HAS-CANCER-DO-NOT-EXPOSE"

    _PHI_FIELD_NAMES = [
        "description",     # FLAG — currently leaking; see module docstring
        "medi_cal_id",
        "diagnosis_codes",
        "notes",
        "member_id",       # raw FK — not needed; member_name is sufficient
    ]

    async def _seed_request(self) -> uuid.UUID:
        mem_uid = await _create_user("member", email=f"req-mem-{uuid.uuid4().hex[:6]}@test.com")
        await _create_member_profile(mem_uid)
        return await _create_service_request(
            mem_uid, description=self._DESCRIPTION_SENTINEL
        )

    async def test_description_value_absent_from_response(self, client: AsyncClient):
        """Actual free-text description value must NOT appear in the response body.

        EXPECTED TO FAIL against current schema (RequestAdminItem.description
        is serialised verbatim). This is the HIPAA regression canary.
        """
        await self._seed_request()
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/requests", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        assert self._DESCRIPTION_SENTINEL not in res.text, (
            "HIPAA REGRESSION: free-text description (PHI) surfaced in "
            "/admin/requests — remove description from RequestAdminItem schema"
        )

    async def test_description_field_name_absent_from_response(
        self, client: AsyncClient
    ):
        """The key name 'description' must not appear in the JSON response body.

        EXPECTED TO FAIL against current schema.
        """
        await self._seed_request()
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/requests", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        assert "description" not in res.text, (
            "PHI field 'description' key present in /admin/requests response"
        )

    async def test_other_phi_field_names_absent(self, client: AsyncClient):
        await self._seed_request()
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/requests", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        body = res.text
        for field in ("medi_cal_id", "diagnosis_codes", "notes"):
            assert field not in body, (
                f"PHI field '{field}' leaked into /admin/requests response"
            )

    async def test_response_includes_expected_operational_fields(
        self, client: AsyncClient
    ):
        await self._seed_request()
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/requests", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        items = res.json()["items"]
        assert len(items) == 1
        item = items[0]

        for expected_key in ("id", "vertical", "status", "urgency", "created_at"):
            assert expected_key in item, (
                f"Expected field '{expected_key}' missing from /admin/requests item"
            )

    async def test_status_filter_open_only(self, client: AsyncClient):
        mem_uid = await _create_user("member", email=f"flt-req-{uuid.uuid4().hex[:6]}@test.com")
        await _create_member_profile(mem_uid)
        await _create_service_request(mem_uid, status="open")
        await _create_service_request(mem_uid, status="completed")

        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/requests?status=open",
            headers=_full_admin_headers(token),
        )
        assert res.status_code == 200
        data = res.json()
        assert data["total"] == 1
        assert all(item["status"] == "open" for item in data["items"])


# ---------------------------------------------------------------------------
# /admin/claims — PHI guard
# ---------------------------------------------------------------------------


class TestClaimsPhiGuard:
    """Billing claims response must not expose diagnosis_codes or rejection_reason."""

    _PHI_FIELD_NAMES = [
        "diagnosis_codes",
        "rejection_reason",
        "pear_suite_claim_id",
        "stripe_transfer_id",
        "adjudicated_at",
        "modifier",
    ]

    async def _seed_claim(
        self,
        *,
        diagnosis_codes: list[str] | None = None,
        status: str = "pending",
    ) -> uuid.UUID:
        chw_uid = await _create_user("chw", email=f"cl-chw-{uuid.uuid4().hex[:6]}@test.com")
        await _create_chw_profile(chw_uid)
        mem_uid = await _create_user("member", email=f"cl-mem-{uuid.uuid4().hex[:6]}@test.com")
        await _create_member_profile(mem_uid)
        req_id = await _create_service_request(mem_uid)
        sess_id = await _create_session_row(chw_uid, mem_uid, req_id)
        return await _create_billing_claim(
            chw_uid, mem_uid, sess_id,
            diagnosis_codes=diagnosis_codes,
            status=status,
        )

    async def test_phi_field_names_absent_from_response_text(
        self, client: AsyncClient
    ):
        await self._seed_claim(diagnosis_codes=["I10", "Z79.899"])
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/claims", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200

        body = res.text
        for field in self._PHI_FIELD_NAMES:
            assert field not in body, (
                f"PHI/sensitive field '{field}' leaked into /admin/claims response"
            )

    async def test_diagnosis_code_values_absent_from_response(
        self, client: AsyncClient
    ):
        """ICD-10 diagnosis code values must not appear in the raw response body."""
        sentinel_code = f"Z{uuid.uuid4().hex[:4].upper()}"
        await self._seed_claim(diagnosis_codes=[sentinel_code])

        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/claims", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        assert sentinel_code not in res.text, (
            f"ICD-10 code '{sentinel_code}' (diagnosis PHI) surfaced in /admin/claims"
        )

    async def test_response_includes_expected_billing_fields(
        self, client: AsyncClient
    ):
        await self._seed_claim()
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/claims", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        items = res.json()["items"]
        assert len(items) == 1
        item = items[0]

        for expected_key in (
            "id", "chw_name", "member_name", "procedure_code",
            "units", "gross_amount", "platform_fee", "net_payout",
            "status", "service_date", "created_at",
        ):
            # created_at is not in ClaimAdminItem but present via DB; check only the schema keys
            pass

        schema_keys = (
            "id", "chw_name", "member_name", "procedure_code",
            "units", "gross_amount", "platform_fee", "net_payout", "status",
        )
        for key in schema_keys:
            assert key in item, (
                f"Expected billing field '{key}' missing from /admin/claims item"
            )

    async def test_financial_values_are_numeric(self, client: AsyncClient):
        """gross_amount, platform_fee, net_payout must be numeric (not strings)."""
        await self._seed_claim()
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/claims", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        item = res.json()["items"][0]
        assert isinstance(item["gross_amount"], (int, float))
        assert isinstance(item["platform_fee"], (int, float))
        assert isinstance(item["net_payout"], (int, float))

    async def test_status_filter_pending_only(self, client: AsyncClient):
        await self._seed_claim(status="pending")
        await self._seed_claim(status="paid")

        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/claims?status=pending",
            headers=_full_admin_headers(token),
        )
        assert res.status_code == 200
        data = res.json()
        assert data["total"] == 1
        assert all(item["status"] == "pending" for item in data["items"])

    async def test_total_reflects_all_claims_without_filter(
        self, client: AsyncClient
    ):
        await self._seed_claim(status="pending")
        await self._seed_claim(status="paid")

        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/claims", headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        assert res.json()["total"] == 2
