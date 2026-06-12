"""S3 PHI cleanup for account deletion — right-to-delete support.

Account deletion previously anonymised the database but left every uploaded
object (government IDs, income proof, message attachments) in S3 forever
(audit 2026-06-12 blocker #8). This service removes member-scoped objects
from the PHI buckets, including ALL versions and delete markers — the PHI
buckets are versioned, so a plain delete would only add a delete marker and
leave the bytes retrievable.

Scope — what is deleted vs retained:

  DELETED on account deletion (member-owned, not part of the billing/care
  audit record):
    - member documents     ``{s3_member_documents_bucket}/prod/v1/members/{user_id}/``
    - message attachments  ``{s3_message_attachments_bucket}/prod/v1/members/{user_id}/``
    - legacy uploads       ``{s3_bucket_phi}/users/{user_id}/``

  RETAINED (session care records — HIPAA 45 CFR §164.530(j) / Cal. H&S
  §123111 require 6-7 year retention; their buckets already carry a 7-year
  lifecycle):
    - call recordings, transcripts, AI summaries (keyed by session UUID,
      not member UUID — they are part of the documented care record)

All boto3 calls run in a worker thread so the async event loop never blocks.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field

from app.config import settings
from app.services.s3_service import get_s3_client

logger = logging.getLogger("compass.s3_phi_cleanup")

# delete_objects accepts at most 1000 keys per request.
_DELETE_BATCH_SIZE = 1000


@dataclass
class PhiCleanupResult:
    """Outcome of a member PHI cleanup across all buckets.

    ``objects_deleted`` counts object versions + delete markers removed,
    keyed by bucket name. ``skipped_unconfigured`` lists buckets whose
    setting was empty (dev environments). ``errors`` holds one
    "bucket: message" string per failed bucket — failures in one bucket
    never abort cleanup of the others.
    """

    objects_deleted: dict[str, int] = field(default_factory=dict)
    skipped_unconfigured: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        """True when no bucket failed (skipped-unconfigured is not a failure)."""
        return not self.errors

    def as_audit_details(self) -> dict:
        """Shape the result for embedding in the deletion AuditLog row."""
        return {
            "objects_deleted": self.objects_deleted,
            "skipped_unconfigured": self.skipped_unconfigured,
            "errors": self.errors,
        }


def _delete_prefix_all_versions(bucket: str, prefix: str) -> int:
    """Delete every object version and delete marker under ``prefix``.

    Synchronous (boto3) — call via ``asyncio.to_thread``. Returns the number
    of versions + markers deleted. Raises on S3 errors (caller decides how
    to record the failure).
    """
    client = get_s3_client()
    paginator = client.get_paginator("list_object_versions")
    deleted = 0
    batch: list[dict[str, str]] = []

    def _flush() -> None:
        nonlocal deleted, batch
        if not batch:
            return
        response = client.delete_objects(
            Bucket=bucket,
            Delete={"Objects": batch, "Quiet": True},
        )
        request_errors = response.get("Errors", [])
        if request_errors:
            first = request_errors[0]
            raise RuntimeError(
                f"{len(request_errors)} object(s) failed to delete "
                f"(first: {first.get('Code')} on key ending "
                f"…{first.get('Key', '')[-12:]})"
            )
        deleted += len(batch)
        batch = []

    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for record in page.get("Versions", []) + page.get("DeleteMarkers", []):
            batch.append({"Key": record["Key"], "VersionId": record["VersionId"]})
            if len(batch) >= _DELETE_BATCH_SIZE:
                _flush()
    _flush()
    return deleted


def _cleanup_sync(user_id: uuid.UUID) -> PhiCleanupResult:
    """Run the full per-bucket cleanup synchronously."""
    targets: list[tuple[str, str, str]] = [
        # (label, bucket setting value, member-scoped prefix)
        ("member_documents", settings.s3_member_documents_bucket, f"prod/v1/members/{user_id}/"),
        ("message_attachments", settings.s3_message_attachments_bucket, f"prod/v1/members/{user_id}/"),
        ("legacy_phi", settings.s3_bucket_phi, f"users/{user_id}/"),
    ]

    result = PhiCleanupResult()
    for label, bucket, prefix in targets:
        if not bucket:
            result.skipped_unconfigured.append(label)
            continue
        try:
            count = _delete_prefix_all_versions(bucket, prefix)
            result.objects_deleted[label] = count
            logger.info(
                "s3_phi_cleanup.bucket_done user_id=%s bucket=%s versions_deleted=%d",
                user_id, label, count,
            )
        except Exception as exc:  # noqa: BLE001 — per-bucket isolation is the point
            # Never log the prefix/keys (member UUID is PHI-adjacent context here).
            logger.error(
                "s3_phi_cleanup.bucket_failed user_id=%s bucket=%s error=%s",
                user_id, label, exc,
            )
            result.errors.append(f"{label}: {exc}")
    return result


async def delete_member_phi_objects(user_id: uuid.UUID) -> PhiCleanupResult:
    """Delete all member-owned PHI objects from S3 for ``user_id``.

    Per-bucket failures are collected, not raised — account deletion must
    not be blocked by a transient S3 error, but every failure is logged at
    ERROR and surfaced in the returned result so the deletion audit row
    records exactly what was and wasn't wiped.
    """
    return await asyncio.to_thread(_cleanup_sync, user_id)
