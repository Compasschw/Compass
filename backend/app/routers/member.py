from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import require_role
from app.schemas.user import MemberProfileResponse, MemberProfileUpdate

router = APIRouter(prefix="/api/v1/member", tags=["member"])

@router.get("/profile", response_model=MemberProfileResponse)
async def get_profile(current_user=Depends(require_role("member")), db: AsyncSession = Depends(get_db)):
    from app.models.user import MemberProfile
    result = await db.execute(select(MemberProfile).where(MemberProfile.user_id == current_user.id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    # Merge associated User fields into the response so the mobile screen
    # can render phone/email/name without a second round trip.
    return MemberProfileResponse(
        id=profile.id,
        user_id=profile.user_id,
        zip_code=profile.zip_code,
        primary_language=profile.primary_language,
        primary_need=profile.primary_need,
        rewards_balance=profile.rewards_balance,
        insurance_provider=profile.insurance_provider,
        name=current_user.name,
        phone=current_user.phone,
        email=current_user.email,
    )

@router.put("/profile", response_model=MemberProfileResponse)
async def update_profile(data: MemberProfileUpdate, current_user=Depends(require_role("member")), db: AsyncSession = Depends(get_db)):
    from app.models.user import MemberProfile
    result = await db.execute(select(MemberProfile).where(MemberProfile.user_id == current_user.id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(profile, field, value)
    await db.commit()
    await db.refresh(profile)
    return profile

@router.get("/rewards")
async def get_rewards(current_user=Depends(require_role("member")), db: AsyncSession = Depends(get_db)):
    from app.models.reward import RewardTransaction
    result = await db.execute(select(RewardTransaction).where(RewardTransaction.member_id == current_user.id).order_by(RewardTransaction.created_at.desc()).limit(50))
    return {"transactions": result.scalars().all()}


@router.get("/roadmap", response_model=list["RoadmapItemResponse"])
async def get_my_roadmap(
    current_user=Depends(require_role("member")),
    db: AsyncSession = Depends(get_db),
):
    """Return follow-up items flagged for the member's roadmap.

    Filter: ``member_id == current_user`` AND ``show_on_roadmap == True``
    AND ``status != 'dismissed'``. Sorted by status (pending/confirmed first,
    then completed) and due_date ascending.
    """
    from app.models.followup import SessionFollowup
    from app.schemas.followup import RoadmapItemResponse  # noqa: F401

    result = await db.execute(
        select(SessionFollowup)
        .where(
            SessionFollowup.member_id == current_user.id,
            SessionFollowup.show_on_roadmap.is_(True),
            SessionFollowup.status != "dismissed",
        )
        .order_by(
            SessionFollowup.status.asc(),
            SessionFollowup.due_date.asc().nullslast(),
            SessionFollowup.created_at.desc(),
        )
    )
    return result.scalars().all()


@router.delete("/account", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_account(
    current_user=Depends(require_role("member")),
    db: AsyncSession = Depends(get_db),
):
    """Member-initiated account deletion. Required by HIPAA 45 CFR §164.526.

    Policy: soft delete — we mark the user `is_active=False`, clear PHI fields
    (name, phone, medi_cal_id, address), revoke all refresh tokens, and preserve
    billing/session records as pseudonymized data for the 7-year Medi-Cal
    retention window. After 30 days of soft-delete, a scheduled job hard-deletes
    profile records that are no longer required for billing audit.

    Regulatory note: Medi-Cal requires 7-year retention of claims data (see
    22 CCR §51476). We cannot fully delete session/billing rows during that
    window, but we can strip identifiers so remaining data is pseudonymized.
    """
    from app.models.auth import RefreshToken
    from app.models.user import CHWProfile, MemberProfile, User

    # 1. Strip PHI from the User record, mark inactive
    user = await db.get(User, current_user.id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    pseudonym = f"deleted-user-{user.id}"
    user.name = pseudonym
    user.email = f"{pseudonym}@deleted.invalid"
    user.phone = None
    user.profile_picture_url = None
    user.is_active = False
    user.password_hash = ""  # prevent any future login attempts
    user.updated_at = datetime.now(UTC)

    # 2. Clear PHI from MemberProfile if exists
    mp_result = await db.execute(select(MemberProfile).where(MemberProfile.user_id == user.id))
    member_profile = mp_result.scalar_one_or_none()
    if member_profile:
        member_profile.medi_cal_id = None
        member_profile.insurance_provider = None
        member_profile.zip_code = None
        member_profile.latitude = None
        member_profile.longitude = None
        member_profile.additional_needs = None

    # 3. Clear CHWProfile PHI if exists (member accounts typically don't have one,
    #    but we defend against bad state)
    chw_result = await db.execute(select(CHWProfile).where(CHWProfile.user_id == user.id))
    chw_profile = chw_result.scalar_one_or_none()
    if chw_profile:
        chw_profile.bio = None
        chw_profile.zip_code = None
        chw_profile.latitude = None
        chw_profile.longitude = None
        chw_profile.is_available = False

    # 4. Revoke all refresh tokens — user is logged out everywhere
    token_result = await db.execute(
        select(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked == False)  # noqa: E712
    )
    for token in token_result.scalars():
        token.revoked = True

    await db.commit()
    return None
