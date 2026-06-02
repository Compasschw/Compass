"""Backfill the Pear Member-Import CSV with every member who hasn't been
exported yet.

Walks ``MemberProfile`` rows where ``member_csv_exported_at IS NULL``,
appends each to the LA-local month's rolling CSV in
``s3_bucket_member_csv``, and stamps the column on success.  Idempotent:
re-running it picks up any new rows that have appeared since the last
run (or any rows whose previous export failed before the stamp was set).

Usage:
    # Dry-run: count rows, show which ones would be exported, no S3 writes.
    docker exec -w /code compass-api python -m scripts.backfill_member_csv --dry-run

    # Real run:
    docker exec -w /code compass-api python -m scripts.backfill_member_csv

Exit codes:
    0  All eligible members exported (or none to export).
    1  One or more failures — re-run after investigating.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from datetime import UTC, datetime

from sqlalchemy import select

from app.config import settings
from app.database import async_session
from app.models.user import MemberProfile, User
from app.services.member_csv_writer import (
    append_row,
    build_row_from_models,
    is_export_eligible,
)

logger = logging.getLogger("compass.member.csv_backfill")
logging.basicConfig(level=logging.INFO, format="%(message)s")


async def main(dry_run: bool) -> int:
    if not settings.member_csv_enabled and not dry_run:
        logger.info(
            "MEMBER_CSV_ENABLED=false in env — refusing to run real backfill. "
            "Re-run with --dry-run to preview which rows would be exported, "
            "or set MEMBER_CSV_ENABLED=true and restart."
        )
        return 1

    env_prefix = "prod" if settings.pear_suite_enabled else "sandbox"
    exit_code = 0
    succeeded = 0
    failed = 0
    skipped = 0

    async with async_session() as db:
        result = await db.execute(
            select(User, MemberProfile)
            .join(MemberProfile, MemberProfile.user_id == User.id)
            .where(
                User.role == "member",
                MemberProfile.member_csv_exported_at.is_(None),
            )
            .order_by(User.created_at.asc())
        )
        # SQL pre-filter doesn't know about deleted-sentinel / smoke-test
        # patterns; apply the shared eligibility filter in Python so the
        # backfill matches the live-auth-hook rules exactly.
        rows = [
            (user, profile)
            for user, profile in result.all()
            if is_export_eligible(user)
        ]

    logger.info(
        "Backfill candidates: %d member(s) without member_csv_exported_at "
        "(env_prefix=%s, dry_run=%s)",
        len(rows), env_prefix, dry_run,
    )
    if not rows:
        return 0

    for user, profile in rows:
        try:
            csv_row = build_row_from_models(user=user, member_profile=profile)
        except Exception as exc:  # noqa: BLE001
            failed += 1
            logger.exception("Failed to build row for user=%s: %s", user.id, exc)
            exit_code = 1
            continue

        if dry_run:
            skipped += 1
            logger.info(
                "[dry-run] would append user=%s email=%s -> %s/v1/<YYYY-MM>.csv",
                user.id, user.email, env_prefix,
            )
            continue

        try:
            append_row(csv_row, environment=env_prefix)
        except Exception as exc:  # noqa: BLE001
            failed += 1
            logger.exception(
                "S3 append failed for user=%s: %s — leaving "
                "member_csv_exported_at NULL so the next run retries.",
                user.id, exc,
            )
            exit_code = 1
            continue

        # Stamp the column in its own short-lived session per row so a mid-run
        # crash doesn't lose state — each successful S3 append is durable
        # before we move on.
        async with async_session() as stamp_db:
            row = await stamp_db.get(MemberProfile, profile.id)
            if row is not None and row.member_csv_exported_at is None:
                row.member_csv_exported_at = datetime.now(UTC)
                await stamp_db.commit()

        succeeded += 1
        logger.info("Exported user=%s email=%s", user.id, user.email)

    logger.info(
        "Done — succeeded=%d failed=%d skipped(dry-run)=%d",
        succeeded, failed, skipped,
    )
    return exit_code


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Don't touch S3 or the column; print what would happen.",
    )
    args = parser.parse_args()
    sys.exit(asyncio.run(main(dry_run=args.dry_run)))
