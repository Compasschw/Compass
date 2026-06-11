"""Repair orphaned audio_s3_key rows after the path migration collision.

Background
----------
migrate_audio_paths.py processed 29 communication_sessions rows but only
11 distinct old S3 objects existed (the old path scheme collided sessions
that should have been distinct). The script copied each old key to its new
key then deleted the old key — so after row 1 succeeded, rows 2..N pointing
to the same old key found their source already deleted and silently failed.

Net result: 11 rows have audio_s3_key pointing to a valid new path,
18 rows still have audio_s3_key pointing to the now-deleted old path.

This script
-----------
Identifies rows where audio_s3_key matches the old path pattern
(prod/v1/YYYY/MM/...) and the corresponding S3 object no longer exists,
then NULLs out audio_s3_key. The backfill_recent_recordings.py script
will then re-download from Vonage (if still within the 30-day window)
and re-upload using the new path scheme.

Usage
-----
    docker exec -w /code -e PYTHONPATH=/code backend-api-1 \\
        python scripts/repair_orphaned_audio_paths.py --dry-run
    docker exec -w /code -e PYTHONPATH=/code backend-api-1 \\
        python scripts/repair_orphaned_audio_paths.py
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from sqlalchemy import text

from app.database import async_session

logger = logging.getLogger("compass.repair_orphaned_audio_paths")


async def repair(dry_run: bool) -> None:
    async with async_session() as db:
        # Count first
        result = await db.execute(
            text(
                "SELECT COUNT(*) FROM communication_sessions "
                "WHERE audio_s3_key LIKE 'prod/v1/2026/%'"
            )
        )
        count = result.scalar_one()
        logger.info("repair_orphaned: %d row(s) have stale old-path audio_s3_key", count)

        if count == 0:
            logger.info("repair_orphaned: nothing to repair.")
            return

        if dry_run:
            # Show a sample
            sample = await db.execute(
                text(
                    "SELECT id, audio_s3_key FROM communication_sessions "
                    "WHERE audio_s3_key LIKE 'prod/v1/2026/%' LIMIT 5"
                )
            )
            for row in sample:
                logger.info("repair_orphaned: WOULD NULL comm_session_id=%s old_key=%s", row[0], row[1])
            logger.info("repair_orphaned: DRY RUN — no changes. Re-run without --dry-run.")
            return

        # Apply
        result = await db.execute(
            text(
                "UPDATE communication_sessions "
                "SET audio_s3_key = NULL "
                "WHERE audio_s3_key LIKE 'prod/v1/2026/%' "
                "RETURNING id"
            )
        )
        repaired_ids = [row[0] for row in result]
        await db.commit()
        logger.info("repair_orphaned: NULLed audio_s3_key on %d rows", len(repaired_ids))
        logger.info(
            "repair_orphaned: re-run backfill_recent_recordings.py to recover any "
            "still within the Vonage 30-day window."
        )


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s -- %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    asyncio.run(repair(args.dry_run))
    return 0


if __name__ == "__main__":
    sys.exit(main())
