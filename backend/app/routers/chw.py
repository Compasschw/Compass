from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import require_role
from app.schemas.billing import EarningsSummary
from app.schemas.chw import CHWMemberProfileView
from app.schemas.user import CHWProfileResponse, CHWProfileUpdate

router = APIRouter(prefix="/api/v1/chw", tags=["chw"])

def _serialize_chw_profile(profile, current_user) -> "CHWProfileResponse":
    """Build the CHWProfileResponse with the User row's name/email/phone joined in.

    Mirrors the /member/profile shape so the mobile/web Profile screens can
    render the operator's real contact info without a second round-trip
    against /users/me. This is the fix for the long-standing bug where the
    CHW Profile rendered hard-coded mock email/phone fallbacks.
    """
    return CHWProfileResponse(
        id=profile.id,
        user_id=profile.user_id,
        specializations=profile.specializations or [],
        languages=profile.languages or [],
        rating=profile.rating,
        years_experience=profile.years_experience,
        total_sessions=profile.total_sessions,
        is_available=profile.is_available,
        bio=profile.bio,
        zip_code=profile.zip_code,
        name=current_user.name,
        email=current_user.email,
        phone=current_user.phone,
    )


@router.get("/profile", response_model=CHWProfileResponse)
async def get_profile(current_user=Depends(require_role("chw")), db: AsyncSession = Depends(get_db)):
    from app.models.user import CHWProfile
    result = await db.execute(select(CHWProfile).where(CHWProfile.user_id == current_user.id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return _serialize_chw_profile(profile, current_user)

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
    return _serialize_chw_profile(profile, current_user)

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
    """Browse available CHWs. Returns profiles with display names for MemberFind.

    Visibility gates (all must be true):
    - User.role == "chw"  (defensive — a flipped-role user with an old
      CHWProfile shouldn't surface)
    - CHWProfile.is_available == True  (CHW opted into receiving requests)
    - User.is_onboarded == True  (CHW completed the intake questionnaire)
    - cardinality(CHWProfile.specializations) >= 1  (CHW picked at least one
      vertical — without this they have nothing to match a request against)
    - email NOT LIKE %.demo@compasschw.com  (defense in depth against the
      seed_founders.py demo accounts even after cleanup_seed_data.py runs)

    The combination keeps half-registered CHW accounts (someone who signed
    up to test the flow but never completed intake) out of the Find CHW
    results until their profile is actually usable.
    """
    from sqlalchemy import func

    from app.models.user import CHWProfile, User
    stmt = (
        select(CHWProfile, User.name)
        .join(User, CHWProfile.user_id == User.id)
        .where(CHWProfile.is_available == True)  # noqa: E712
        .where(User.role == "chw")
        .where(User.is_onboarded == True)  # noqa: E712
        # cardinality() returns 0 for an empty ARRAY (or NULL via coalesce).
        # Postgres-specific; fine since we're on Postgres in prod and tests.
        .where(func.coalesce(func.cardinality(CHWProfile.specializations), 0) >= 1)
        # Exclude seeded demo CHW accounts. Pattern matches DEMO_EMAIL_SUFFIX
        # in seed_founders.py / cleanup_seed_data.py — keep in sync.
        .where(~User.email.like("%.demo@compasschw.com"))
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


# ─── CHW Member Profile (HIPAA-gated) ────────────────────────────────────────


@router.get("/members/{member_id}/profile", response_model=CHWMemberProfileView)
async def get_chw_member_profile(
    member_id: UUID,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> CHWMemberProfileView:
    """Return a HIPAA-scoped member profile to an authenticated CHW.

    Authorization gate (minimum-necessary, 45 CFR §164.514(d)):
    The CHW must have at least one of:
    - A session (any status) where chw_id == current_user.id AND member_id == path param
    - A service_request matched to this CHW (matched_chw_id == current_user.id)
      AND member_id == path param

    If neither condition is met, the endpoint returns 403 rather than 404 to
    avoid disclosing whether the member_id exists in the system at all.

    Response fields are the HIPAA minimum set for care delivery. See
    CHWMemberProfileView docstring for the explicit exclusion list.
    """
    from app.models.request import ServiceRequest
    from app.models.session import Session
    from app.models.user import MemberProfile, User

    # ── Authorization: does this CHW have a relationship with this member? ──────
    # We check both sessions and service_requests tables. Using EXISTS-style
    # subqueries keeps the authorization logic independent of the data fetch so
    # neither path can accidentally leak data through a join order ambiguity.

    session_exists_result = await db.execute(
        select(func.count())
        .select_from(Session)
        .where(Session.chw_id == current_user.id)
        .where(Session.member_id == member_id)
    )
    chw_has_session = (session_exists_result.scalar() or 0) > 0

    if not chw_has_session:
        request_exists_result = await db.execute(
            select(func.count())
            .select_from(ServiceRequest)
            .where(ServiceRequest.matched_chw_id == current_user.id)
            .where(ServiceRequest.member_id == member_id)
        )
        chw_has_request = (request_exists_result.scalar() or 0) > 0

        if not chw_has_request:
            raise HTTPException(
                status_code=403,
                detail="You do not have an active relationship with this member.",
            )

    # ── Fetch member User + MemberProfile ────────────────────────────────────────
    # We join User and MemberProfile here because CHWMemberProfileView requires
    # fields from both tables (name/phone from User, language/need/zip from Profile).
    member_result = await db.execute(
        select(User, MemberProfile)
        .join(MemberProfile, MemberProfile.user_id == User.id)
        .where(User.id == member_id)
        .where(User.role == "member")
    )
    row = member_result.one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Member not found.")
    member_user, member_profile = row

    # ── Session statistics scoped to THIS CHW only ────────────────────────────
    # total_sessions_with_you: completed sessions with this CHW specifically.
    # HIPAA: we do NOT return session notes, summary, transcript, or other-CHW counts.
    with_you_result = await db.execute(
        select(func.count())
        .select_from(Session)
        .where(Session.chw_id == current_user.id)
        .where(Session.member_id == member_id)
        .where(Session.status == "completed")
    )
    total_sessions_with_you: int = with_you_result.scalar() or 0

    # total_sessions_all_time: completed sessions across ALL CHWs.
    # Provides care-continuity context without exposing per-CHW PHI.
    all_time_result = await db.execute(
        select(func.count())
        .select_from(Session)
        .where(Session.member_id == member_id)
        .where(Session.status == "completed")
    )
    total_sessions_all_time: int = all_time_result.scalar() or 0

    # last_session_at: most recent session this CHW had with the member.
    last_session_result = await db.execute(
        select(func.max(Session.ended_at))
        .where(Session.chw_id == current_user.id)
        .where(Session.member_id == member_id)
        .where(Session.status == "completed")
    )
    last_session_at = last_session_result.scalar()

    # ── Active open service request matched to this CHW ───────────────────────
    active_request_result = await db.execute(
        select(ServiceRequest.id)
        .where(ServiceRequest.matched_chw_id == current_user.id)
        .where(ServiceRequest.member_id == member_id)
        .where(ServiceRequest.status.in_(["accepted", "open"]))
        .order_by(ServiceRequest.created_at.desc())
        .limit(1)
    )
    active_request_id = active_request_result.scalar()

    return CHWMemberProfileView(
        id=member_user.id,
        name=member_user.name,
        phone=member_user.phone,
        primary_language=member_profile.primary_language,
        primary_need=member_profile.primary_need,
        zip_code=member_profile.zip_code,
        total_sessions_with_you=total_sessions_with_you,
        total_sessions_all_time=total_sessions_all_time,
        last_session_at=last_session_at,
        active_request_id=active_request_id,
    )
