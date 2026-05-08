from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPBearer
from sqlalchemy import extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import require_role
from app.schemas.billing import EarningsSummary
from app.schemas.chw import CHWMemberProfileDetail, CHWMemberProfileView
from app.schemas.user import CHWProfileResponse, CHWProfileUpdate

_bearer_scheme = HTTPBearer()

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


# ─── CHW Member Full Profile (rich, member profile screen) ───────────────────


async def _require_chw_or_admin_key(
    credentials=Depends(_bearer_scheme),
    db: AsyncSession = Depends(get_db),
):
    """Dependency: accepts a CHW user JWT or the admin API key.

    Returns a small context dict with keys:
      - ``role``:    "chw" | "admin"
      - ``user``:    the User ORM row (CHW callers) or None (admin-key callers)

    Raises 401 when the token is invalid for both paths.
    Raises 403 when the token is a valid JWT for a non-CHW user.
    """
    import hmac

    from app.config import settings
    from app.models.user import User
    from app.utils.security import decode_token

    token = credentials.credentials

    # Admin key path — checked first so ops tooling works without a user account.
    if hmac.compare_digest(token, settings.admin_key):
        return {"role": "admin", "user": None}

    # User JWT path.
    payload = decode_token(token)
    if payload is None or payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user_id_str = payload.get("sub")
    if user_id_str is None:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    result = await db.execute(select(User).where(User.id == UUID(user_id_str)))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    if user.role != "chw":
        raise HTTPException(status_code=403, detail="CHW role required")

    return {"role": "chw", "user": user}


@router.get("/members/{member_id}", response_model=CHWMemberProfileDetail)
async def get_chw_member_full_profile(
    member_id: UUID,
    caller=Depends(_require_chw_or_admin_key),
    db: AsyncSession = Depends(get_db),
) -> CHWMemberProfileDetail:
    """Return the full HIPAA-scoped member profile for the CHW Member Profile screen.

    This is a richer superset of GET /chw/members/{member_id}/profile, adding:
    - Billing unit caps (today used/remaining, year used/remaining)
    - Recent session history scoped to this CHW
    - Open goals and follow-ups from session_followups
    - Consent status (ai_transcription, session_recording)
    - MCO, ECM eligibility flag, additional languages

    Authorization gate (minimum-necessary, 45 CFR §164.514(d)):
    - CHW: must have at least one session or accepted service_request involving
      this member. Returns 403 (not 404) when the gate fails to avoid disclosing
      whether the member_id exists.
    - Admin: unrestricted access to any member.

    Assessment data (member_assessment table) is owned by the questionnaire-engine
    parallel agent and is NOT fetched here. The frontend calls
    GET /api/v1/chw/members/{member_id}/assessments/latest separately and degrades
    gracefully on 404.
    """
    from datetime import date as _date

    from app.models.billing import BillingClaim
    from app.models.followup import SessionFollowup
    from app.models.request import ServiceRequest
    from app.models.session import MemberConsent, Session
    from app.models.user import MemberProfile, User
    from app.schemas.chw import (
        BillingUnitsView,
        ConsentStatusView,
        OpenFollowupItem,
        OpenGoalItem,
        SessionSummaryItem,
    )
    from app.services.billing_service import MAX_UNITS_PER_DAY, MAX_UNITS_PER_YEAR

    # ── Unpack caller context ─────────────────────────────────────────────────
    caller_role: str = caller["role"]
    caller_user = caller["user"]  # User ORM row for CHW callers; None for admin key

    # ── Authorization gate ────────────────────────────────────────────────────
    # Admin bypasses the relationship check. For CHW callers we verify an active
    # relationship exists via either a session row or a matched service request.

    if caller_role != "admin":
        assert caller_user is not None  # Guard: non-admin must have a user row
        session_exists = await db.execute(
            select(func.count())
            .select_from(Session)
            .where(Session.chw_id == caller_user.id)
            .where(Session.member_id == member_id)
        )
        chw_has_session = (session_exists.scalar() or 0) > 0

        if not chw_has_session:
            request_exists = await db.execute(
                select(func.count())
                .select_from(ServiceRequest)
                .where(ServiceRequest.matched_chw_id == caller_user.id)
                .where(ServiceRequest.member_id == member_id)
            )
            chw_has_request = (request_exists.scalar() or 0) > 0

            if not chw_has_request:
                raise HTTPException(
                    status_code=403,
                    detail="You do not have an active relationship with this member.",
                )

    # ── Fetch member User + MemberProfile ─────────────────────────────────────
    member_result = await db.execute(
        select(User, MemberProfile)
        .join(MemberProfile, MemberProfile.user_id == User.id)
        .where(User.id == member_id)
        .where(User.role == "member")
        .where(User.deleted_at.is_(None))
    )
    row = member_result.one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Member not found.")
    member_user, member_profile = row

    # ── Split name into first / last ──────────────────────────────────────────
    name_parts = member_user.name.strip().split(" ", 1)
    first_name = name_parts[0]
    last_name = name_parts[1] if len(name_parts) > 1 else ""

    # ── Billing unit caps for this CHW↔member pair ────────────────────────────
    # Scoped to the calling CHW so caps are meaningful per-CHW per Medi-Cal rules.
    # Admins see the caps for the most-recently-active CHW, or zeros if none.
    today = datetime.now(UTC).date()

    if caller_role == "admin":
        # For admin view: find the most recent CHW who worked with this member
        # and use their caps. Falls back to zeros if no billing history exists.
        latest_chw_result = await db.execute(
            select(BillingClaim.chw_id)
            .where(BillingClaim.member_id == member_id)
            .order_by(BillingClaim.created_at.desc())
            .limit(1)
        )
        billing_chw_id = latest_chw_result.scalar()
    else:
        billing_chw_id = caller_user.id

    if billing_chw_id is not None:
        from app.services.billing_service import check_unit_caps
        caps = await check_unit_caps(db, billing_chw_id, member_id, today)
        billing_units = BillingUnitsView(
            today_used=caps["daily_used"],
            today_remaining=caps["daily_remaining"],
            yearly_used=caps["yearly_used"],
            yearly_remaining=caps["yearly_remaining"],
        )
    else:
        billing_units = BillingUnitsView(
            today_used=0,
            today_remaining=MAX_UNITS_PER_DAY,
            yearly_used=0,
            yearly_remaining=MAX_UNITS_PER_YEAR,
        )

    # ── Session history (scoped to this CHW, newest first, capped at 50) ──────
    # Admin sees all sessions across CHWs for context.
    if caller_role == "admin":
        sessions_stmt = (
            select(Session)
            .where(Session.member_id == member_id)
            .order_by(Session.created_at.desc())
            .limit(50)
        )
    else:
        sessions_stmt = (
            select(Session)
            .where(Session.chw_id == caller_user.id)
            .where(Session.member_id == member_id)
            .order_by(Session.created_at.desc())
            .limit(50)
        )
    sessions_result = await db.execute(sessions_stmt)
    session_rows = sessions_result.scalars().all()

    session_count = sum(1 for s in session_rows if s.status == "completed")
    last_session_at = next(
        (s.ended_at for s in session_rows if s.status == "completed" and s.ended_at),
        None,
    )
    recent_sessions = [
        SessionSummaryItem(
            id=s.id,
            status=s.status,
            mode=s.mode,
            scheduled_at=s.scheduled_at,
            started_at=s.started_at,
            ended_at=s.ended_at,
            duration_minutes=s.duration_minutes,
            units_billed=s.units_billed,
        )
        for s in session_rows
    ]

    # ── Open goals from session_followups ─────────────────────────────────────
    # kind == 'member_goal', status not in (completed, dismissed).
    goals_result = await db.execute(
        select(SessionFollowup)
        .where(SessionFollowup.member_id == member_id)
        .where(SessionFollowup.kind == "member_goal")
        .where(SessionFollowup.status.not_in(["completed", "dismissed"]))
        .order_by(SessionFollowup.due_date.asc().nullslast(), SessionFollowup.created_at.asc())
        .limit(20)
    )
    goal_rows = goals_result.scalars().all()
    open_goals = [
        OpenGoalItem(
            text=g.description,
            due_date=g.due_date,
        )
        for g in goal_rows
    ]

    # ── Open follow-ups from session_followups ────────────────────────────────
    # kind in (follow_up_task, action_item), status not in (completed, dismissed).
    followups_result = await db.execute(
        select(SessionFollowup)
        .where(SessionFollowup.member_id == member_id)
        .where(SessionFollowup.kind.in_(["follow_up_task", "action_item"]))
        .where(SessionFollowup.status.not_in(["completed", "dismissed"]))
        .order_by(SessionFollowup.due_date.asc().nullslast(), SessionFollowup.created_at.asc())
        .limit(20)
    )
    followup_rows = followups_result.scalars().all()
    open_followups = [
        OpenFollowupItem(
            text=f.description,
            due_date=f.due_date,
        )
        for f in followup_rows
    ]

    # ── Consent status (most recent per consent_type) ─────────────────────────
    # We query MemberConsent to find if the member has ever granted/denied each
    # type. The most recent row per type is authoritative. A missing row means
    # the member was never asked (status == "none").
    #
    # consent_type values in use: "ai_transcription", "session_recording"
    consent_result = await db.execute(
        select(MemberConsent)
        .where(MemberConsent.member_id == member_id)
        .where(MemberConsent.consent_type.in_(["ai_transcription", "session_recording"]))
        .order_by(MemberConsent.consented_at.desc())
    )
    consent_rows = consent_result.scalars().all()

    # Index by type — latest row per type wins (query is ordered desc).
    consent_by_type: dict[str, str] = {}
    for c in consent_rows:
        if c.consent_type not in consent_by_type:
            # All rows in MemberConsent represent an affirmative grant (the schema
            # doesn't store denials — denials are represented by the absence of a row
            # or by a ConsentRequest with status='denied'). So presence == "granted".
            consent_by_type[c.consent_type] = "granted"

    # Check ConsentRequest for explicit denials so "denied" surfaces correctly.
    from app.models.session import ConsentRequest as _ConsentRequest
    denial_result = await db.execute(
        select(_ConsentRequest)
        .where(_ConsentRequest.member_id == member_id)
        .where(_ConsentRequest.status == "denied")
        .where(_ConsentRequest.consent_type.in_(["ai_transcription", "session_recording"]))
        .order_by(_ConsentRequest.responded_at.desc())
    )
    denial_rows = denial_result.scalars().all()
    for d in denial_rows:
        # Only mark denied if no granted row exists (granted is more recent than denied).
        if d.consent_type not in consent_by_type:
            consent_by_type[d.consent_type] = "denied"

    consent_status = ConsentStatusView(
        ai_transcription=consent_by_type.get("ai_transcription", "none"),
        session_recording=consent_by_type.get("session_recording", "none"),
    )

    # ── Build additional_languages ────────────────────────────────────────────
    # The current schema stores only primary_language on MemberProfile.
    # additional_languages defaults to [] until the schema is extended.
    # This field is a placeholder for Phase 2 multi-language support.
    additional_languages: list[str] = []

    # ── Primary categories (verticals) ───────────────────────────────────────
    # Derived from the member's session history — the set of unique verticals
    # across all their sessions provides the best "care needs" signal.
    verticals_result = await db.execute(
        select(Session.vertical)
        .where(Session.member_id == member_id)
        .distinct()
    )
    primary_categories = [v for (v,) in verticals_result.all() if v]
    # Fall back to primary_need from the profile if no sessions exist.
    if not primary_categories and member_profile.primary_need:
        primary_categories = [member_profile.primary_need]

    return CHWMemberProfileDetail(
        id=member_user.id,
        first_name=first_name,
        last_name=last_name,
        phone_e164=member_user.phone,
        email=member_user.email,
        primary_language=member_profile.primary_language,
        additional_languages=additional_languages,
        address=None,         # Not stored in current schema — Phase 2 field
        city=None,            # Not stored in current schema — Phase 2 field
        zip_code=member_profile.zip_code,
        mco=member_profile.insurance_provider,  # MCO = insurance plan in Medi-Cal context
        ecm_eligible=False,   # ECM eligibility not yet stored — Phase 2 flag
        primary_categories=primary_categories,
        billing_units=billing_units,
        session_count=session_count,
        last_session_at=last_session_at,
        open_goals=open_goals,
        open_followups=open_followups,
        consent_status=consent_status,
        recent_sessions=recent_sessions,
    )
