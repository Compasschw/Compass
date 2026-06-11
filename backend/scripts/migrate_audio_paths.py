"""Migrate audio S3 keys from the old date-partitioned path to the new
member-scoped UUID-only path.

Old scheme: prod/v1/{year}/{month}/{session_id}.mp3
New scheme: prod/v1/sessions/{session_id}/{communication_session_id}.mp3

For each row in communication_sessions where audio_s3_key starts with
'prod/v1/2026/' (the old date-partitioned prefix):
  1. Build new key: prod/v1/sessions/{session_id}/{comm_session_id}.mp3
  2. S3 copy old_key -> new_key (server-side copy within the same bucket, fast)
  3. UPDATE communication_sessions SET audio_s3_key = new_key WHERE id = row.id
  4. S3 delete old_key
  5. Log every action with structured context for audit trail

Transactional safety:
  - S3 copy must succeed before the DB update happens.
  - S3 delete only happens after the DB update commits successfully.
  - If the S3 copy fails for a row, the DB update is skipped and the old key
    is left intact (no data loss).
  - If the DB update fails, the S3 copy is left as an orphan (the old key is
    still in the DB) -- the script is idempotent: re-running will detect the
    old key is still present and retry cleanly.
  - Per-row failure does NOT abort the run -- all rows are attempted; a final
    summary is printed.

Usage (from backend/ directory with venv active):

    # Dry run -- prints every action, zero AWS/DB writes:
    python scripts/migrate_audio_paths.py --dry-run

    # Real run:
    python scripts/migrate_audio_paths.py

    # Target only a specific comm_session UUID (useful for targeted retry):
    python scripts/migrate_audio_paths.py --id <uuid>

On EC2 via SSM (after code deploy):
    docker exec -w /code -e PYTHONPATH=/code backend-api-1 \\
        python scripts/migrate_audio_paths.py --dry-run
    # Review output, then:
    docker exec -w /code -e PYTHONPATH=/code backend-api-1 \\
        python scripts/migrate_audio_paths.py

HIPAA note:
    - No PHI is logged.  Only session UUIDs, S3 keys (UUID-only), and byte
      counts are emitted to stdout.
    - Audio bytes are never downloaded locally -- S3 copy is server-side.

Prerequisites:
    - .env with DATABASE_URL, S3_CALL_RECORDINGS_BUCKET, AWS_REGION, and IAM
      credentials with s3:CopyObject + s3:DeleteObject on the recordings bucket.
    - Alembic migration c4f7d2b9e1a3 applied (audio_s3_key column exists).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import uuid as _uuid_module
from dataclasses import dataclass, field
from typing import Optional

# Allow running from backend/ without installing the package.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s -- %(message)s",
)
logger = logging.getLogger("compass.migrate_audio_paths")

# The prefix pattern that identifies rows written by the OLD key scheme.
OLD_KEY_PREFIX = "prod/v1/2026/"

# The prefix that correctly-migrated rows (new scheme) start with.
NEW_KEY_PREFIX = "prod/v1/sessions/"


@dataclass
class MigrationStats:
    total_candidates: int = 0
    already_migrated: int = 0
    skipped_already_new: int = 0
    migrated: int = 0
    failed: int = 0
    dry_run: bool = False
    failed_ids: list[str] = field(default_factory=list)


def _build_new_key(session_id: _uuid_module.UUID, comm_session_id: _uuid_module.UUID) -> str:
    """Construct the new UUID-only S3 key for a call recording.

    Path: prod/v1/sessions/{session_id}/{comm_session_id}.mp3
    """
    return f"prod/v1/sessions/{session_id}/{comm_session_id}.mp3"


def _get_s3_client(region: str):
    """Return a boto3 S3 client for the given region."""
    import boto3
    return boto3.client("s3", region_name=region)


def _s3_copy(
    s3_client,
    bucket: str,
    old_key: str,
    new_key: str,
    *,
    kms_key_arn: Optional[str],
) -> None:
    """Server-side S3 copy within the same bucket.

    Preserves KMS encryption on the destination object.  Raises on failure so
    the caller can skip the DB update.

    Args:
        s3_client: Boto3 S3 client.
        bucket: Bucket name (both source and dest are the same bucket).
        old_key: Source object key.
        new_key: Destination object key.
        kms_key_arn: Optional KMS key ARN for SSE-KMS on the copy destination.
    """
    copy_source = {"Bucket": bucket, "Key": old_key}
    copy_kwargs: dict = {
        "Bucket": bucket,
        "Key": new_key,
        "CopySource": copy_source,
        "ServerSideEncryption": "aws:kms",
    }
    if kms_key_arn:
        copy_kwargs["SSEKMSKeyId"] = kms_key_arn
    s3_client.copy_object(**copy_kwargs)


def _s3_delete(s3_client, bucket: str, key: str) -> None:
    """Delete an S3 object.  Raises on failure."""
    s3_client.delete_object(Bucket=bucket, Key=key)


async def _migrate(
    *,
    dry_run: bool,
    target_id: Optional[str],
) -> MigrationStats:
    """Run the migration.  Returns a MigrationStats summary."""
    from sqlalchemy import select

    from app.config import settings
    from app.database import async_session
    from app.models.communication import CommunicationSession

    stats = MigrationStats(dry_run=dry_run)

    bucket = settings.s3_call_recordings_bucket
    kms_key_arn = settings.s3_kms_key_arn or None
    region = settings.aws_region

    if not bucket:
        logger.error(
            "migrate_audio_paths: S3_CALL_RECORDINGS_BUCKET is not configured -- abort"
        )
        return stats

    # --- Fetch candidate rows -----------------------------------------------
    async with async_session() as db:
        stmt = (
            select(CommunicationSession)
            .where(CommunicationSession.audio_s3_key.like(OLD_KEY_PREFIX + "%"))
            .order_by(CommunicationSession.created_at.asc())
        )
        if target_id:
            stmt = stmt.where(CommunicationSession.id == target_id)

        rows = (await db.execute(stmt)).scalars().all()

    stats.total_candidates = len(rows)
    logger.info(
        "migrate_audio_paths: found %d row(s) with old path prefix '%s'",
        stats.total_candidates,
        OLD_KEY_PREFIX,
    )

    if dry_run:
        logger.info("migrate_audio_paths: --dry-run set -- no AWS or DB writes")

    if not rows:
        logger.info("migrate_audio_paths: nothing to migrate")
        return stats

    # --- Process each row ----------------------------------------------------
    s3_client = None if dry_run else _get_s3_client(region)

    for row in rows:
        old_key: str = row.audio_s3_key  # type: ignore[assignment]
        new_key = _build_new_key(
            session_id=row.session_id,
            comm_session_id=row.id,
        )

        if old_key == new_key:
            # Should not happen given the LIKE filter, but guard anyway.
            stats.skipped_already_new += 1
            logger.info(
                "migrate_audio_paths: comm_session_id=%s already on new path -- skip",
                row.id,
            )
            continue

        logger.info(
            "migrate_audio_paths: comm_session_id=%s  OLD=%s  NEW=%s",
            row.id,
            old_key,
            new_key,
        )

        if dry_run:
            stats.migrated += 1  # Count as "would migrate" for dry-run output
            continue

        # --- Step 1: S3 copy old -> new (server-side) -----------------------
        try:
            _s3_copy(
                s3_client,
                bucket,
                old_key,
                new_key,
                kms_key_arn=kms_key_arn,
            )
            logger.info(
                "migrate_audio_paths: S3 copy OK comm_session_id=%s new_key=%s",
                row.id,
                new_key,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "migrate_audio_paths: S3 copy FAILED comm_session_id=%s error=%s "
                "-- DB update skipped, old key preserved",
                row.id,
                exc,
            )
            stats.failed += 1
            stats.failed_ids.append(str(row.id))
            continue

        # --- Step 2: Update audio_s3_key in DB ------------------------------
        try:
            async with async_session() as db:
                comm_session = await db.get(CommunicationSession, row.id)
                if comm_session is None:
                    logger.warning(
                        "migrate_audio_paths: comm_session_id=%s vanished from DB "
                        "after S3 copy -- orphaned S3 object at %s",
                        row.id,
                        new_key,
                    )
                    stats.failed += 1
                    stats.failed_ids.append(str(row.id))
                    continue

                comm_session.audio_s3_key = new_key
                await db.commit()
                logger.info(
                    "migrate_audio_paths: DB update OK comm_session_id=%s",
                    row.id,
                )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "migrate_audio_paths: DB update FAILED comm_session_id=%s error=%s "
                "-- old S3 key NOT deleted (both keys exist in S3; DB still has old key)",
                row.id,
                exc,
            )
            stats.failed += 1
            stats.failed_ids.append(str(row.id))
            continue

        # --- Step 3: Delete old S3 object -----------------------------------
        try:
            _s3_delete(s3_client, bucket, old_key)
            logger.info(
                "migrate_audio_paths: S3 delete OK comm_session_id=%s old_key=%s",
                row.id,
                old_key,
            )
        except Exception as exc:  # noqa: BLE001
            # Non-fatal: the DB is already updated; the old object is now an
            # orphan.  Log it for manual cleanup but don't mark as failed.
            logger.warning(
                "migrate_audio_paths: S3 delete FAILED (non-fatal) "
                "comm_session_id=%s old_key=%s error=%s "
                "-- old object is an orphan; remove manually",
                row.id,
                old_key,
                exc,
            )

        stats.migrated += 1

    return stats


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Migrate audio S3 keys from old date-partitioned path "
            "(prod/v1/YYYY/MM/{session_id}.mp3) to new UUID-only member-scoped "
            "path (prod/v1/sessions/{session_id}/{comm_session_id}.mp3)."
        )
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Print what would be migrated without making any AWS or DB changes.",
    )
    parser.add_argument(
        "--id",
        dest="target_id",
        default=None,
        help="Migrate a single comm_session by UUID (useful for targeted retry).",
    )
    args = parser.parse_args()

    stats = asyncio.run(_migrate(dry_run=args.dry_run, target_id=args.target_id))

    print("\n--- Migration Summary ---")
    print(f"  dry_run             : {stats.dry_run}")
    print(f"  total_candidates    : {stats.total_candidates}")
    print(f"  migrated            : {stats.migrated}")
    print(f"  skipped_already_new : {stats.skipped_already_new}")
    print(f"  failed              : {stats.failed}")

    if stats.failed_ids:
        print(f"\nFailed comm_session IDs (investigate manually):")
        for fid in stats.failed_ids:
            print(f"  {fid}")
        sys.exit(1)
    else:
        if stats.dry_run:
            print(
                f"\nDry run complete -- {stats.migrated} row(s) would be migrated."
                "\nRe-run without --dry-run to apply."
            )
        else:
            print(f"\nMigration complete -- {stats.migrated} row(s) migrated, 0 failures.")
        sys.exit(0)


if __name__ == "__main__":
    main()
