from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import require_role
from app.schemas.billing import EarningsSummary
from app.schemas.user import CHWProfileResponse, CHWProfileUpdate

router = APIRouter(prefix="/api/v1/chw", tags=["chw"])

@router.get("/profile", response_model=CHWProfileResponse)
async def get_profile(current_user=Depends(require_role("chw")), db: AsyncSession = Depends(get_db)):
    from app.models.user import CHWProfile
    result = await db.execute(select(CHWProfile).where(CHWProfile.user_id == current_user.id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return profile

@router.put("/profile", response_model=CHWProfileResponse)
async def update_profile(data: CHWProfileUpdate, current_user=Depends(require_role("chw")), db: AsyncSession = Depends(get_db)):
    from app.models.user import CHWProfile
    result = await db.execute(select(CHWProfile).where(CHWProfile.user_id == current_user.id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(profile, field, value)
    await db.commit()
    await db.refresh(profile)
    return profile

@router.patch("/profile/availability")
async def toggle_availability(current_user=Depends(require_role("chw")), db: AsyncSession = Depends(get_db)):
    from app.models.user import CHWProfile
    result = await db.execute(select(CHWProfile).where(CHWProfile.user_id == current_user.id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    profile.is_available = not profile.is_available
    await db.commit()
    return {"is_available": profile.is_available}

@router.get("/browse", response_model=list[dict])
async def browse_chws(
    vertical: str | None = None,
    current_user=Depends(require_role("member")),
    db: AsyncSession = Depends(get_db),
):
    """Browse available CHWs. Returns profiles with display names for MemberFind."""
    from app.models.user import CHWProfile, User
    stmt = (
        select(CHWProfile, User.name)
        .join(User, CHWProfile.user_id == User.id)
        .where(CHWProfile.is_available == True)  # noqa: E712
        # Defensive guard: a user whose role was flipped (e.g. CHW → admin)
        # may still have a CHWProfile row. Browsing should never surface
        # non-CHW users regardless of their profile state.
        .where(User.role == "chw")
    )
    if vertical:
        stmt = stmt.where(CHWProfile.specializations.any(vertical))
    stmt = stmt.order_by(CHWProfile.rating.desc())
    result = await db.execute(stmt)
    rows = result.all()
    return [
        {
            "id": str(profile.id),
            "user_id": str(profile.user_id),
            "name": name,
            "specializations": profile.specializations,
            "languages": profile.languages,
            "rating": profile.rating,
            "years_experience": profile.years_experience,
            "total_sessions": profile.total_sessions,
            "is_available": profile.is_available,
            "bio": profile.bio,
            "zip_code": profile.zip_code,
        }
        for profile, name in rows
    ]

@router.get("/earnings", response_model=EarningsSummary)
async def get_earnings(current_user=Depends(require_role("chw")), db: AsyncSession = Depends(get_db)):
    from app.models.billing import BillingClaim
    from app.models.session import Session
    from app.models.user import CHWProfile

    now = datetime.now(UTC)

    # This month's earnings
    month_result = await db.execute(
        select(func.coalesce(func.sum(BillingClaim.net_payout), 0))
        .where(BillingClaim.chw_id == current_user.id)
        .where(extract("month", BillingClaim.created_at) == now.month)
        .where(extract("year", BillingClaim.created_at) == now.year)
    )
    this_month = float(month_result.scalar())

    # All-time earnings
    all_time_result = await db.execute(
        select(func.coalesce(func.sum(BillingClaim.net_payout), 0))
        .where(BillingClaim.chw_id == current_user.id)
    )
    all_time = float(all_time_result.scalar())

    # Pending payout (claims with status 'pending')
    pending_result = await db.execute(
        select(func.coalesce(func.sum(BillingClaim.net_payout), 0))
        .where(BillingClaim.chw_id == current_user.id)
        .where(BillingClaim.status == "pending")
    )
    pending_payout = float(pending_result.scalar())

    # Sessions this week (completed sessions in the last 7 days)
    from datetime import timedelta
    week_ago = now - timedelta(days=7)
    sessions_result = await db.execute(
        select(func.count())
        .select_from(Session)
        .where(Session.chw_id == current_user.id)
        .where(Session.status == "completed")
        .where(Session.ended_at >= week_ago)
    )
    sessions_this_week = sessions_result.scalar() or 0

    # CHW rating
    profile_result = await db.execute(
        select(CHWProfile.rating).where(CHWProfile.user_id == current_user.id)
    )
    avg_rating = float(profile_result.scalar() or 0)

    return EarningsSummary(
        this_month=this_month,
        all_time=all_time,
        avg_rating=avg_rating,
        sessions_this_week=sessions_this_week,
        pending_payout=pending_payout,
    )


# ─── Claims (per-CHW lifecycle) ──────────────────────────────────────────────


@router.get("/claims")
async def list_claims(
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
):
    """Return the authenticated CHW's billing claims, newest first.

    Replaces the per-session mocked status badges in CHWEarningsScreen
    (`derivePayoutStatus(sess-002 → "submitted")`) with real claim status
    sourced from BillingClaim. Each row includes the claim id, the session
    that generated it, the four-stage status (pending → submitted → paid /
    rejected), and the financial breakdown.

    No PHI: claim status, amounts, code identifiers only — no diagnoses,
    no rejection_reason free text, no transcript.
    """
    from app.models.billing import BillingClaim

    result = await db.execute(
        select(BillingClaim)
        .where(BillingClaim.chw_id == current_user.id)
        .order_by(BillingClaim.created_at.desc())
        .limit(200)
    )
    rows = list(result.scalars().all())
    return [
        {
            "id": str(c.id),
            "session_id": str(c.session_id) if c.session_id else None,
            "procedure_code": c.procedure_code,
            "units": c.units,
            "gross_amount": float(c.gross_amount) if c.gross_amount is not None else 0.0,
            "platform_fee": float(c.platform_fee) if c.platform_fee is not None else 0.0,
            "pear_suite_fee": float(c.pear_suite_fee) if c.pear_suite_fee is not None else None,
            "net_payout": float(c.net_payout) if c.net_payout is not None else 0.0,
            "status": c.status,
            "service_date": c.service_date.isoformat() if c.service_date else None,
            "submitted_at": c.submitted_at.isoformat() if c.submitted_at else None,
            "paid_at": c.paid_at.isoformat() if c.paid_at else None,
            "created_at": c.created_at.isoformat() if c.created_at else None,
        }
        for c in rows
    ]
