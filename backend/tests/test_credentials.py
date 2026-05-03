"""Tests for the CHW credential validation router.

Covers ownership and role boundaries on /api/v1/credentials/*.

Key boundaries under test:
- POST /validate           requires role=chw; scopes new record to current_user.id
- GET  /validations        CHW sees only own rows; admin sees all
- PATCH /validations/{id}  owning CHW -> 200; different CHW -> 403; member -> 403
- PATCH /validations/{id}/review  admin -> 200; CHW (even owning) -> 403
- GET  /institutions       unauthenticated lookup (no auth required by the router)
- GET  /institutions?q=    filters by name ilike

Design notes:
- PATCH /validations/{id}/review uses query params (approved=, notes=), NOT a JSON body.
- /institutions is open to unauthenticated callers — no auth dependency on that route.
- document_s3_key must match 'credentials/<chw_uuid>/<file_uuid>.pdf' — schema enforced.
"""

import uuid
from datetime import date

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.credential import CHWCredentialValidation, InstitutionRegistry
from app.models.user import User
from app.utils.security import decode_token, hash_password
from tests.conftest import test_session as _test_session_factory

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

BASE = "/api/v1/credentials"

_VALID_S3_KEY_TEMPLATE = "credentials/{chw_id}/{file_id}.pdf"


def _auth(tokens: dict) -> dict[str, str]:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def _user_id(tokens: dict) -> str:
    """Decode the JWT sub claim to obtain the authenticated user's UUID string.

    TokenResponse contains {access_token, refresh_token, role, name} — there is
    no ``user`` key.  The canonical user id lives in the JWT ``sub`` claim.
    """
    payload = decode_token(tokens["access_token"])
    assert payload is not None, "Could not decode access_token — check secret_key"
    return payload["sub"]


def _s3_key(chw_id: str | None = None, file_id: str | None = None) -> str:
    """Return a schema-valid document_s3_key."""
    return _VALID_S3_KEY_TEMPLATE.format(
        chw_id=chw_id or str(uuid.uuid4()),
        file_id=file_id or str(uuid.uuid4()),
    )


def _submit_payload(**overrides) -> dict:
    defaults = {
        "institution_name": "Compass Training Institute",
        "institution_contact_email": "admin@cti.example.com",
        "program_name": "Community Health Worker Certificate",
        "certificate_number": "CTI-2024-001",
        "graduation_date": "2024-06-01T00:00:00Z",
    }
    defaults.update(overrides)
    return defaults


async def _register_chw(client: AsyncClient, email: str) -> dict:
    """Register a second CHW and return its tokens dict."""
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "testpass123",
            "name": "Extra CHW",
            "role": "chw",
        },
    )
    assert res.status_code == 201, f"registration failed: {res.text}"
    return res.json()


async def _register_admin(client: AsyncClient, email: str = "admin@example.com") -> dict:
    """Seed an admin user directly via ORM and return its tokens dict.

    POST /auth/register enforces role ∈ {"chw", "member"} at the schema level,
    so admin users must be inserted bypassing the public registration endpoint.
    After seeding, the function obtains tokens via POST /auth/login so the
    returned dict has the same shape ({access_token, refresh_token, role, name})
    as the CHW/member token dicts used throughout the test suite.
    """
    password = "adminpass123"
    async with _test_session_factory() as db:
        admin = User(
            id=uuid.uuid4(),
            email=email,
            password_hash=hash_password(password),
            name="Admin User",
            role="admin",
            is_active=True,
            is_onboarded=True,
        )
        db.add(admin)
        await db.commit()

    res = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    assert res.status_code == 200, f"admin login failed: {res.text}"
    return res.json()


async def _create_validation(client: AsyncClient, tokens: dict, **overrides) -> dict:
    """Submit a credential validation and return the response JSON."""
    res = await client.post(
        f"{BASE}/validate",
        headers=_auth(tokens),
        json=_submit_payload(**overrides),
    )
    assert res.status_code == 201, f"create_validation failed: {res.text}"
    return res.json()


# ---------------------------------------------------------------------------
# POST /credentials/validate
# ---------------------------------------------------------------------------


class TestSubmitValidation:
    async def test_chw_can_submit(self, client: AsyncClient, chw_tokens: dict):
        """Happy path: CHW submits a credential validation record."""
        res = await client.post(
            f"{BASE}/validate",
            headers=_auth(chw_tokens),
            json=_submit_payload(),
        )
        assert res.status_code == 201
        data = res.json()
        assert data["program_name"] == "Community Health Worker Certificate"
        assert data["validation_status"] == "pending"
        assert data["validated_at"] is None

    async def test_submit_scopes_record_to_current_user(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """The created row must have chw_id == the authenticated user's id."""
        data = await _create_validation(client, chw_tokens)
        chw_id = _user_id(chw_tokens)
        assert data["chw_id"] == chw_id

    async def test_member_cannot_submit(self, client: AsyncClient, member_tokens: dict):
        """Members lack the chw role — must receive 403."""
        res = await client.post(
            f"{BASE}/validate",
            headers=_auth(member_tokens),
            json=_submit_payload(),
        )
        assert res.status_code == 403

    async def test_unauthenticated_cannot_submit(self, client: AsyncClient):
        """No token — must receive 401 or 403 (FastAPI HTTPBearer returns 403
        when no Authorization header is present, 401 for a bad/expired token)."""
        res = await client.post(f"{BASE}/validate", json=_submit_payload())
        assert res.status_code in (401, 403)

    async def test_invalid_s3_key_rejected(self, client: AsyncClient, chw_tokens: dict):
        """Schema validator must reject full HTTPS URLs as document_s3_key."""
        res = await client.post(
            f"{BASE}/validate",
            headers=_auth(chw_tokens),
            json=_submit_payload(document_s3_key="https://s3.amazonaws.com/bucket/file.pdf"),
        )
        assert res.status_code == 422

    async def test_valid_s3_key_accepted(self, client: AsyncClient, chw_tokens: dict):
        """A correctly formatted path-only key must be accepted."""
        key = _s3_key()
        data = await _create_validation(client, chw_tokens, document_s3_key=key)
        assert data["document_s3_key"] == key

    async def test_submit_creates_or_reuses_institution(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """Two submissions with the same institution name must share institution_id."""
        first = await _create_validation(client, chw_tokens)
        second = await _create_validation(
            client, chw_tokens, certificate_number="CTI-2024-002"
        )
        assert first["institution_id"] == second["institution_id"]


# ---------------------------------------------------------------------------
# GET /credentials/validations
# ---------------------------------------------------------------------------


class TestListValidations:
    async def test_chw_sees_only_own_records(self, client: AsyncClient, chw_tokens: dict):
        """A CHW must only see rows where chw_id == their own id."""
        chw2_tokens = await _register_chw(client, "chw2@example.com")

        await _create_validation(client, chw_tokens)
        await _create_validation(client, chw2_tokens)

        res = await client.get(f"{BASE}/validations", headers=_auth(chw_tokens))
        assert res.status_code == 200
        rows = res.json()
        chw_id = _user_id(chw_tokens)
        assert len(rows) == 1
        assert all(r["chw_id"] == chw_id for r in rows)

    async def test_admin_sees_all_records(self, client: AsyncClient, chw_tokens: dict):
        """Admin must see every row regardless of chw_id."""
        chw2_tokens = await _register_chw(client, "chw2admin@example.com")
        admin_tokens = await _register_admin(client)

        await _create_validation(client, chw_tokens)
        await _create_validation(client, chw2_tokens)

        res = await client.get(f"{BASE}/validations", headers=_auth(admin_tokens))
        assert res.status_code == 200
        rows = res.json()
        assert len(rows) == 2

    async def test_unauthenticated_list_rejected(self, client: AsyncClient):
        res = await client.get(f"{BASE}/validations")
        assert res.status_code in (401, 403)

    async def test_empty_list_for_new_chw(self, client: AsyncClient, chw_tokens: dict):
        res = await client.get(f"{BASE}/validations", headers=_auth(chw_tokens))
        assert res.status_code == 200
        assert res.json() == []


# ---------------------------------------------------------------------------
# PATCH /credentials/validations/{id}
# ---------------------------------------------------------------------------


class TestUpdateValidation:
    async def test_owning_chw_can_update_document_key(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """Happy path: owning CHW attaches a document S3 key post-upload."""
        record = await _create_validation(client, chw_tokens)
        chw_id = _user_id(chw_tokens)
        key = _s3_key(chw_id=chw_id)

        res = await client.patch(
            f"{BASE}/validations/{record['id']}",
            headers=_auth(chw_tokens),
            json={"document_s3_key": key},
        )
        assert res.status_code == 200
        assert res.json()["document_s3_key"] == key

    async def test_owning_chw_can_update_expiry_date(
        self, client: AsyncClient, chw_tokens: dict
    ):
        record = await _create_validation(client, chw_tokens)
        expiry = "2026-12-31"

        res = await client.patch(
            f"{BASE}/validations/{record['id']}",
            headers=_auth(chw_tokens),
            json={"expiry_date": expiry},
        )
        assert res.status_code == 200
        assert res.json()["expiry_date"] == expiry

    async def test_different_chw_cannot_update(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """Ownership boundary: a second CHW must receive 403 on another's record."""
        chw2_tokens = await _register_chw(client, "chw2update@example.com")
        record = await _create_validation(client, chw_tokens)

        res = await client.patch(
            f"{BASE}/validations/{record['id']}",
            headers=_auth(chw2_tokens),
            json={"expiry_date": "2026-12-31"},
        )
        assert res.status_code == 403

    async def test_member_cannot_update(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ):
        """Role boundary: member lacks chw role — must receive 403."""
        record = await _create_validation(client, chw_tokens)

        res = await client.patch(
            f"{BASE}/validations/{record['id']}",
            headers=_auth(member_tokens),
            json={"expiry_date": "2026-12-31"},
        )
        assert res.status_code == 403

    async def test_update_nonexistent_record_returns_404(
        self, client: AsyncClient, chw_tokens: dict
    ):
        phantom_id = str(uuid.uuid4())
        res = await client.patch(
            f"{BASE}/validations/{phantom_id}",
            headers=_auth(chw_tokens),
            json={"expiry_date": "2026-12-31"},
        )
        assert res.status_code == 404

    async def test_patch_validation_status_ignored(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """CHW must not be able to self-approve by including validation_status in body.

        CredentialValidationPatch only exposes document_s3_key and expiry_date,
        so extra fields must be silently ignored (Pydantic strict=False default).
        """
        record = await _create_validation(client, chw_tokens)
        # Inject an unexpected field alongside a valid one
        res = await client.patch(
            f"{BASE}/validations/{record['id']}",
            headers=_auth(chw_tokens),
            json={"expiry_date": "2026-12-31", "validation_status": "verified"},
        )
        # The patch itself may succeed (200) but status must remain pending
        if res.status_code == 200:
            assert res.json()["validation_status"] == "pending"

    async def test_update_persists_to_db(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """PATCH changes must be durable — confirmed via direct DB read."""
        record = await _create_validation(client, chw_tokens)
        chw_id = _user_id(chw_tokens)
        key = _s3_key(chw_id=chw_id)
        expiry = date(2027, 6, 30)

        await client.patch(
            f"{BASE}/validations/{record['id']}",
            headers=_auth(chw_tokens),
            json={"document_s3_key": key, "expiry_date": str(expiry)},
        )

        async with _test_session_factory() as db:
            row = await db.get(CHWCredentialValidation, uuid.UUID(record["id"]))
            assert row is not None
            assert row.document_s3_key == key
            assert row.expiry_date == expiry


# ---------------------------------------------------------------------------
# PATCH /credentials/validations/{id}/review
# ---------------------------------------------------------------------------


class TestReviewValidation:
    async def test_admin_can_approve(self, client: AsyncClient, chw_tokens: dict):
        """Admin approve sets validation_status=verified, validated_by, validated_at."""
        admin_tokens = await _register_admin(client)
        record = await _create_validation(client, chw_tokens)

        res = await client.patch(
            f"{BASE}/validations/{record['id']}/review",
            headers=_auth(admin_tokens),
            params={"approved": "true", "notes": "All documents verified."},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["validation_status"] == "verified"
        assert data["validated_at"] is not None
        assert data["notes"] == "All documents verified."

    async def test_admin_can_reject(self, client: AsyncClient, chw_tokens: dict):
        """Admin reject sets validation_status=rejected."""
        admin_tokens = await _register_admin(client)
        record = await _create_validation(client, chw_tokens)

        res = await client.patch(
            f"{BASE}/validations/{record['id']}/review",
            headers=_auth(admin_tokens),
            params={"approved": "false", "notes": "Certificate number mismatch."},
        )
        assert res.status_code == 200
        assert res.json()["validation_status"] == "rejected"

    async def test_admin_review_sets_validated_by_in_db(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """validated_by must be set to the admin's user id — confirmed via DB."""
        admin_tokens = await _register_admin(client)
        record = await _create_validation(client, chw_tokens)
        admin_id = _user_id(admin_tokens)

        await client.patch(
            f"{BASE}/validations/{record['id']}/review",
            headers=_auth(admin_tokens),
            params={"approved": "true"},
        )

        async with _test_session_factory() as db:
            row = await db.get(CHWCredentialValidation, uuid.UUID(record["id"]))
            assert row is not None
            assert str(row.validated_by) == admin_id
            assert row.validated_at is not None

    async def test_owning_chw_cannot_review(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """Critical: owning CHW must NOT be able to approve their own credentials."""
        record = await _create_validation(client, chw_tokens)

        res = await client.patch(
            f"{BASE}/validations/{record['id']}/review",
            headers=_auth(chw_tokens),
            params={"approved": "true"},
        )
        assert res.status_code == 403

    async def test_different_chw_cannot_review(self, client: AsyncClient, chw_tokens: dict):
        """A second CHW must not be able to review any credential via this endpoint."""
        chw2_tokens = await _register_chw(client, "chw2review@example.com")
        record = await _create_validation(client, chw_tokens)

        res = await client.patch(
            f"{BASE}/validations/{record['id']}/review",
            headers=_auth(chw2_tokens),
            params={"approved": "true"},
        )
        assert res.status_code == 403

    async def test_member_cannot_review(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ):
        record = await _create_validation(client, chw_tokens)

        res = await client.patch(
            f"{BASE}/validations/{record['id']}/review",
            headers=_auth(member_tokens),
            params={"approved": "true"},
        )
        assert res.status_code == 403

    async def test_unauthenticated_cannot_review(
        self, client: AsyncClient, chw_tokens: dict
    ):
        record = await _create_validation(client, chw_tokens)
        res = await client.patch(
            f"{BASE}/validations/{record['id']}/review",
            params={"approved": "true"},
        )
        assert res.status_code in (401, 403)

    async def test_review_nonexistent_record_returns_404(self, client: AsyncClient):
        admin_tokens = await _register_admin(client)
        phantom_id = str(uuid.uuid4())

        res = await client.patch(
            f"{BASE}/validations/{phantom_id}/review",
            headers=_auth(admin_tokens),
            params={"approved": "true"},
        )
        assert res.status_code == 404


# ---------------------------------------------------------------------------
# GET /credentials/institutions
# ---------------------------------------------------------------------------


class TestInstitutionLookup:
    async def test_institutions_is_unauthenticated(self, client: AsyncClient, chw_tokens: dict):
        """Endpoint must be reachable without a token (open lookup).

        The router attaches no auth dependency to GET /institutions, so callers
        on the registration flow can search institutions before logging in.
        """
        # Seed one institution via a CHW submission
        await _create_validation(client, chw_tokens)

        res = await client.get(f"{BASE}/institutions")
        assert res.status_code == 200
        assert isinstance(res.json(), list)

    async def test_institutions_empty_list_when_none_seeded(self, client: AsyncClient):
        res = await client.get(f"{BASE}/institutions")
        assert res.status_code == 200
        assert res.json() == []

    async def test_institutions_search_by_q_returns_match(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """?q= filters by ilike — should return the matching institution."""
        await _create_validation(
            client, chw_tokens, institution_name="HealthPath Community College"
        )
        await _create_validation(
            client, chw_tokens, institution_name="Urban Wellness Institute", certificate_number="UWI-001"
        )

        res = await client.get(f"{BASE}/institutions", params={"q": "healthpath"})
        assert res.status_code == 200
        names = [r["name"] for r in res.json()]
        assert "HealthPath Community College" in names
        assert "Urban Wellness Institute" not in names

    async def test_institutions_empty_q_returns_all(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """Empty ?q= (or omitted) must return all institutions (up to limit=20)."""
        await _create_validation(
            client, chw_tokens, institution_name="Alpha Institute"
        )
        await _create_validation(
            client, chw_tokens, institution_name="Beta Academy", certificate_number="BA-001"
        )

        res = await client.get(f"{BASE}/institutions", params={"q": ""})
        assert res.status_code == 200
        assert len(res.json()) == 2

    async def test_institutions_search_case_insensitive(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """ilike means uppercase query must still match lowercase stored name."""
        await _create_validation(
            client, chw_tokens, institution_name="riverdale health center"
        )

        res = await client.get(f"{BASE}/institutions", params={"q": "RIVERDALE"})
        assert res.status_code == 200
        assert len(res.json()) == 1

    async def test_institutions_search_no_match_returns_empty(
        self, client: AsyncClient, chw_tokens: dict
    ):
        await _create_validation(client, chw_tokens, institution_name="Gamma School")

        res = await client.get(f"{BASE}/institutions", params={"q": "zzznomatch"})
        assert res.status_code == 200
        assert res.json() == []

    async def test_institution_response_shape(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """Response must include id, name, contact_email, programs_offered, accreditation_status."""
        await _create_validation(
            client,
            chw_tokens,
            institution_name="Delta University",
            institution_contact_email="delta@example.com",
        )

        res = await client.get(f"{BASE}/institutions", params={"q": "delta"})
        assert res.status_code == 200
        item = res.json()[0]
        assert "id" in item
        assert item["name"] == "Delta University"
        assert item["contact_email"] == "delta@example.com"
        assert "programs_offered" in item
        assert "accreditation_status" in item
