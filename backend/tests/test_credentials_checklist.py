"""Tests for the Epic D compliance-checklist endpoints on /api/v1/credentials/*.

Covers:
- POST /credentials/{type}            CHW upsert (pending, cannot self-verify)
- GET  /credentials/mine              CHW's own Credential rows
- GET  /credentials/checklist         full 5-item checklist + can_work/missing
- PATCH /credentials/{id}/review      admin-only verify/reject
- GET  /credentials/{id}/download-url owning CHW or admin -> presigned GET URL

Negative-auth boundaries (backend/TESTING.md rule 1):
- A CHW cannot set status=verified via POST /credentials/{type} (schema doesn't
  expose the field at all).
- A CHW (even the owning CHW) gets 403 on PATCH /credentials/{id}/review.
- A member gets 403 on both CHW-facing and admin-facing endpoints.
- An unauthenticated caller gets 401/403 everywhere.
- GET /credentials/{id}/download-url: a DIFFERENT CHW (CHW A fetching CHW B's
  credential) must get 403 — the QA batch #7 (Part 7) review-blind-spot fix.
"""

import uuid
from unittest.mock import patch

import pytest
from httpx import AsyncClient

from app.models.credential import Credential
from app.utils.security import decode_token, hash_password
from tests.conftest import test_session as _test_session_factory

BASE = "/api/v1/credentials"

DOCUMENT_TYPES = (
    "hipaa_training",
    "professional_service_agreement",
    "liability_insurance",
    "chw_certification",
)


def _auth(tokens: dict) -> dict[str, str]:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def _user_id(tokens: dict) -> str:
    payload = decode_token(tokens["access_token"])
    assert payload is not None
    return payload["sub"]


def _valid_s3_key(chw_id: str, filename: str = "cert.pdf") -> str:
    return f"users/{chw_id}/credential/{filename}"


async def _register_admin(client: AsyncClient, email: str = "admin-checklist@example.com") -> dict:
    from app.models.user import User

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

    res = await client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert res.status_code == 200, f"admin login failed: {res.text}"
    return res.json()


async def _register_chw(client: AsyncClient, email: str = "chw-checklist2@example.com") -> dict:
    res = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Testpass123!", "name": "Second CHW", "role": "chw"},
    )
    assert res.status_code == 201, res.text
    return res.json()


# ---------------------------------------------------------------------------
# POST /credentials/{type}
# ---------------------------------------------------------------------------


class TestSubmitCredential:
    @pytest.mark.parametrize("cred_type", DOCUMENT_TYPES)
    async def test_chw_can_submit_each_type(self, client: AsyncClient, chw_tokens: dict, cred_type: str):
        chw_id = _user_id(chw_tokens)
        res = await client.post(
            f"{BASE}/{cred_type}",
            headers=_auth(chw_tokens),
            json={"s3_key": _valid_s3_key(chw_id)},
        )
        assert res.status_code == 201, res.text
        data = res.json()
        assert data["type"] == cred_type
        assert data["status"] == "pending"
        assert data["chw_id"] == chw_id

    async def test_unknown_type_returns_404(self, client: AsyncClient, chw_tokens: dict):
        chw_id = _user_id(chw_tokens)
        res = await client.post(
            f"{BASE}/not_a_real_type",
            headers=_auth(chw_tokens),
            json={"s3_key": _valid_s3_key(chw_id)},
        )
        assert res.status_code == 404

    async def test_member_cannot_submit(self, client: AsyncClient, member_tokens: dict):
        res = await client.post(
            f"{BASE}/hipaa_training",
            headers=_auth(member_tokens),
            json={"s3_key": _valid_s3_key(str(uuid.uuid4()))},
        )
        assert res.status_code == 403

    async def test_unauthenticated_cannot_submit(self, client: AsyncClient):
        res = await client.post(
            f"{BASE}/hipaa_training",
            json={"s3_key": _valid_s3_key(str(uuid.uuid4()))},
        )
        assert res.status_code in (401, 403)

    async def test_invalid_s3_key_shape_rejected(self, client: AsyncClient, chw_tokens: dict):
        """Must match users/<uuid>/credential/<file>.pdf — not the CHWCredentialValidation shape."""
        res = await client.post(
            f"{BASE}/hipaa_training",
            headers=_auth(chw_tokens),
            json={"s3_key": "credentials/not-the-right/shape.pdf"},
        )
        assert res.status_code == 422

    async def test_full_url_rejected(self, client: AsyncClient, chw_tokens: dict):
        res = await client.post(
            f"{BASE}/hipaa_training",
            headers=_auth(chw_tokens),
            json={"s3_key": "https://s3.amazonaws.com/bucket/file.pdf"},
        )
        assert res.status_code == 422

    async def test_cannot_self_set_status_verified(self, client: AsyncClient, chw_tokens: dict):
        """CredentialSubmit exposes only s3_key — 'status' in the body must be
        silently ignored, never set the row to verified."""
        chw_id = _user_id(chw_tokens)
        res = await client.post(
            f"{BASE}/hipaa_training",
            headers=_auth(chw_tokens),
            json={"s3_key": _valid_s3_key(chw_id), "status": "verified"},
        )
        assert res.status_code == 201
        assert res.json()["status"] == "pending"

    async def test_resubmit_upserts_not_duplicates(self, client: AsyncClient, chw_tokens: dict):
        """Second submission of the SAME type must UPDATE the existing row,
        not create a second one (upsert semantics on chw_id+type)."""
        chw_id = _user_id(chw_tokens)
        first = await client.post(
            f"{BASE}/hipaa_training",
            headers=_auth(chw_tokens),
            json={"s3_key": _valid_s3_key(chw_id, "v1.pdf")},
        )
        assert first.status_code == 201
        second = await client.post(
            f"{BASE}/hipaa_training",
            headers=_auth(chw_tokens),
            json={"s3_key": _valid_s3_key(chw_id, "v2.pdf")},
        )
        assert second.status_code == 201
        assert second.json()["id"] == first.json()["id"]
        assert second.json()["s3_key"] == _valid_s3_key(chw_id, "v2.pdf")

        async with _test_session_factory() as db:
            result = await db.execute(
                Credential.__table__.select().where(
                    Credential.chw_id == uuid.UUID(chw_id), Credential.type == "hipaa_training"
                )
            )
            rows = result.fetchall()
        assert len(rows) == 1

    async def test_resubmit_after_rejection_resets_to_pending(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """Re-uploading after an admin rejection must reset status to pending
        and clear verified_by/verified_at — re-entering the review queue."""
        chw_id = _user_id(chw_tokens)
        submit = await client.post(
            f"{BASE}/hipaa_training",
            headers=_auth(chw_tokens),
            json={"s3_key": _valid_s3_key(chw_id)},
        )
        cred_id = submit.json()["id"]

        admin_tokens = await _register_admin(client)
        review = await client.patch(
            f"{BASE}/{cred_id}/review",
            headers=_auth(admin_tokens),
            json={"approved": False, "notes": "Blurry scan"},
        )
        assert review.status_code == 200
        assert review.json()["status"] == "rejected"

        resubmit = await client.post(
            f"{BASE}/hipaa_training",
            headers=_auth(chw_tokens),
            json={"s3_key": _valid_s3_key(chw_id, "v2.pdf")},
        )
        assert resubmit.status_code == 201
        data = resubmit.json()
        assert data["status"] == "pending"
        assert data["verified_by"] is None
        assert data["verified_at"] is None


# ---------------------------------------------------------------------------
# GET /credentials/mine
# ---------------------------------------------------------------------------


class TestListMyCredentials:
    async def test_chw_sees_only_own_rows(self, client: AsyncClient, chw_tokens: dict):
        chw_id = _user_id(chw_tokens)
        await client.post(
            f"{BASE}/hipaa_training", headers=_auth(chw_tokens), json={"s3_key": _valid_s3_key(chw_id)}
        )

        chw2_tokens = await _register_chw(client)
        chw2_id = _user_id(chw2_tokens)
        await client.post(
            f"{BASE}/hipaa_training", headers=_auth(chw2_tokens), json={"s3_key": _valid_s3_key(chw2_id)}
        )

        res = await client.get(f"{BASE}/mine", headers=_auth(chw_tokens))
        assert res.status_code == 200
        rows = res.json()
        assert len(rows) == 1
        assert rows[0]["chw_id"] == chw_id

    async def test_empty_for_new_chw(self, client: AsyncClient, chw_tokens: dict):
        res = await client.get(f"{BASE}/mine", headers=_auth(chw_tokens))
        assert res.status_code == 200
        assert res.json() == []

    async def test_member_cannot_list(self, client: AsyncClient, member_tokens: dict):
        res = await client.get(f"{BASE}/mine", headers=_auth(member_tokens))
        assert res.status_code == 403

    async def test_unauthenticated_rejected(self, client: AsyncClient):
        res = await client.get(f"{BASE}/mine")
        assert res.status_code in (401, 403)


# ---------------------------------------------------------------------------
# GET /credentials/checklist
# ---------------------------------------------------------------------------


class TestChecklist:
    async def test_new_chw_checklist_shows_all_5_missing(self, client: AsyncClient, chw_tokens: dict):
        res = await client.get(f"{BASE}/checklist", headers=_auth(chw_tokens))
        assert res.status_code == 200
        data = res.json()
        assert data["can_work"] is False
        codes = {item["code"] for item in data["items"]}
        assert codes == {*DOCUMENT_TYPES, "background_check"}
        for item in data["items"]:
            if item["code"] == "background_check":
                # New CHW accounts default to "pending" (Epic D), not "not_started".
                assert item["status"] == "pending"
            else:
                assert item["status"] == "missing"

    async def test_checklist_reflects_pending_after_upload(self, client: AsyncClient, chw_tokens: dict):
        chw_id = _user_id(chw_tokens)
        await client.post(
            f"{BASE}/hipaa_training", headers=_auth(chw_tokens), json={"s3_key": _valid_s3_key(chw_id)}
        )
        res = await client.get(f"{BASE}/checklist", headers=_auth(chw_tokens))
        data = res.json()
        item = next(i for i in data["items"] if i["code"] == "hipaa_training")
        assert item["status"] == "pending"
        assert "hipaa_training" in data["missing"]

    async def test_member_cannot_view_checklist(self, client: AsyncClient, member_tokens: dict):
        res = await client.get(f"{BASE}/checklist", headers=_auth(member_tokens))
        assert res.status_code == 403

    async def test_unauthenticated_rejected(self, client: AsyncClient):
        res = await client.get(f"{BASE}/checklist")
        assert res.status_code in (401, 403)


# ---------------------------------------------------------------------------
# PATCH /credentials/{id}/review
# ---------------------------------------------------------------------------


class TestReviewCredential:
    async def _submit(self, client: AsyncClient, tokens: dict, cred_type: str = "hipaa_training") -> dict:
        chw_id = _user_id(tokens)
        res = await client.post(
            f"{BASE}/{cred_type}", headers=_auth(tokens), json={"s3_key": _valid_s3_key(chw_id)}
        )
        assert res.status_code == 201
        return res.json()

    async def test_admin_can_verify(self, client: AsyncClient, chw_tokens: dict):
        record = await self._submit(client, chw_tokens)
        admin_tokens = await _register_admin(client)

        res = await client.patch(
            f"{BASE}/{record['id']}/review",
            headers=_auth(admin_tokens),
            json={"approved": True, "notes": "Looks good"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "verified"
        assert data["verified_at"] is not None
        assert data["verified_by"] == _user_id(admin_tokens)

    async def test_admin_can_reject(self, client: AsyncClient, chw_tokens: dict):
        record = await self._submit(client, chw_tokens)
        admin_tokens = await _register_admin(client)

        res = await client.patch(
            f"{BASE}/{record['id']}/review",
            headers=_auth(admin_tokens),
            json={"approved": False},
        )
        assert res.status_code == 200
        assert res.json()["status"] == "rejected"

    async def test_owning_chw_cannot_review_own_credential(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """Critical negative-auth: a CHW must NOT be able to self-verify."""
        record = await self._submit(client, chw_tokens)

        res = await client.patch(
            f"{BASE}/{record['id']}/review",
            headers=_auth(chw_tokens),
            json={"approved": True},
        )
        assert res.status_code == 403

        async with _test_session_factory() as db:
            row = await db.get(Credential, uuid.UUID(record["id"]))
            assert row.status == "pending"

    async def test_different_chw_cannot_review(self, client: AsyncClient, chw_tokens: dict):
        record = await self._submit(client, chw_tokens)
        chw2_tokens = await _register_chw(client)

        res = await client.patch(
            f"{BASE}/{record['id']}/review",
            headers=_auth(chw2_tokens),
            json={"approved": True},
        )
        assert res.status_code == 403

    async def test_member_cannot_review(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ):
        record = await self._submit(client, chw_tokens)
        res = await client.patch(
            f"{BASE}/{record['id']}/review",
            headers=_auth(member_tokens),
            json={"approved": True},
        )
        assert res.status_code == 403

    async def test_unauthenticated_cannot_review(self, client: AsyncClient, chw_tokens: dict):
        record = await self._submit(client, chw_tokens)
        res = await client.patch(f"{BASE}/{record['id']}/review", json={"approved": True})
        assert res.status_code in (401, 403)

    async def test_review_nonexistent_credential_returns_404(self, client: AsyncClient):
        admin_tokens = await _register_admin(client)
        res = await client.patch(
            f"{BASE}/{uuid.uuid4()}/review",
            headers=_auth(admin_tokens),
            json={"approved": True},
        )
        assert res.status_code == 404


# ---------------------------------------------------------------------------
# GET /credentials/{id}/download-url
# ---------------------------------------------------------------------------


class TestCredentialDownloadUrl:
    async def _submit(self, client: AsyncClient, tokens: dict, cred_type: str = "hipaa_training") -> dict:
        chw_id = _user_id(tokens)
        res = await client.post(
            f"{BASE}/{cred_type}", headers=_auth(tokens), json={"s3_key": _valid_s3_key(chw_id)}
        )
        assert res.status_code == 201, res.text
        return res.json()

    async def test_owning_chw_gets_presigned_url(self, client: AsyncClient, chw_tokens: dict):
        """Happy path: the owning CHW can fetch a download URL for their own upload."""
        record = await self._submit(client, chw_tokens)

        fake_url = "https://s3.us-west-2.amazonaws.com/fake-presigned-credential?X-Amz-Signature=abc"
        with patch(
            "app.routers.credentials.generate_presigned_download_url",
            return_value=fake_url,
        ):
            res = await client.get(
                f"{BASE}/{record['id']}/download-url", headers=_auth(chw_tokens)
            )

        assert res.status_code == 200, res.text
        body = res.json()
        assert body["download_url"] == fake_url
        assert body["expires_in_seconds"] == 900

    async def test_admin_gets_presigned_url_for_any_chw_credential(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """Admins can view any CHW's compliance document (fixes the sight-unseen
        review blind spot cited in Part 7)."""
        record = await self._submit(client, chw_tokens)
        admin_tokens = await _register_admin(client)

        fake_url = "https://s3.us-west-2.amazonaws.com/fake-presigned-credential?X-Amz-Signature=admin"
        with patch(
            "app.routers.credentials.generate_presigned_download_url",
            return_value=fake_url,
        ):
            res = await client.get(
                f"{BASE}/{record['id']}/download-url", headers=_auth(admin_tokens)
            )

        assert res.status_code == 200, res.text
        assert res.json()["download_url"] == fake_url

    async def test_different_chw_cannot_download_another_chws_credential(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """NEGATIVE-AUTH (TESTING.md rule 1): CHW A must not be able to fetch
        CHW B's credential download URL — relationship gate, not just role gate."""
        record = await self._submit(client, chw_tokens)
        chw2_tokens = await _register_chw(client, "chw-download-other@example.com")

        res = await client.get(
            f"{BASE}/{record['id']}/download-url", headers=_auth(chw2_tokens)
        )
        assert res.status_code == 403

    async def test_member_cannot_download_credential(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ):
        record = await self._submit(client, chw_tokens)
        res = await client.get(
            f"{BASE}/{record['id']}/download-url", headers=_auth(member_tokens)
        )
        assert res.status_code == 403

    async def test_unauthenticated_cannot_download(self, client: AsyncClient, chw_tokens: dict):
        record = await self._submit(client, chw_tokens)
        res = await client.get(f"{BASE}/{record['id']}/download-url")
        assert res.status_code in (401, 403)

    async def test_nonexistent_credential_returns_404(self, client: AsyncClient, chw_tokens: dict):
        res = await client.get(
            f"{BASE}/{uuid.uuid4()}/download-url", headers=_auth(chw_tokens)
        )
        assert res.status_code == 404

    async def test_credential_with_no_uploaded_file_returns_404(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """A Credential row can exist with s3_key=None in theory (the column is
        nullable) — must return a clean 404, not a 500 from S3 client misuse."""
        from app.models.credential import Credential

        chw_id = uuid.UUID(_user_id(chw_tokens))
        cred_id = uuid.uuid4()
        async with _test_session_factory() as db:
            db.add(
                Credential(
                    id=cred_id,
                    chw_id=chw_id,
                    type="liability_insurance",
                    label="Professional Liability Insurance",
                    status="pending",
                    s3_key=None,
                )
            )
            await db.commit()

        res = await client.get(f"{BASE}/{cred_id}/download-url", headers=_auth(chw_tokens))
        assert res.status_code == 404

    async def test_s3_failure_returns_clean_500_not_bare_error(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """NO-UNHANDLED-500 (TESTING.md rule 3): if the S3 client raises, the
        endpoint must still return a well-formed HTTPException with a readable
        detail (and, critically, still pass through CORSMiddleware)."""
        record = await self._submit(client, chw_tokens)

        with patch(
            "app.routers.credentials.generate_presigned_download_url",
            side_effect=RuntimeError("boto3 client misconfigured"),
        ):
            res = await client.get(
                f"{BASE}/{record['id']}/download-url", headers=_auth(chw_tokens)
            )

        assert res.status_code == 500
        assert "boto3 client misconfigured" in res.json()["detail"]


# ---------------------------------------------------------------------------
# Full end-to-end flow
# ---------------------------------------------------------------------------


class TestFullUploadToVerifyFlow:
    async def test_upload_pending_admin_verify_end_to_end(self, client: AsyncClient, chw_tokens: dict):
        chw_id = _user_id(chw_tokens)

        # 1. CHW uploads.
        submit_res = await client.post(
            f"{BASE}/chw_certification",
            headers=_auth(chw_tokens),
            json={"s3_key": _valid_s3_key(chw_id, "chw-cert.pdf")},
        )
        assert submit_res.status_code == 201
        assert submit_res.json()["status"] == "pending"

        # 2. Checklist reflects pending.
        checklist_res = await client.get(f"{BASE}/checklist", headers=_auth(chw_tokens))
        item = next(
            i for i in checklist_res.json()["items"] if i["code"] == "chw_certification"
        )
        assert item["status"] == "pending"

        # 3. Admin verifies.
        admin_tokens = await _register_admin(client)
        review_res = await client.patch(
            f"{BASE}/{submit_res.json()['id']}/review",
            headers=_auth(admin_tokens),
            json={"approved": True},
        )
        assert review_res.status_code == 200
        assert review_res.json()["status"] == "verified"

        # 4. Checklist now reflects verified.
        checklist_res_2 = await client.get(f"{BASE}/checklist", headers=_auth(chw_tokens))
        item2 = next(
            i for i in checklist_res_2.json()["items"] if i["code"] == "chw_certification"
        )
        assert item2["status"] == "verified"
        assert "chw_certification" not in checklist_res_2.json()["missing"]
