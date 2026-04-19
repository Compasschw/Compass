from fastapi import APIRouter, Depends, HTTPException
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
    return profile

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
