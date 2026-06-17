"""Member billing-status (billable / non-billable) toggle.

A CHW-controlled flag on the Member Profile that marks whether the member's
completed sessions are billable. When ``is_billable`` is False, the member's
sessions should be excluded from Pear Suite billing submission.

Authorization
-------------
GET  — admin, the member themselves, or a CHW with an active care relationship.
PATCH — admin or a CHW with an active care relationship. Members cannot set
        their own billability; it is a billing/eligibility decision the CHW
        records on the profile.

``billing_status_changed_at`` / ``billing_status_changed_by`` are stamped from
the request context on every PATCH so the client cannot forge the audit trail.
"""

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import MemberProfile
from app.schemas.member import BillingStatusResponse, BillingStatusUpdate
from app.services.relationship_guards import assert_shared_session

logger = logging.getLogger("compass.billing_status")

router = APIRouter(prefix="/api/v1", tags=["billing-status"])


async def _load_member_profile(member_id: UUID, db: AsyncSession) -> MemberProfile:
    """Load the MemberProfile for a member User id, or raise 404."""
    result = await db.execute(
        select(MemberProfile).where(MemberProfile.user_id == member_id)
    )
    profile = result.scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=404, detail="Member not found")
    return profile


async def _assert_can_read(
    member_id: UUID, current_user, db: AsyncSession
) -> None:
    """Admin, self-member, or relationship-bearing CHW may read."""
    role = current_user.role
    if role == "admin":
        return
    if role == "member":
        if current_user.id != member_id:
            raise HTTPException(
                status_code=403,
                detail="Members may only view their own billing status.",
            )
        return
    if role == "chw":
        await assert_shared_session(
            db, chw_id=current_user.id, member_id=member_id
        )
        return
    raise HTTPException(status_code=403, detail="Not authorized.")


async def _assert_can_write(
    member_id: UUID, current_user, db: AsyncSession
) -> None:
    """Only admin or a relationship-bearing CHW may change billing status."""
    role = current_user.role
    if role == "admin":
        return
    if role == "chw":
        await assert_shared_session(
            db, chw_id=current_user.id, member_id=member_id
        )
        return
    raise HTTPException(
        status_code=403,
        detail=(
            "Only a CHW with an active care relationship or an admin may "
            "change a member's billing status."
        ),
    )


def _to_response(profile: MemberProfile) -> BillingStatusResponse:
    return BillingStatusResponse(
        is_billable=profile.is_billable,
        changed_at=profile.billing_status_changed_at,
        changed_by=profile.billing_status_changed_by,
    )


@router.get(
    "/members/{member_id}/billing-status",
    response_model=BillingStatusResponse,
    summary="Get a member's billable/non-billable status",
)
async def get_billing_status(
    member_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BillingStatusResponse:
    """Return the member's current billing-eligibility flag + audit metadata.

    Errors:
      403 — caller lacks a care relationship (CHW) or is not self/admin
      404 — member profile not found
    """
    await _assert_can_read(member_id, current_user, db)
    profile = await _load_member_profile(member_id, db)
    return _to_response(profile)


@router.patch(
    "/members/{member_id}/billing-status",
    response_model=BillingStatusResponse,
    summary="Set a member's billable/non-billable status",
)
async def update_billing_status(
    member_id: UUID,
    data: BillingStatusUpdate,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BillingStatusResponse:
    """Flip the member's billable/non-billable toggle (CHW or admin).

    Stamps ``billing_status_changed_at`` / ``billing_status_changed_by`` from
    the request context.

    Errors:
      403 — members cannot set their own status; CHW without a relationship
      404 — member profile not found
    """
    await _assert_can_write(member_id, current_user, db)
    profile = await _load_member_profile(member_id, db)

    profile.is_billable = data.is_billable
    profile.billing_status_changed_at = datetime.now(UTC)
    profile.billing_status_changed_by = current_user.id

    await db.commit()
    await db.refresh(profile)

    logger.info(
        "billing_status_updated member_id=%s is_billable=%s by=%s",
        member_id,
        data.is_billable,
        current_user.id,
    )
    return _to_response(profile)
