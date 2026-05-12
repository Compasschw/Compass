"""Shared relationship-authorization helpers for CHW ↔ member access gates.

Every endpoint that exposes member PHI to a CHW must verify that the CHW has
an active care relationship with the target member.  Role check alone
(``require_role("chw")``) is NOT sufficient — any authenticated CHW would
otherwise be able to access any member's data.

Usage::

    from app.services.relationship_guards import assert_shared_session

    await assert_shared_session(db, chw_id=current_user.id, member_id=member_id)

The function raises ``HTTP 403`` when no shared session exists, so callers
need no additional guard code.  Admin users bypass this check by checking
``current_user.role == "admin"`` before calling.

Guardrail:
    See ``feedback_compass_dev_guardrails.md`` rule #1 — every endpoint with a
    ``{member_id}`` path parameter must call this helper before returning PHI.
"""

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


async def assert_shared_session(
    db: AsyncSession,
    *,
    chw_id: UUID,
    member_id: UUID,
) -> None:
    """Raise HTTP 403 when the CHW and member share no session.

    Uses an EXISTS-style query (SELECT 1 + LIMIT 1) so the DB stops scanning
    at the first matching row — more efficient than COUNT(*) for eligibility
    checks.

    Args:
        db:        Active async database session.
        chw_id:    UUID of the CHW whose access is being verified.
        member_id: UUID of the member being accessed.

    Raises:
        HTTPException(403): If no session row links ``chw_id`` to ``member_id``
            regardless of session status (any status counts as a relationship).
    """
    from app.models.session import Session

    result = await db.execute(
        select(Session.id)
        .where(
            Session.chw_id == chw_id,
            Session.member_id == member_id,
        )
        .limit(1)
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(
            status_code=403,
            detail=(
                "Access denied: no care relationship exists between this CHW "
                "and the requested member. A shared session is required."
            ),
        )
