"""One-shot cleanup: mark stale in-progress sessions as cancelled.

A session is considered "stuck" when it has been in the `in_progress` state for
longer than STALE_THRESHOLD_HOURS without any update. This can happen when:
  - The CHW's app crashed mid-session and they never tapped Complete.
  - A network partition left the status diverged from reality.
  - An earlier bug allowed multiple concurrent in-progress sessions.

**Status choice — cancelled vs completed:**
Stale sessions are marked `cancelled` rather than `completed` for three reasons:
  1. `completed` triggers billing-unit accounting and documentation requirements.
     We cannot retroactively assert a unit count for a session whose actual
     duration is unknown (ended_at is null).
  2. `cancelled` is the existing vocabulary for "session did not reach a natural
     end" (see ServiceRequest.cancel in requests.py for the same pattern).
  3. Billing reviewers can distinguish "CHW abandoned" from "CHW documented" at
     a glance — important for Medi-Cal audit trails.

The CHW can re-create and start a new session for the same member if the care
episode genuinely occurred.

Usage:
    # Inspect without touching the database
    python -m scripts.cleanup_stuck_in_progress --dry-run

    # Live run — marks stale rows cancelled and prints count_updated=N
    python -m scripts.cleanup_stuck_in_progress

Docker convenience:
    docker exec -w /code compass-api python -m scripts.cleanup_stuck_in_progress --dry-run

HIPAA: This script never logs PHI (no notes, member names, diagnosis codes).
Only session IDs and counts are written to stdout/stderr.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update

from app.database import async_session
from app.models.session import Session

logger = logging.getLogger("compass.cleanup_stuck_in_progress")

# ─── Configuration ─────────────────────────────────────────────────────────────

# Sessions in `in_progress` for longer than this threshold are treated as stuck.
# 4 hours covers the longest realistic CHW session (most sessions are 30-90 min)
# while still catching genuine overnight hangs. The value is conservative on
# purpose — it is safer to leave a borderline session alone than to incorrectly
# cancel one that is legitimately still open.
STALE_THRESHOLD_HOURS: int = 4

_CANCELLED_STATUS: str = "cancelled"
_IN_PROGRESS_STATUS: str = "in_progress"


# ─── Core logic ───────────────────────────────────────────────────────────────


async def find_stuck_sessions(db, cutoff: datetime) -> list[Session]:
    """Return all in-progress sessions whose updated_at (or started_at) predates cutoff.

    We prefer ``updated_at`` as the staleness signal because it captures any
    late heartbeat writes (e.g., a chat message or consent record touching the
    session row). ``started_at`` is used as a fallback for rows that never had
    an explicit update (i.e., started_at == updated_at at creation).

    Both columns are timezone-aware (UTC). ``cutoff`` must also be UTC.
    """
    result = await db.execute(
        select(Session).where(
            Session.status == _IN_PROGRESS_STATUS,
            # Use updated_at as the primary staleness signal; fall back to
            # started_at for rows where the two columns are the same.
            Session.updated_at < cutoff,
        )
    )
    return list(result.scalars().all())


async def run_cleanup(dry_run: bool, threshold_hours: int = STALE_THRESHOLD_HOURS) -> int:
    """Find and optionally cancel stuck in-progress sessions.

    Args:
        dry_run: When True, print the session IDs that would be updated without
            committing any changes to the database.
        threshold_hours: Number of hours a session must have been stuck before
            it is eligible for cancellation.

    Returns:
        The number of sessions updated (or that would be updated in dry-run mode).
    """
    cutoff = datetime.now(UTC) - timedelta(hours=threshold_hours)
    logger.info(
        "Searching for in_progress sessions with updated_at < %s (threshold=%dh)",
        cutoff.isoformat(),
        threshold_hours,
    )

    async with async_session() as db:
        stuck_sessions = await find_stuck_sessions(db, cutoff)
        count = len(stuck_sessions)

        if count == 0:
            logger.info("No stuck in-progress sessions found.")
            print("count_updated=0")
            return 0

        if dry_run:
            print(f"[DRY-RUN] Would cancel {count} stuck in-progress session(s):")
            for sess in stuck_sessions:
                print(
                    f"  id={sess.id}"
                    f"  chw_id={sess.chw_id}"
                    f"  updated_at={sess.updated_at.isoformat() if sess.updated_at else 'NULL'}"
                    f"  started_at={sess.started_at.isoformat() if sess.started_at else 'NULL'}"
                )
            print(f"count_updated={count}")
            return count

        # Live run: bulk-update all matching rows in a single statement to avoid
        # row-by-row round trips. updated_at is refreshed by the SQLAlchemy
        # onupdate trigger on the model column.
        stuck_ids = [sess.id for sess in stuck_sessions]
        await db.execute(
            update(Session)
            .where(Session.id.in_(stuck_ids))
            .values(
                status=_CANCELLED_STATUS,
                ended_at=datetime.now(UTC),
            )
        )
        await db.commit()

        logger.info(
            "Cancelled %d stuck in-progress session(s): ids=%s",
            count,
            [str(sid) for sid in stuck_ids],
        )
        print(f"count_updated={count}")
        return count


# ─── CLI ──────────────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cleanup_stuck_in_progress",
        description=(
            "Mark stale in-progress sessions as cancelled. "
            f"A session is 'stuck' when it has been in_progress for more than "
            f"{STALE_THRESHOLD_HOURS} hours without an update."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Print the sessions that would be cancelled without committing "
            "any changes to the database."
        ),
    )
    parser.add_argument(
        "--threshold-hours",
        type=int,
        default=STALE_THRESHOLD_HOURS,
        help=(
            f"Number of hours a session must be stuck before it is eligible "
            f"for cancellation (default: {STALE_THRESHOLD_HOURS})."
        ),
    )
    return parser


async def _main(dry_run: bool, threshold_hours: int) -> int:
    if dry_run:
        print("[DRY-RUN MODE] No changes will be committed.\n")

    try:
        await run_cleanup(dry_run=dry_run, threshold_hours=threshold_hours)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    return 0


def main() -> int:
    args = _build_parser().parse_args()
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
    return asyncio.run(_main(dry_run=args.dry_run, threshold_hours=args.threshold_hours))


if __name__ == "__main__":
    sys.exit(main())
