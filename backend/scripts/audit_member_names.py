"""Audit script: find members whose `name` is missing a last-name token.

Pear Suite rejects member creation when last_name is missing, and signup
now enforces a two-token name (see app.schemas.auth.RegisterRequest).
Members who registered before that gate landed may still be in the DB
with a single-token name and therefore can't be billed via Pear.

This script is READ-ONLY — it prints offending accounts so they can be
fixed manually (via /admin/users/{id} edit or by asking the member to
update their profile). No PHI is printed; only id, email, and the bare
`name` field (which is already shown across the app UI).

Usage:
    docker exec -w /code compass-api python -m scripts.audit_member_names

Exit codes:
    0  No offenders found.
    1  One or more members are missing a last name (prints them).
"""

from __future__ import annotations

import asyncio
import logging
import sys

from sqlalchemy import select

from app.database import async_session
from app.models.user import User

logger = logging.getLogger("compass.audit_member_names")
logging.basicConfig(level=logging.INFO, format="%(message)s")


def _tokens(name: str | None) -> list[str]:
    """Mirror the validator in RegisterRequest._require_full_name_for_members."""
    if not name:
        return []
    return [t for t in name.strip().split() if t]


async def main() -> int:
    async with async_session() as db:
        result = await db.execute(
            select(User.id, User.email, User.name)
            .where(User.role == "member")
            .order_by(User.created_at.asc())
        )
        rows = result.all()

    offenders = [
        (uid, email, name) for (uid, email, name) in rows
        if len(_tokens(name)) < 2
    ]

    logger.info("Scanned %d member accounts.", len(rows))
    if not offenders:
        logger.info("No members are missing a last name. ✅")
        return 0

    logger.info("%d member(s) missing last name:", len(offenders))
    logger.info("%-38s  %-40s  %s", "id", "email", "name")
    logger.info("-" * 100)
    for uid, email, name in offenders:
        logger.info("%-38s  %-40s  %r", str(uid), email, name)
    logger.info("")
    logger.info(
        "Fix via /admin/users/{id} edit, or ask each member to update their "
        "profile (the new signup gate prevents this going forward)."
    )
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
