"""One-off idempotent script to merge duplicate (chw_id, member_id) conversations.

Usage:
    cd backend
    DATABASE_URL=postgresql+asyncpg://... .venv/bin/python scripts/merge_duplicate_conversations.py
    # Or dry-run (no writes):
    .venv/bin/python scripts/merge_duplicate_conversations.py --dry-run

Background
----------
Migration ab1c2d3e4f5a added UNIQUE(chw_id, member_id) on conversations and
merged pre-existing duplicates at migration time.  This script is a post-deploy
safety net:
  - On a near-empty / freshly-wiped prod DB: finds no duplicates, exits cleanly.
  - On a DB with surviving duplicates (e.g. from a partial migration rollback):
    re-points messages + call_logs + sessions FKs onto the oldest (canonical)
    conversation row and deletes the orphaned duplicates.

Guard: only rows sharing the SAME (chw_id, member_id) pair are merged.
Cross-pair merges are impossible by construction (the WHERE clause pins both
columns before any UPDATE).

Idempotency: the UNIQUE constraint prevents duplicates from being re-created
after this script runs.  Running the script a second time finds no duplicates
and logs "No duplicate pairs found — nothing to do."
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import create_async_engine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("compass.dedup")


async def merge_duplicates(*, dry_run: bool = False) -> None:
    """Detect and merge duplicate (chw_id, member_id) conversation rows.

    For each duplicate (chw_id, member_id) pair, the oldest conversation row
    is designated canonical. All FK references in messages, call_logs, and
    sessions are re-pointed to the canonical row. Orphaned duplicate rows are
    then deleted.

    Args:
        dry_run: When True, print what WOULD be merged without writing to the DB.

    Raises:
        SystemExit(1): If DATABASE_URL is not set in the environment.
    """
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL not set. Export it before running this script.")
        sys.exit(1)

    engine = create_async_engine(db_url, echo=False)

    async with engine.begin() as conn:
        # ── Step 1: find duplicate (chw_id, member_id) pairs ─────────────────
        rows = await conn.execute(
            sa.text(
                """
                SELECT chw_id, member_id, COUNT(*) AS cnt
                FROM conversations
                GROUP BY chw_id, member_id
                HAVING COUNT(*) > 1
                ORDER BY cnt DESC
                """
            )
        )
        duplicates = rows.fetchall()

        if not duplicates:
            log.info("No duplicate (chw_id, member_id) pairs found — nothing to do.")
            await engine.dispose()
            return

        log.warning(
            "Found %d duplicate (chw_id, member_id) pair(s). dry_run=%s",
            len(duplicates),
            dry_run,
        )

        total_deleted = 0

        for pair_row in duplicates:
            chw_id = pair_row[0]
            member_id = pair_row[1]

            # ── Step 2: identify canonical (oldest) row and duplicates ───────
            id_rows = await conn.execute(
                sa.text(
                    """
                    SELECT id FROM conversations
                    WHERE chw_id = :chw AND member_id = :mem
                    ORDER BY created_at ASC
                    """
                ),
                {"chw": chw_id, "mem": member_id},
            )
            all_ids = [r[0] for r in id_rows.fetchall()]
            canonical_id = all_ids[0]
            duplicate_ids = all_ids[1:]

            log.info(
                "Pair chw=%s member=%s | canonical=%s | duplicates=%s",
                chw_id,
                member_id,
                canonical_id,
                duplicate_ids,
            )

            for dup_id in duplicate_ids:
                if dry_run:
                    # Count impacted rows without modifying anything.
                    msgs = await conn.execute(
                        sa.text("SELECT COUNT(*) FROM messages WHERE conversation_id = :dup"),
                        {"dup": dup_id},
                    )
                    calls = await conn.execute(
                        sa.text("SELECT COUNT(*) FROM call_logs WHERE conversation_id = :dup"),
                        {"dup": dup_id},
                    )
                    sessions = await conn.execute(
                        sa.text("SELECT COUNT(*) FROM sessions WHERE conversation_id = :dup"),
                        {"dup": dup_id},
                    )
                    log.info(
                        "  [DRY RUN] Would remap conversation %s → %s: "
                        "%d message(s), %d call_log(s), %d session(s)",
                        dup_id,
                        canonical_id,
                        msgs.scalar_one(),
                        calls.scalar_one(),
                        sessions.scalar_one(),
                    )
                    continue

                # Re-point messages FK — guard: only for THIS dup_id.
                msgs_result = await conn.execute(
                    sa.text(
                        "UPDATE messages SET conversation_id = :canon "
                        "WHERE conversation_id = :dup"
                    ),
                    {"canon": canonical_id, "dup": dup_id},
                )
                log.info(
                    "  Remapped %d message(s): %s → %s",
                    msgs_result.rowcount,
                    dup_id,
                    canonical_id,
                )

                # Re-point call_logs FK.
                calls_result = await conn.execute(
                    sa.text(
                        "UPDATE call_logs SET conversation_id = :canon "
                        "WHERE conversation_id = :dup"
                    ),
                    {"canon": canonical_id, "dup": dup_id},
                )
                log.info(
                    "  Remapped %d call_log(s): %s → %s",
                    calls_result.rowcount,
                    dup_id,
                    canonical_id,
                )

                # Re-point sessions FK.
                sessions_result = await conn.execute(
                    sa.text(
                        "UPDATE sessions SET conversation_id = :canon "
                        "WHERE conversation_id = :dup"
                    ),
                    {"canon": canonical_id, "dup": dup_id},
                )
                log.info(
                    "  Remapped %d session(s): %s → %s",
                    sessions_result.rowcount,
                    dup_id,
                    canonical_id,
                )

                # Delete the now-orphaned duplicate row.
                await conn.execute(
                    sa.text("DELETE FROM conversations WHERE id = :dup"),
                    {"dup": dup_id},
                )
                log.info("  Deleted duplicate conversation row %s", dup_id)
                total_deleted += 1

    if not dry_run and total_deleted > 0:
        log.warning(
            "Merge complete: deleted %d orphan conversation row(s). "
            "The UNIQUE constraint will prevent future duplicates.",
            total_deleted,
        )
    elif dry_run:
        log.info("[DRY RUN] No changes written. Re-run without --dry-run to apply.")

    await engine.dispose()


def _parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Merge duplicate (chw_id, member_id) conversation rows."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be merged without writing to the DB.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    asyncio.run(merge_duplicates(dry_run=args.dry_run))
