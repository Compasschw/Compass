"""Integration tests for the MemberDocuments endpoints.

Coverage:
  1.  POST   /members/{id}/documents — member uploads own document → 201.
  2.  POST   /members/{id}/documents — member cannot upload to another member → 403.
  3.  POST   /members/{id}/documents — CHW with relationship can upload → 201.
  4.  POST   /members/{id}/documents — CHW without relationship is blocked → 403.
  5.  POST   /members/{id}/documents — invalid content_type → 422.
  6.  POST   /members/{id}/documents — size_bytes exceeds cap → 422.
  7.  GET    /members/{id}/documents — member reads own documents → 200 paginated.
  8.  GET    /members/{id}/documents — member cannot read another member's → 403.
  9.  GET    /members/{id}/documents — CHW with relationship can read → 200.
  10. DELETE /documents/{doc_id}     — uploader can soft-delete → 204.
  11. DELETE /documents/{doc_id}     — owner member can soft-delete → 204.
  12. DELETE /documents/{doc_id}     — unrelated user is blocked → 403.
  13. DELETE /documents/{doc_id}     — already-deleted → 404.
  14. GET    /documents/{doc_id}/download-url — returns presigned URL (mocked).
  15. GET    /documents/{doc_id}/download-url — CHW without relationship → 403.
"""

import uuid
from unittest.mock import patch

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header

# ─── Helpers ──────────────────────────────────────────────────────────────────

VALID_DOC_PAYLOAD = {
    "document_type": "id",
    "filename": "passport.pdf",
    "s3_url": "https://compass-prod-member-documents.s3.us-west-2.amazonaws.com/users/abc/member_document/passport.pdf",
    "s3_key": "users/abc/member_document/passport.pdf",
    "content_type": "application/pdf",
    "size_bytes": 1_048_576,  # 1 MB
}


async def _register(client: AsyncClient, email: str, role: str) -> dict:
    """Register a user and return the token payload.

    Members must supply every Pear-required signup field (#14); the CIN is
    derived from the email so concurrent registrations stay distinct.
    """
    payload: dict = {
        "email": email,
        "password": "testpass123",
        "name": f"Test {role.upper()} {email[:8]}",
        "role": role,
    }
    if role == "member":
        payload.update({
            "date_of_birth": "1990-01-01",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
            "zip_code": "90001",
            "terms_accepted": True,
            "communications_consent": True,
        })
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


async def _establish_relationship(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> None:
    """Create a ServiceRequest and have the CHW accept it — establishes the care relationship."""
    res = await client.post("/api/v1/requests/", json={
        "vertical": "food",
        "urgency": "routine",
        "description": "Need food assistance",
        "preferred_mode": "in_person",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text


async def _get_member_user_id(client: AsyncClient, member_tokens: dict) -> str:
    """Return the member's User.id (the UUID used in path params)."""
    res = await client.get("/api/v1/member/profile", headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
    return res.json()["user_id"]


# ─── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
async def member_tokens(client: AsyncClient) -> dict:
    return await _register(client, "member_doc_test@example.com", "member")


@pytest.fixture
async def member2_tokens(client: AsyncClient) -> dict:
    return await _register(client, "member_doc_test2@example.com", "member")


@pytest.fixture
async def chw_tokens(client: AsyncClient) -> dict:
    return await _register(client, "chw_doc_test@example.com", "chw")


@pytest.fixture
async def chw2_tokens(client: AsyncClient) -> dict:
    return await _register(client, "chw_doc_test2@example.com", "chw")


@pytest.fixture
async def member_id(client: AsyncClient, member_tokens: dict) -> str:
    return await _get_member_user_id(client, member_tokens)


@pytest.fixture
async def member2_id(client: AsyncClient, member2_tokens: dict) -> str:
    return await _get_member_user_id(client, member2_tokens)


# ─── POST — create document ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_member_uploads_own_document(
    client: AsyncClient, member_tokens: dict, member_id: str
) -> None:
    """Test 1 — Member can upload a document to their own folder."""
    res = await client.post(
        f"/api/v1/members/{member_id}/documents",
        json=VALID_DOC_PAYLOAD,
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["document_type"] == "id"
    assert body["filename"] == "passport.pdf"
    assert body["content_type"] == "application/pdf"
    # s3_url must NOT be in the response.
    assert "s3_url" not in body


@pytest.mark.asyncio
async def test_member_cannot_upload_to_other_member(
    client: AsyncClient, member_tokens: dict, member2_id: str
) -> None:
    """Test 2 — Member cannot upload to another member's folder."""
    res = await client.post(
        f"/api/v1/members/{member2_id}/documents",
        json=VALID_DOC_PAYLOAD,
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_chw_with_relationship_can_upload(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict, member_id: str
) -> None:
    """Test 3 — CHW with care relationship can upload on behalf of member."""
    await _establish_relationship(client, member_tokens, chw_tokens)
    res = await client.post(
        f"/api/v1/members/{member_id}/documents",
        json={**VALID_DOC_PAYLOAD, "document_type": "income"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["document_type"] == "income"


@pytest.mark.asyncio
async def test_chw_without_relationship_cannot_upload(
    client: AsyncClient, chw2_tokens: dict, member_id: str
) -> None:
    """Test 4 — CHW without a relationship is blocked."""
    res = await client.post(
        f"/api/v1/members/{member_id}/documents",
        json=VALID_DOC_PAYLOAD,
        headers=auth_header(chw2_tokens),
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_invalid_content_type_rejected(
    client: AsyncClient, member_tokens: dict, member_id: str
) -> None:
    """Test 5 — Disallowed MIME type returns 422."""
    res = await client.post(
        f"/api/v1/members/{member_id}/documents",
        json={**VALID_DOC_PAYLOAD, "content_type": "text/plain"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_size_exceeds_cap_rejected(
    client: AsyncClient, member_tokens: dict, member_id: str
) -> None:
    """Test 6 — File > 20 MB returns 422."""
    res = await client.post(
        f"/api/v1/members/{member_id}/documents",
        json={**VALID_DOC_PAYLOAD, "size_bytes": 21 * 1024 * 1024},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 422


# ─── GET — list documents ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_member_lists_own_documents(
    client: AsyncClient, member_tokens: dict, member_id: str
) -> None:
    """Test 7 — Member can list their own documents (paginated)."""
    # Upload two documents first.
    for doc_type in ("id", "income"):
        res = await client.post(
            f"/api/v1/members/{member_id}/documents",
            json={**VALID_DOC_PAYLOAD, "document_type": doc_type},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 201, res.text

    res = await client.get(
        f"/api/v1/members/{member_id}/documents",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["total"] == 2
    assert len(body["items"]) == 2
    # Newest first.
    assert body["items"][0]["document_type"] in {"id", "income"}


@pytest.mark.asyncio
async def test_member_cannot_list_other_members_documents(
    client: AsyncClient, member_tokens: dict, member2_id: str
) -> None:
    """Test 8 — Member cannot read another member's documents."""
    res = await client.get(
        f"/api/v1/members/{member2_id}/documents",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_chw_with_relationship_can_list(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict, member_id: str
) -> None:
    """Test 9 — CHW with relationship can list member documents."""
    await _establish_relationship(client, member_tokens, chw_tokens)
    # Upload a document as the member.
    await client.post(
        f"/api/v1/members/{member_id}/documents",
        json=VALID_DOC_PAYLOAD,
        headers=auth_header(member_tokens),
    )
    res = await client.get(
        f"/api/v1/members/{member_id}/documents",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["total"] >= 1


# ─── DELETE — soft-delete ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_uploader_can_delete(
    client: AsyncClient, member_tokens: dict, member_id: str
) -> None:
    """Test 10 — Uploader (the member) can soft-delete their own document."""
    create_res = await client.post(
        f"/api/v1/members/{member_id}/documents",
        json=VALID_DOC_PAYLOAD,
        headers=auth_header(member_tokens),
    )
    assert create_res.status_code == 201
    doc_id = create_res.json()["id"]

    del_res = await client.delete(
        f"/api/v1/documents/{doc_id}",
        headers=auth_header(member_tokens),
    )
    assert del_res.status_code == 204

    # Confirm it no longer appears in the list.
    list_res = await client.get(
        f"/api/v1/members/{member_id}/documents",
        headers=auth_header(member_tokens),
    )
    assert list_res.json()["total"] == 0


@pytest.mark.asyncio
async def test_owner_member_can_delete_chw_uploaded_doc(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict, member_id: str
) -> None:
    """Test 11 — Member (owner) can delete a document that a CHW uploaded for them."""
    await _establish_relationship(client, member_tokens, chw_tokens)
    create_res = await client.post(
        f"/api/v1/members/{member_id}/documents",
        json=VALID_DOC_PAYLOAD,
        headers=auth_header(chw_tokens),
    )
    assert create_res.status_code == 201
    doc_id = create_res.json()["id"]

    del_res = await client.delete(
        f"/api/v1/documents/{doc_id}",
        headers=auth_header(member_tokens),
    )
    assert del_res.status_code == 204


@pytest.mark.asyncio
async def test_unrelated_user_cannot_delete(
    client: AsyncClient, member_tokens: dict, chw2_tokens: dict, member_id: str
) -> None:
    """Test 12 — A CHW with no relationship to the member cannot delete their document."""
    create_res = await client.post(
        f"/api/v1/members/{member_id}/documents",
        json=VALID_DOC_PAYLOAD,
        headers=auth_header(member_tokens),
    )
    assert create_res.status_code == 201
    doc_id = create_res.json()["id"]

    del_res = await client.delete(
        f"/api/v1/documents/{doc_id}",
        headers=auth_header(chw2_tokens),
    )
    assert del_res.status_code == 403


@pytest.mark.asyncio
async def test_delete_already_deleted_returns_404(
    client: AsyncClient, member_tokens: dict, member_id: str
) -> None:
    """Test 13 — Deleting an already-deleted document returns 404."""
    create_res = await client.post(
        f"/api/v1/members/{member_id}/documents",
        json=VALID_DOC_PAYLOAD,
        headers=auth_header(member_tokens),
    )
    assert create_res.status_code == 201
    doc_id = create_res.json()["id"]

    await client.delete(f"/api/v1/documents/{doc_id}", headers=auth_header(member_tokens))
    second_del = await client.delete(
        f"/api/v1/documents/{doc_id}", headers=auth_header(member_tokens)
    )
    assert second_del.status_code == 404


# ─── Download URL ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_download_url_returned_for_authorized_user(
    client: AsyncClient, member_tokens: dict, member_id: str
) -> None:
    """Test 14 — Authorized member gets a presigned download URL."""
    create_res = await client.post(
        f"/api/v1/members/{member_id}/documents",
        json=VALID_DOC_PAYLOAD,
        headers=auth_header(member_tokens),
    )
    assert create_res.status_code == 201
    doc_id = create_res.json()["id"]

    # Mock S3 so the test doesn't need real AWS credentials.
    fake_url = "https://s3.us-west-2.amazonaws.com/fake-presigned-url?X-Amz-Signature=abc"
    with patch(
        "app.routers.member_documents.generate_presigned_download_url",
        return_value=fake_url,
    ):
        res = await client.get(
            f"/api/v1/documents/{doc_id}/download-url",
            headers=auth_header(member_tokens),
        )

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["download_url"] == fake_url
    assert body["expires_in_seconds"] == 900


@pytest.mark.asyncio
async def test_download_url_chw_without_relationship_blocked(
    client: AsyncClient, member_tokens: dict, chw2_tokens: dict, member_id: str
) -> None:
    """Test 15 — CHW without relationship cannot get download URL."""
    create_res = await client.post(
        f"/api/v1/members/{member_id}/documents",
        json=VALID_DOC_PAYLOAD,
        headers=auth_header(member_tokens),
    )
    assert create_res.status_code == 201
    doc_id = create_res.json()["id"]

    res = await client.get(
        f"/api/v1/documents/{doc_id}/download-url",
        headers=auth_header(chw2_tokens),
    )
    assert res.status_code == 403
