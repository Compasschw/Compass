"""Pre-deploy audit: confirm the DB is in a state where session-per-call
is safe to enable.

Checks:
  1. Every Session has a non-null conversation_id (migration backfill
     completed + new Session-creation paths from Task 7 stamped the
     column on subsequent rows).
  2. No conversation has more than one in_progress Session (the
     "at most one active session per conversation" invariant — enforced
     by app.services.session_lookup.create_followup_session, but worth
     verifying at the DB level before flipping the flag).

Exit codes:
    0  Ready to enable session_per_call_enabled.
    1  One or more issues — printed for ops to resolve.

Usage:
    cd /code && python -m scripts.audit_session_per_call_readiness
"""
from __future__ import annotations

import asyncio
import logging
import sys

from sqlalchemy import func, select

from app.database import async_session
from app.models.session import Session

logger = logging.getLogger("compass.audit_session_per_call_readiness")
logging.basicConfig(level=logging.INFO, format="%(message)s")


async def main() -> int:
    exit_code = 0
    async with async_session() as db:
        # Check 1: orphan Sessions (no conversation_id)
        orphan_count = (
            await db.execute(
                select(func.count())
                .select_from(Session)
                .where(Session.conversation_id.is_(None))
            )
        ).scalar_one()
        logger.info("Sessions without conversation_id: %d", orphan_count)
        if orphan_count > 0:
            exit_code = 1
            logger.info(
                "  → Run the backfill SQL from migration f6a7b8c9d0e1, or "
                "re-stamp via app.services.session_lookup."
            )

        # Check 2: conversations with >1 in_progress Session
        dup_active = (
            await db.execute(
                select(Session.conversation_id, func.count())
                .where(Session.status == "in_progress")
                .group_by(Session.conversation_id)
                .having(func.count() > 1)
            )
        ).all()
        logger.info(
            "Conversations with >1 in_progress Session: %d", len(dup_active)
        )
        if dup_active:
            exit_code = 1
            for conv_id, n in dup_active:
                logger.info("  conversation=%s active_count=%d", conv_id, n)

    if exit_code == 0:
        logger.info("Ready to flip session_per_call_enabled=True.")
    else:
        logger.info("Resolve the above before enabling the flag.")
    return exit_code


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
