"""Backfill recent Vonage call recordings to S3.

ONE-TIME USE SCRIPT — run once within the 30-day Vonage retention window to
upload any existing recordings that were processed before the audio_s3_key
column / S3 upload step shipped.

Usage (from the backend/ directory, with venv active):

    # Dry run — shows how many sessions would be processed, no uploads:
    python scripts/backfill_recent_recordings.py --dry-run

    # Real run — uploads missing audio, 25-day lookback:
    python scripts/backfill_recent_recordings.py

    # Custom lookback (e.g., 20 days to be safe):
    python scripts/backfill_recent_recordings.py --days 20

Prerequisites:
    - .env must be configured with valid S3_CALL_RECORDINGS_BUCKET, S3_KMS_KEY_ARN,
      AWS_REGION, VONAGE credentials, and DATABASE_URL.
    - The alembic migration a1b2c3d4e5f6 must be applied (audio_s3_key column exists).
    - Run from the EC2 instance or any machine with an IAM role / credentials
      that have s3:PutObject on compass-prod-call-recordings.

Safety:
    - Skips rows where audio_s3_key is already set (idempotent).
    - Skips rows where recording_url is NULL (no URL to re-download).
    - Logs every action; never deletes anything.
    - The --dry-run flag prints what would be processed with zero writes.

HIPAA note:
    - Audio bytes are downloaded over TLS and immediately sent to S3 via PUT.
      They are never written to disk.  Only byte count and session IDs are logged.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from datetime import UTC, datetime, timedelta

# Allow running from backend/ without installing the package.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("compass.backfill_recordings")


async def _backfill(*, days_back: int, dry_run: bool) -> dict:
    """Run the backfill.  Returns a summary dict."""
    from sqlalchemy import select

    from app.database import async_session
    from app.models.communication import CommunicationSession
    from app.services.communication import get_provider as get_communication_provider
    from app.services.communication.recording_finalizer import (
        _build_audio_s3_key,
        _upload_audio_to_s3,
    )

    cutoff = datetime.now(UTC) - timedelta(days=days_back)

    stats = {
        "total_candidates": 0,
        "already_uploaded": 0,
        "no_recording_url": 0,
        "uploaded": 0,
        "failed": 0,
        "dry_run": dry_run,
        "days_back": days_back,
    }

    async with async_session() as db:
        rows = (
            await db.execute(
                select(CommunicationSession)
                .where(CommunicationSession.created_at >= cutoff)
                .where(CommunicationSession.audio_s3_key.is_(None))
                .order_by(CommunicationSession.created_at.asc())
            )
        ).scalars().all()

    stats["total_candidates"] = len(rows)
    logger.info(
        "backfill: found %d CommunicationSession rows without audio_s3_key "
        "in the last %d days",
        len(rows),
        days_back,
    )

    if dry_run:
        logger.info("backfill: --dry-run set, no uploads will be performed")
        for row in rows:
            if not row.recording_url:
                stats["no_recording_url"] += 1
                logger.info(
                    "  WOULD SKIP (no recording_url) comm_session_id=%s", row.id
                )
            else:
                logger.info(
                    "  WOULD UPLOAD comm_session_id=%s session_id=%s created_at=%s",
                    row.id,
                    row.session_id,
                    row.created_at,
                )
        return stats

    comm_provider = get_communication_provider()
    download = getattr(comm_provider, "download_recording_bytes", None)
    if download is None:
        logger.error(
            "backfill: communication provider %s lacks download_recording_bytes — abort",
            type(comm_provider).__name__,
        )
        return stats

    async with async_session() as db:
        for row in rows:
            if not row.recording_url:
                stats["no_recording_url"] += 1
                logger.warning(
                    "backfill: skipping comm_session_id=%s — no recording_url",
                    row.id,
                )
                continue

            # Re-fetch inside the write session for a fresh lock.
            comm_session = await db.get(CommunicationSession, row.id)
            if comm_session is None:
                logger.warning("backfill: comm_session_id=%s vanished — skip", row.id)
                continue

            if comm_session.audio_s3_key:
                # Another process uploaded it between the initial SELECT and now.
                stats["already_uploaded"] += 1
                logger.info(
                    "backfill: comm_session_id=%s already has audio_s3_key — skip",
                    row.id,
                )
                continue

            logger.info(
                "backfill: downloading comm_session_id=%s recording_url_host=%s",
                row.id,
                row.recording_url.split("/")[2] if "//" in row.recording_url else "?",
            )
            try:
                audio_bytes = await download(row.recording_url)
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "backfill: download failed comm_session_id=%s error=%s",
                    row.id,
                    exc,
                )
                stats["failed"] += 1
                continue

            if not audio_bytes:
                logger.error(
                    "backfill: download returned no bytes comm_session_id=%s "
                    "(recording may have expired — Vonage 30-day window)",
                    row.id,
                )
                stats["failed"] += 1
                continue

            recorded_at = comm_session.created_at or datetime.now(UTC)

            s3_key = await _upload_audio_to_s3(
                audio_bytes=audio_bytes,
                session_id=comm_session.session_id,
                communication_session_id=comm_session.id,
                recorded_at=recorded_at,
            )

            if s3_key:
                comm_session.audio_s3_key = s3_key
                await db.commit()
                stats["uploaded"] += 1
                logger.info(
                    "backfill: uploaded comm_session_id=%s s3_key=%s",
                    row.id,
                    s3_key,
                )
            else:
                stats["failed"] += 1
                logger.error(
                    "backfill: S3 upload failed comm_session_id=%s — "
                    "audio_s3_key left NULL",
                    row.id,
                )

    return stats


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill recent Vonage recordings to S3 (one-time use)."
    )
    parser.add_argument(
        "--days",
        type=int,
        default=25,
        help="How many days back to look for recordings without audio_s3_key "
             "(default: 25, safely inside the 30-day Vonage window).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Print candidate rows without performing any uploads.",
    )
    args = parser.parse_args()

    stats = asyncio.run(_backfill(days_back=args.days, dry_run=args.dry_run))

    print("\n--- Backfill Summary ---")
    for key, value in stats.items():
        print(f"  {key}: {value}")

    if stats["failed"] > 0:
        print(
            f"\nWARNING: {stats['failed']} recording(s) failed to upload. "
            "Check logs for details. These sessions may need manual intervention "
            "if still within the Vonage 30-day window."
        )
        sys.exit(1)
    else:
        print("\nBackfill complete — no failures.")
        sys.exit(0)


if __name__ == "__main__":
    main()
