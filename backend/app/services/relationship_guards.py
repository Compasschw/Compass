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

# ── Services Consent gate (T03) ───────────────────────────────────────────────
_REFUSED_SERVICES_DETAIL = (
    "This member has refused services. Communication is blocked."
)
_REFUSED_SERVICES_CODE = "MEMBER_REFUSED_SERVICES"


async def assert_member_consents_to_services(
    db: AsyncSession,
    member_id: UUID,
) -> None:
    """Raise HTTP 403 when the member has opted out of CHW services.

    Call from any endpoint that enables CHW↔member communication or new
    session creation.  A member with ``services_consent == 'refuse_services'``
    is allowed to flip back via PATCH /member/services-consent, but no other
    communication channel is accessible until they do.

    This check is intentionally platform-wide — it is NOT scoped to a
    particular CHW.  Any CHW↔member communication is blocked regardless of
    which CHW is involved.

    Args:
        db:        Active async database session.
        member_id: UUID of the member whose consent status is being verified.

    Raises:
        HTTPException(403): with ``detail`` set to
            ``_REFUSED_SERVICES_DETAIL`` and a JSON body containing
            ``{"detail": "...", "code": "MEMBER_REFUSED_SERVICES"}`` when
            the member has ``services_consent == 'refuse_services'``.
    """
    from app.models.user import MemberProfile

    result = await db.execute(
        select(MemberProfile.services_consent).where(
            MemberProfile.user_id == member_id
        )
    )
    row = result.scalar_one_or_none()
    # When no MemberProfile exists (e.g. CHW account used as member in a test),
    # treat as consenting — the missing-profile case is caught by other guards.
    if row is None:
        return
    if row == "refuse_services":
        raise HTTPException(
            status_code=403,
            detail={"detail": _REFUSED_SERVICES_DETAIL, "code": _REFUSED_SERVICES_CODE},
        )


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
