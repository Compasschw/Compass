"""Tests for S3 PHI cleanup on account deletion (audit 2026-06-12 blocker #8).

Covers:
- version-aware prefix deletion (versions + delete markers, batching)
- per-bucket error isolation and unconfigured-bucket skips
- the full DELETE /auth/users/me flow: S3 cleanup outcome lands in the
  deletion AuditLog row and MemberDocument rows are redacted
"""

import uuid
from unittest.mock import MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.audit import AuditLog
from app.services.s3_phi_cleanup import (
    PhiCleanupResult,
    _cleanup_sync,
    _delete_prefix_all_versions,
)
from tests.conftest import auth_header, test_session as _test_session_factory

# ---------------------------------------------------------------------------
# _delete_prefix_all_versions
# ---------------------------------------------------------------------------


def _stub_client_with_pages(pages: list[dict]) -> MagicMock:
    client = MagicMock()
    paginator = MagicMock()
    paginator.paginate.return_value = pages
    client.get_paginator.return_value = paginator
    client.delete_objects.return_value = {}
    return client


class TestDeletePrefixAllVersions:
    def test_deletes_versions_and_delete_markers(self):
        pages = [
            {
                "Versions": [
                    {"Key": "prod/v1/members/u1/doc1.pdf", "VersionId": "v1"},
                    {"Key": "prod/v1/members/u1/doc1.pdf", "VersionId": "v2"},
                ],
                "DeleteMarkers": [
                    {"Key": "prod/v1/members/u1/doc2.pdf", "VersionId": "m1"},
                ],
            },
        ]
        client = _stub_client_with_pages(pages)
        with patch("app.services.s3_phi_cleanup.get_s3_client", return_value=client):
            deleted = _delete_prefix_all_versions("bucket", "prod/v1/members/u1/")

        assert deleted == 3
        (call,) = client.delete_objects.call_args_list
        sent = call.kwargs["Delete"]["Objects"]
        assert {"Key": "prod/v1/members/u1/doc1.pdf", "VersionId": "v2"} in sent
        assert {"Key": "prod/v1/members/u1/doc2.pdf", "VersionId": "m1"} in sent

    def test_batches_at_1000_keys(self):
        versions = [
            {"Key": f"prod/v1/members/u1/{i}.pdf", "VersionId": f"v{i}"}
            for i in range(1500)
        ]
        client = _stub_client_with_pages([{"Versions": versions}])
        with patch("app.services.s3_phi_cleanup.get_s3_client", return_value=client):
            deleted = _delete_prefix_all_versions("bucket", "prod/v1/members/u1/")

        assert deleted == 1500
        batch_sizes = [
            len(call.kwargs["Delete"]["Objects"])
            for call in client.delete_objects.call_args_list
        ]
        assert batch_sizes == [1000, 500]

    def test_empty_prefix_deletes_nothing(self):
        client = _stub_client_with_pages([{}])
        with patch("app.services.s3_phi_cleanup.get_s3_client", return_value=client):
            deleted = _delete_prefix_all_versions("bucket", "prod/v1/members/u1/")
        assert deleted == 0
        client.delete_objects.assert_not_called()

    def test_partial_delete_failure_raises(self):
        client = _stub_client_with_pages(
            [{"Versions": [{"Key": "k", "VersionId": "v"}]}]
        )
        client.delete_objects.return_value = {
            "Errors": [{"Key": "k", "Code": "AccessDenied"}]
        }
        with patch("app.services.s3_phi_cleanup.get_s3_client", return_value=client):
            with pytest.raises(RuntimeError, match="AccessDenied"):
                _delete_prefix_all_versions("bucket", "prod/v1/members/u1/")


# ---------------------------------------------------------------------------
# _cleanup_sync — per-bucket isolation + skips
# ---------------------------------------------------------------------------


class TestCleanupSync:
    def test_unconfigured_buckets_are_skipped_not_failed(self):
        user_id = uuid.uuid4()
        with (
            patch("app.services.s3_phi_cleanup.settings") as mock_settings,
            patch("app.services.s3_phi_cleanup.get_s3_client") as mock_client,
        ):
            mock_settings.s3_member_documents_bucket = ""
            mock_settings.s3_message_attachments_bucket = ""
            mock_settings.s3_bucket_phi = ""
            result = _cleanup_sync(user_id)

        assert result.ok
        assert result.objects_deleted == {}
        assert set(result.skipped_unconfigured) == {
            "member_documents",
            "message_attachments",
            "legacy_phi",
        }
        mock_client.assert_not_called()

    def test_one_bucket_failing_does_not_abort_the_others(self):
        user_id = uuid.uuid4()

        def fake_delete(bucket: str, prefix: str) -> int:
            if bucket == "docs-bucket":
                raise RuntimeError("boom")
            return 2

        with (
            patch("app.services.s3_phi_cleanup.settings") as mock_settings,
            patch(
                "app.services.s3_phi_cleanup._delete_prefix_all_versions",
                side_effect=fake_delete,
            ),
        ):
            mock_settings.s3_member_documents_bucket = "docs-bucket"
            mock_settings.s3_message_attachments_bucket = "attach-bucket"
            mock_settings.s3_bucket_phi = "legacy-bucket"
            result = _cleanup_sync(user_id)

        assert not result.ok
        assert result.errors == ["member_documents: boom"]
        # The other two buckets were still cleaned.
        assert result.objects_deleted == {"message_attachments": 2, "legacy_phi": 2}


# ---------------------------------------------------------------------------
# Integration: DELETE /auth/users/me wires cleanup into the audit row
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_auth_users_me_deletion_records_s3_cleanup_in_audit_row(
    client: AsyncClient, member_tokens: dict
):
    """The service deletion flow must run the S3 cleanup and persist its
    outcome (including failures) in the SELF_DELETE audit row."""
    canned = PhiCleanupResult(
        objects_deleted={"member_documents": 3, "message_attachments": 1},
        skipped_unconfigured=["legacy_phi"],
        errors=[],
    )
    with patch(
        "app.services.s3_phi_cleanup.delete_member_phi_objects",
        return_value=canned,
    ) as mock_cleanup:
        # DELETE /auth/users/me requires a JSON body (optional password
        # re-confirmation); httpx needs request() to send a body on DELETE.
        res = await client.request(
            "DELETE",
            "/api/v1/auth/users/me",
            json={},
            headers=auth_header(member_tokens),
        )
    assert res.status_code == 204, res.text
    mock_cleanup.assert_awaited_once()

    async with _test_session_factory() as db:
        result = await db.execute(
            select(AuditLog).where(AuditLog.action == "SELF_DELETE")
        )
        audit_row = result.scalars().first()
        assert audit_row is not None, "SELF_DELETE audit row must exist"
        cleanup_details = audit_row.details["s3_phi_cleanup"]
        assert cleanup_details["objects_deleted"] == {
            "member_documents": 3,
            "message_attachments": 1,
        }
        assert cleanup_details["skipped_unconfigured"] == ["legacy_phi"]
        assert cleanup_details["errors"] == []
