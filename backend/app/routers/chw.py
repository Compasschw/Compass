from datetime import UTC, date, datetime, timedelta
from typing import Literal
from uuid import NAMESPACE_URL, UUID, uuid5
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.security import HTTPBearer
from sqlalchemy import any_, case, extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import require_role
from app.schemas.billing import EarningsSummary, PayoutItem, SessionEarningItem
from app.schemas.chw import (
    ActiveJourneyInfo,
    CHWMapDataResponse,
    CHWMemberProfileDetail,
    CHWMemberProfileView,
    CloseMemberRequest,
    MapMemberPin,
    MapResourcePin,
    MemberClosureResponse,
    MemberDemographicsUpdate,
    MembersRosterItem,
    PreferredNameResponse,
    PreferredNameUpdate,
    ResourceNeedLevelItem,
    ResourceNeedsUpdate,
    SessionNoteItem,
)
from app.schemas.user import CHWProfileResponse, CHWProfileUpdate
from app.services.storage.avatar_urls import presigned_avatar_url

_bearer_scheme = HTTPBearer()

router = APIRouter(prefix="/api/v1/chw", tags=["chw"])

# ── Resource need level sorting ───────────────────────────────────────────────
# Maps a level label to a sort key: lower number = higher priority (sorted asc).
# "high" needs float to the top; ties are resolved by caller's original order
# (Python's sorted() is stable).
_LEVEL_RANK: dict[str, int] = {"high": 0, "medium": 1, "low": 2}

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
        profile_picture_url=presigned_avatar_url(current_user.profile_picture_url),
        hipaa_training_completed=profile.hipaa_training_completed,
        chw_certification=profile.chw_certification,
        background_check_status=profile.background_check_status,
    )


# Allowed values for CHWProfile.background_check_status. Kept in sync with the
# model column comment and the frontend picker.
_BACKGROUND_CHECK_STATUSES = {"not_started", "pending", "clear", "consider"}


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
    """Update the authenticated CHW's profile.

    Fields that live on CHWProfile (specializations, languages, bio, zip_code,
    is_available) are written to the CHWProfile row.  ``profile_picture_url``
    lives on the User row and is routed there explicitly — it must NOT be set
    via setattr on the CHWProfile object (that column doesn't exist there).
    """
    from app.models.user import CHWProfile
    result = await db.execute(select(CHWProfile).where(CHWProfile.user_id == current_user.id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    payload = data.model_dump(exclude_unset=True)

    # Validate the compliance enum at the boundary before it reaches setattr.
    bg_status = payload.get("background_check_status")
    if bg_status is not None and bg_status not in _BACKGROUND_CHECK_STATUSES:
        raise HTTPException(
            status_code=422,
            detail=f"background_check_status must be one of {sorted(_BACKGROUND_CHECK_STATUSES)}",
        )

    # Route profile_picture_url to the User row, not the CHWProfile row.
    if "profile_picture_url" in payload:
        current_user.profile_picture_url = payload.pop("profile_picture_url")

    # Name lives on the User row too — route it there and reject blank values.
    if "name" in payload:
        new_name = (payload.pop("name") or "").strip()
        if not new_name:
            raise HTTPException(status_code=422, detail="Name cannot be empty.")
        current_user.name = new_name

    for field, value in payload.items():
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
        # any_(col) == value renders "value = ANY (specializations)" — identical
        # SQL to ARRAY.Comparator.any(value), but with precise typing.
        stmt = stmt.where(any_(CHWProfile.specializations) == vertical)
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

# Earnings-page period selector. "custom" is reserved for a future date-range.
EarningsPeriod = Literal["this_month", "last_month"]


def _period_year_month(period: str, now: datetime) -> tuple[int, int]:
    """Resolve a period selector to a (year, month) pair. Defaults to this month."""
    if period == "last_month":
        first_of_this_month = now.replace(day=1)
        last_month = first_of_this_month - timedelta(days=1)
        return last_month.year, last_month.month
    return now.year, now.month


def _next_friday(now: datetime) -> date:
    """Next Friday (CompassCHW pays out weekly on Fridays). Today, if a Friday,
    rolls to the following Friday so a stale 'paid today' is never shown."""
    days_ahead = (4 - now.weekday()) % 7  # Mon=0 … Fri=4
    if days_ahead == 0:
        days_ahead = 7
    return (now + timedelta(days=days_ahead)).date()


def _claim_paid_clause():
    """A claim has reached the CHW once the transfer settled (paid_to_chw_at) or
    its status is 'paid'."""
    from app.models.billing import BillingClaim

    return (BillingClaim.paid_to_chw_at.isnot(None)) | (BillingClaim.status == "paid")


@router.get("/earnings", response_model=EarningsSummary)
async def get_earnings(
    period: EarningsPeriod = Query(default="this_month"),
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
):
    from app.models.billing import BillingClaim
    from app.models.session import Session
    from app.models.user import CHWProfile

    now = datetime.now(UTC)
    year, month = _period_year_month(period, now)

    async def _sum(*clauses) -> float:
        stmt = select(func.coalesce(func.sum(BillingClaim.net_payout), 0)).where(
            BillingClaim.chw_id == current_user.id, *clauses
        )
        return float((await db.execute(stmt)).scalar())  # type: ignore[arg-type]

    # Earnings booked in the selected period (claim created in that month).
    earnings_this_period = await _sum(
        extract("month", BillingClaim.created_at) == month,
        extract("year", BillingClaim.created_at) == year,
    )
    # "This month" field kept for backward compat with existing dashboard callers.
    this_month = (
        earnings_this_period
        if period == "this_month"
        else await _sum(
            extract("month", BillingClaim.created_at) == now.month,
            extract("year", BillingClaim.created_at) == now.year,
        )
    )
    all_time = await _sum()
    # Paid out in the selected period (transfer settled that month).
    paid_this_period = await _sum(
        _claim_paid_clause(),
        extract("month", BillingClaim.paid_to_chw_at) == month,
        extract("year", BillingClaim.paid_to_chw_at) == year,
    )
    # Pending payout = ALL outstanding (not period-scoped): what's owed to the CHW.
    pending_payout = await _sum(~_claim_paid_clause())

    # Sessions this week (completed sessions in the last 7 days) — legacy field.
    week_ago = now - timedelta(days=7)
    sessions_this_week = (
        await db.execute(
            select(func.count())
            .select_from(Session)
            .where(Session.chw_id == current_user.id)
            .where(Session.status == "completed")
            .where(Session.ended_at >= week_ago)
        )
    ).scalar() or 0

    avg_rating = float(
        (
            await db.execute(
                select(CHWProfile.rating).where(CHWProfile.user_id == current_user.id)
            )
        ).scalar()
        or 0
    )

    return EarningsSummary(
        this_month=this_month,
        all_time=all_time,
        avg_rating=avg_rating,
        sessions_this_week=sessions_this_week,
        pending_payout=pending_payout,
        earnings_this_period=earnings_this_period,
        paid_this_period=paid_this_period,
        pending_in_transit=pending_payout > 0,
        next_payout_date=_next_friday(now) if pending_payout > 0 else None,
    )


@router.get("/earnings/sessions", response_model=list[SessionEarningItem])
async def list_earning_sessions(
    period: EarningsPeriod = Query(default="this_month"),
    limit: int = Query(default=50, ge=1, le=200),
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> list[SessionEarningItem]:
    """Completed-session earnings for the Sessions Completed table.

    One row per billable claim: service date, member name, units, net amount, and
    a simple Paid/Pending payment status. Scoped to the selected period by the
    claim's service date (falls back to created_at when service_date is null).
    """
    from app.models.billing import BillingClaim
    from app.models.session import Session
    from app.models.user import User

    now = datetime.now(UTC)
    year, month = _period_year_month(period, now)

    paid_case = case((_claim_paid_clause(), "paid"), else_="pending")
    rows = (
        await db.execute(
            select(
                BillingClaim.session_id,
                func.coalesce(BillingClaim.service_date, func.date(BillingClaim.created_at)).label("svc_date"),
                User.name.label("member_name"),
                Session.mode.label("session_mode"),
                BillingClaim.units,
                BillingClaim.net_payout,
                paid_case.label("payment_status"),
            )
            .join(Session, Session.id == BillingClaim.session_id)
            .join(User, User.id == BillingClaim.member_id)
            .where(BillingClaim.chw_id == current_user.id)
            .where(
                extract(
                    "month", func.coalesce(BillingClaim.service_date, BillingClaim.created_at)
                )
                == month
            )
            .where(
                extract(
                    "year", func.coalesce(BillingClaim.service_date, BillingClaim.created_at)
                )
                == year
            )
            .order_by(func.coalesce(BillingClaim.service_date, func.date(BillingClaim.created_at)).desc())
            .limit(limit)
        )
    ).all()

    return [
        SessionEarningItem(
            session_id=r.session_id,
            service_date=r.svc_date,
            member_name=r.member_name or "Member",
            session_mode=r.session_mode or "in_person",
            units=int(r.units),
            amount_earned=float(r.net_payout),
            payment_status=r.payment_status,
        )
        for r in rows
    ]


@router.get("/payouts", response_model=list[PayoutItem])
async def list_payouts(
    period: EarningsPeriod = Query(default="this_month"),
    limit: int = Query(default=50, ge=1, le=200),
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> list[PayoutItem]:
    """Recent payouts for the Recent Payouts table.

    No separate payout ledger exists today, so a payout == a paid BillingClaim:
    the Stripe transfer that moved the CHW's net share. Scoped to the period by
    paid_to_chw_at. ``reference`` is the Stripe transfer id; ``method`` is a
    generic label since Stripe owns the bank details.
    """
    from app.models.billing import BillingClaim

    now = datetime.now(UTC)
    year, month = _period_year_month(period, now)

    rows = (
        await db.execute(
            select(
                BillingClaim.paid_to_chw_at,
                BillingClaim.net_payout,
                BillingClaim.stripe_transfer_id,
            )
            .where(BillingClaim.chw_id == current_user.id)
            .where(_claim_paid_clause())
            .where(BillingClaim.paid_to_chw_at.isnot(None))
            .where(extract("month", BillingClaim.paid_to_chw_at) == month)
            .where(extract("year", BillingClaim.paid_to_chw_at) == year)
            .order_by(BillingClaim.paid_to_chw_at.desc())
            .limit(limit)
        )
    ).all()

    return [
        PayoutItem(
            date=r.paid_to_chw_at,
            amount=float(r.net_payout),
            status="paid",
            method="Bank Account",
            reference=r.stripe_transfer_id,
        )
        for r in rows
    ]


# ─── Members Roster ───────────────────────────────────────────────────────────


@router.get("/members", response_model=list[MembersRosterItem])
async def list_chw_members(
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> list[MembersRosterItem]:
    """Return all members this CHW has a relationship with, ordered by last contact desc.

    Relationship gate: a member is included when at least ONE of the following
    is true (mirrors _assert_chw_member_relationship in journeys.py):
      1. Any Session row where chw_id == current_user.id AND member_id == member.
      2. Any matched ServiceRequest where matched_chw_id == current_user.id AND
         member_id == member.

    For each member the endpoint computes:
      - status: 'active' when session in last 30 days OR open/accepted ServiceRequest.
      - engagement: 'highly' ≥3 sessions last 60 days, 'moderately' 1–2, 'disengaged' 0.
      - risk: always null (v1 — no clinical risk model).
      - active_journey: most recent active MemberJourney.
      - last_contact_at: most recent session.ended_at or scheduled_at.
      - top_need: primary vertical of the most recent active ServiceRequest.

    All queries are N+1-aware: member IDs are collected in a single pass, then
    supporting data (journeys, requests, session counts) are fetched in batches.

    HIPAA: medi_cal_id is decrypted only to produce the last-4 masked_id. The raw
    value is never written to any response field or log line.
    """
    from datetime import timedelta

    from app.models.journeys import (
        JourneyTemplate,
        JourneyTemplateStep,
        MemberJourney,
        MemberJourneyStepState,
    )
    from app.models.request import ServiceRequest
    from app.models.session import Session
    from app.models.user import MemberProfile, User

    now = datetime.now(UTC)
    thirty_days_ago = now - timedelta(days=30)
    sixty_days_ago = now - timedelta(days=60)

    # ── Step 1: collect unique member IDs via session + service_request join ──────
    # Sessions: any status counts toward the relationship gate.
    session_member_result = await db.execute(
        select(Session.member_id).where(Session.chw_id == current_user.id).distinct()
    )
    session_member_ids: set[UUID] = {r for (r,) in session_member_result.all()}

    # ServiceRequests: matched_chw_id relationship gate.
    request_member_result = await db.execute(
        select(ServiceRequest.member_id)
        .where(ServiceRequest.matched_chw_id == current_user.id)
        .distinct()
    )
    request_member_ids: set[UUID] = {r for (r,) in request_member_result.all()}

    all_member_ids: list[UUID] = list(session_member_ids | request_member_ids)

    if not all_member_ids:
        return []

    # ── Step 2: batch-load User + MemberProfile for all members ──────────────────
    members_result = await db.execute(
        select(User, MemberProfile)
        .join(MemberProfile, MemberProfile.user_id == User.id)
        .where(User.id.in_(all_member_ids))
        .where(User.role == "member")
        .where(User.deleted_at.is_(None))
    )
    member_rows = members_result.all()

    # ── Step 3: batch-load session counts for status + engagement bucketing ───────
    # recent_30: count per member for sessions in the last 30 days (status signal).
    recent_30_result = await db.execute(
        select(Session.member_id, func.count(Session.id).label("cnt"))
        .where(Session.chw_id == current_user.id)
        .where(Session.member_id.in_(all_member_ids))
        .where(
            # Use ended_at when available (completed sessions), else scheduled_at
            func.coalesce(Session.ended_at, Session.scheduled_at) >= thirty_days_ago
        )
        .group_by(Session.member_id)
    )
    recent_30_by_member: dict[UUID, int] = {
        row.member_id: row.cnt for row in recent_30_result.all()
    }

    # recent_60: count per member for sessions in the last 60 days (engagement).
    recent_60_result = await db.execute(
        select(Session.member_id, func.count(Session.id).label("cnt"))
        .where(Session.chw_id == current_user.id)
        .where(Session.member_id.in_(all_member_ids))
        .where(
            func.coalesce(Session.ended_at, Session.scheduled_at) >= sixty_days_ago
        )
        .group_by(Session.member_id)
    )
    recent_60_by_member: dict[UUID, int] = {
        row.member_id: row.cnt for row in recent_60_result.all()
    }

    # last_contact: most recent session timestamp per member (ended_at preferred).
    last_contact_result = await db.execute(
        select(
            Session.member_id,
            func.max(func.coalesce(Session.ended_at, Session.scheduled_at)).label("last_ts"),
        )
        .where(Session.chw_id == current_user.id)
        .where(Session.member_id.in_(all_member_ids))
        .group_by(Session.member_id)
    )
    last_contact_by_member: dict[UUID, datetime | None] = {
        row.member_id: row.last_ts for row in last_contact_result.all()
    }

    # ── Step 4: batch-load open/accepted ServiceRequests for status + top_need ───
    active_requests_result = await db.execute(
        select(ServiceRequest)
        .where(ServiceRequest.matched_chw_id == current_user.id)
        .where(ServiceRequest.member_id.in_(all_member_ids))
        .where(ServiceRequest.status.in_(["open", "accepted"]))
        .order_by(ServiceRequest.created_at.desc())
    )
    # Keep only the most recent active request per member.
    active_request_by_member: dict[UUID, ServiceRequest] = {}
    for req in active_requests_result.scalars().all():
        if req.member_id not in active_request_by_member:
            active_request_by_member[req.member_id] = req

    # ── Step 5: batch-load active MemberJourneys for this CHW's members ──────────
    journeys_result = await db.execute(
        select(MemberJourney)
        .where(MemberJourney.chw_id == current_user.id)
        .where(MemberJourney.member_id.in_(all_member_ids))
        .where(MemberJourney.status == "active")
        .order_by(MemberJourney.created_at.desc())
    )
    # Keep only the most recent active journey per member.
    journey_by_member: dict[UUID, MemberJourney] = {}
    for journey in journeys_result.scalars().all():
        if journey.member_id not in journey_by_member:
            journey_by_member[journey.member_id] = journey

    # Batch-load templates for those journeys.
    template_ids = list({j.template_id for j in journey_by_member.values()})
    templates_by_id: dict[UUID, JourneyTemplate] = {}
    if template_ids:
        templates_result = await db.execute(
            select(JourneyTemplate).where(JourneyTemplate.id.in_(template_ids))
        )
        templates_by_id = {t.id: t for t in templates_result.scalars().all()}

    # Batch-load current step names for active journeys.
    current_step_ids = [
        j.current_step_id for j in journey_by_member.values() if j.current_step_id
    ]
    steps_by_id: dict[UUID, JourneyTemplateStep] = {}
    if current_step_ids:
        steps_result = await db.execute(
            select(JourneyTemplateStep).where(JourneyTemplateStep.id.in_(current_step_ids))
        )
        steps_by_id = {s.id: s for s in steps_result.scalars().all()}

    # Batch-load progress percents (completed / total step states per journey).
    journey_obj_ids = [j.id for j in journey_by_member.values()]
    progress_by_journey: dict[UUID, float] = {}
    if journey_obj_ids:
        total_steps_result = await db.execute(
            select(
                MemberJourneyStepState.member_journey_id,
                func.count(MemberJourneyStepState.id).label("total"),
                func.sum(
                    case(
                        (MemberJourneyStepState.status == "completed", 1),
                        else_=0,
                    )
                ).label("done"),
            )
            .where(MemberJourneyStepState.member_journey_id.in_(journey_obj_ids))
            .group_by(MemberJourneyStepState.member_journey_id)
        )
        for row in total_steps_result.all():
            total = row.total or 0
            done = row.done or 0
            progress_by_journey[row.member_journey_id] = (
                round(done / total * 100, 1) if total else 0.0
            )

    # ── Step 6: assemble roster items ────────────────────────────────────────────
    roster: list[MembersRosterItem] = []

    for member_user, member_profile in member_rows:
        member_id = member_user.id

        # Age + DOB from member_profiles.date_of_birth (Pear signup demographics).
        dob: date | None = member_profile.date_of_birth
        age: int | None = None
        if dob is not None:
            _today = date.today()
            age = (
                _today.year
                - dob.year
                - ((_today.month, _today.day) < (dob.month, dob.day))
            )

        # masked_id: last 4 chars of decrypted medi_cal_id.
        masked_id: str = "—"
        if member_profile.medi_cal_id:
            raw_id: str = member_profile.medi_cal_id  # EncryptedString decrypts on access
            if len(raw_id) >= 4:
                masked_id = f"...{raw_id[-4:]}"
            elif raw_id:
                masked_id = raw_id

        # avatar_initials from User.name.
        name_parts = (member_user.name or "").strip().split()
        initials = "".join(p[0].upper() for p in name_parts if p)[:2] or "?"

        # Status: active if session in last 30 days OR open/accepted request.
        has_recent_session = (recent_30_by_member.get(member_id) or 0) > 0
        has_active_request = member_id in active_request_by_member
        status: Literal["active", "inactive"] = (
            "active" if (has_recent_session or has_active_request) else "inactive"
        )

        # Engagement bucket from 60-day session count.
        session_60_count = recent_60_by_member.get(member_id) or 0
        engagement: Literal["highly", "moderately", "disengaged"]
        if session_60_count >= 3:
            engagement = "highly"
        elif session_60_count >= 1:
            engagement = "moderately"
        else:
            engagement = "disengaged"

        # Active journey.
        active_journey_info: ActiveJourneyInfo | None = None
        member_journey = journey_by_member.get(member_id)
        if member_journey is not None:
            template = templates_by_id.get(member_journey.template_id)
            current_step = steps_by_id.get(member_journey.current_step_id) if member_journey.current_step_id else None
            progress_pct = progress_by_journey.get(member_journey.id, 0.0)
            if template is not None:
                active_journey_info = ActiveJourneyInfo(
                    name=template.name,
                    current_step=current_step.name if current_step else None,
                    percent=progress_pct,
                )

        # Last contact.
        last_contact_at = last_contact_by_member.get(member_id)

        # Top need: primary vertical of most recent active ServiceRequest.
        top_need: str | None = None
        active_req = active_request_by_member.get(member_id)
        if active_req is not None:
            # Use verticals[0] (authoritative) or fall back to legacy vertical field.
            if active_req.verticals:
                top_need = active_req.verticals[0]
            elif active_req.vertical:
                top_need = active_req.vertical

        roster.append(
            MembersRosterItem(
                id=member_id,
                display_name=member_user.name,
                age=age,
                date_of_birth=dob,
                masked_id=masked_id,
                avatar_initials=initials,
                status=status,
                risk=None,
                engagement=engagement,
                active_journey=active_journey_info,
                last_contact_at=last_contact_at,
                top_need=top_need,
            )
        )

    # Sort by last_contact_at descending (null → end of list).
    roster.sort(key=lambda item: item.last_contact_at or datetime.min.replace(tzinfo=UTC), reverse=True)

    return roster


# ─── Map Data ─────────────────────────────────────────────────────────────────

# ZIP-centroid lookup — approximate centroids from US Census ZCTA5 boundary data.
# Mirrors the frontend geocoding.ts table so both layers resolve identically.
# Keys are 5-digit ZIP strings; values are (lat, lng) tuples.
_ZIP_CENTROIDS: dict[str, tuple[float, float]] = {
    # South LA / Central LA
    "90001": (33.9731, -118.2479),
    "90002": (33.9491, -118.2462),
    "90003": (33.9641, -118.2732),
    "90011": (34.0063, -118.2585),
    "90015": (34.0368, -118.2711),
    "90022": (34.0218, -118.1567),
    "90033": (34.0471, -118.2095),
    "90037": (34.0013, -118.2877),
    "90044": (33.9566, -118.3038),
    "90059": (33.9278, -118.2391),
    # West LA / Westside
    "90034": (34.0222, -118.4127),
    "90066": (34.0008, -118.4256),
    "90025": (34.0437, -118.4429),
    "90064": (34.0348, -118.4179),
    # San Fernando Valley
    "91331": (34.2366, -118.3981),
    "91406": (34.1936, -118.5261),
    "91342": (34.2742, -118.4376),
    "91401": (34.1685, -118.4541),
    "91601": (34.1756, -118.3759),
    # East LA / SGV
    "90032": (34.0804, -118.1782),
    "91754": (34.0508, -118.1321),
    "91801": (34.0873, -118.1279),
}

# Stub resource data (LA-area community resources).
# TODO(compass-wt-resources): replace with a real DB query once the Resources
# table from the compass-wt-resources worktree is merged into main.
_STUB_RESOURCES: list[dict] = [
    {
        "id": uuid5(NAMESPACE_URL, "skid-row-care-center"),
        "name": "Skid Row Care Center",
        "category": "housing",
        "latitude": 34.0430,
        "longitude": -118.2448,
        "address": "526 San Pedro St, Los Angeles, CA 90013",
    },
    {
        "id": uuid5(NAMESPACE_URL, "watts-health-center"),
        "name": "Watts Health Center",
        "category": "healthcare",
        "latitude": 33.9425,
        "longitude": -118.2460,
        "address": "10300 Compton Ave, Los Angeles, CA 90002",
    },
    {
        "id": uuid5(NAMESPACE_URL, "la-regional-food-bank"),
        "name": "LA Regional Food Bank – Watts Distribution",
        "category": "food",
        "latitude": 33.9700,
        "longitude": -118.2900,
        "address": "1734 E 41st St, Los Angeles, CA 90011",
    },
    {
        "id": uuid5(NAMESPACE_URL, "didi-hirsch-mental-health"),
        "name": "Didi Hirsch Mental Health Services – South LA",
        "category": "mental_health",
        "latitude": 33.9950,
        "longitude": -118.2830,
        "address": "4760 S Sepulveda Blvd, Culver City, CA 90230",
    },
    {
        "id": uuid5(NAMESPACE_URL, "inglewood-mental-health"),
        "name": "Inglewood Mental Health Center",
        "category": "mental_health",
        "latitude": 33.9617,
        "longitude": -118.3531,
        "address": "333 E Manchester Blvd, Inglewood, CA 90301",
    },
    {
        "id": uuid5(NAMESPACE_URL, "south-la-food-bank"),
        "name": "South LA Food Bank",
        "category": "food",
        "latitude": 33.9700,
        "longitude": -118.2900,
        "address": "1234 Main St, Los Angeles, CA 90011",
    },
    {
        "id": uuid5(NAMESPACE_URL, "harbor-ucla-rehab"),
        "name": "Harbor-UCLA Rehabilitation Services",
        "category": "rehab",
        "latitude": 33.8956,
        "longitude": -118.2484,
        "address": "1000 W Carson St, Torrance, CA 90509",
    },
    {
        "id": uuid5(NAMESPACE_URL, "pacoima-beautiful-housing"),
        "name": "Pacoima Beautiful – Housing Navigation",
        "category": "housing",
        "latitude": 34.2725,
        "longitude": -118.3953,
        "address": "13520 Van Nuys Blvd, Pacoima, CA 91331",
    },
    {
        "id": uuid5(NAMESPACE_URL, "east-la-health-center"),
        "name": "East LA Health Center",
        "category": "healthcare",
        "latitude": 34.0296,
        "longitude": -118.1612,
        "address": "4801 E 3rd St, Los Angeles, CA 90022",
    },
    {
        "id": uuid5(NAMESPACE_URL, "proyecto-pastoral-food"),
        "name": "Proyecto Pastoral Food Pantry",
        "category": "food",
        "latitude": 34.0471,
        "longitude": -118.2095,
        "address": "2955 E Olympic Blvd, Los Angeles, CA 90023",
    },
]


@router.get("/map-data", response_model=CHWMapDataResponse)
async def get_map_data(
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> CHWMapDataResponse:
    """Return the CHW's member locations and community resource pins for the map view.

    Member layer (PHI-minimised):
    - Returns only members the calling CHW has had at least one session with.
    - Display name is first initial + period only ("J.") — minimum necessary.
    - Coordinates are ZIP-centroid, NOT precise address.
    - Members whose ZIP is not in the centroid table are silently excluded
      (unmappable until they update their profile ZIP).

    Resource layer (not PHI):
    - Returns a curated list of LA-area community resources.
    - Precise coordinates are appropriate for public service locations.
    - TODO(compass-wt-resources): replace stub with DB query post-merge.

    Authorization: any authenticated CHW (require_role("chw")).
    HIPAA: see MapMemberPin and CHWMemberProfileView docstrings for the
    explicit minimum-necessary field exclusion list.
    """
    from app.models.session import Session
    from app.models.user import MemberProfile, User

    # ── Build member pins ────────────────────────────────────────────────────────
    # One row per unique member the CHW has had at least one session with.
    # We aggregate session_count in SQL so we don't fetch all sessions to memory.
    sessions_stmt = (
        select(
            Session.member_id,
            func.count(Session.id).label("session_count"),
        )
        .where(Session.chw_id == current_user.id)
        .group_by(Session.member_id)
    )
    sessions_result = await db.execute(sessions_stmt)
    session_rows = sessions_result.all()

    member_pins: list[MapMemberPin] = []
    for member_id, session_count in session_rows:
        # Fetch User + MemberProfile for this member.
        member_result = await db.execute(
            select(User, MemberProfile)
            .join(MemberProfile, MemberProfile.user_id == User.id)
            .where(User.id == member_id)
            .where(User.role == "member")
        )
        row = member_result.one_or_none()
        if row is None:
            # Defensive: session references a deleted / role-changed user.
            continue

        member_user, member_profile = row

        # Resolve ZIP to centroid. Skip members whose ZIP is unknown.
        zip_code: str | None = member_profile.zip_code
        if not zip_code:
            continue
        centroid = _ZIP_CENTROIDS.get(zip_code.strip())
        if centroid is None:
            continue

        lat, lng = centroid

        # PHI-minimised display name: first initial + period only.
        first_letter = (member_user.name or "?")[0].upper()
        display_name = f"{first_letter}."

        # Primary categories from the member's stated need + additional_needs.
        categories: list[str] = []
        if member_profile.primary_need:
            categories.append(member_profile.primary_need)
        if member_profile.additional_needs:
            for need in member_profile.additional_needs:
                if need not in categories:
                    categories.append(need)

        member_pins.append(
            MapMemberPin(
                id=member_user.id,
                display_name=display_name,
                zip_code=zip_code,
                latitude=lat,
                longitude=lng,
                primary_categories=categories,
                session_count=session_count,
            )
        )

    # ── Build resource pins from stub ────────────────────────────────────────────
    resource_pins = [
        MapResourcePin(
            id=r["id"],
            name=r["name"],
            category=r["category"],
            latitude=r["latitude"],
            longitude=r["longitude"],
            address=r["address"],
        )
        for r in _STUB_RESOURCES
    ]

    return CHWMapDataResponse(members=member_pins, resources=resource_pins)


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

    # ── PHI read audit log (45 CFR §164.312(b) — Audit Controls) ─────────────
    # A targeted phi_read row supplements the request-level AuditMiddleware row
    # with structured resource context (member_id, fields accessed, actor role).
    # Uses an independent session (same pattern as AuditMiddleware) so the commit
    # is guaranteed regardless of whether the endpoint's own session is committed.
    # Never fails the request — exceptions are logged and swallowed.
    from app.database import async_session as _async_session
    from app.models.audit import AuditLog as _AuditLog

    try:
        actor_id = caller_user.id if caller_role != "admin" else None
        async with _async_session() as _audit_session:
            _audit_session.add(_AuditLog(
                user_id=actor_id,
                action="phi_read",
                resource="member_demographics",
                resource_id=str(member_user.id),
                details={
                    "fields": ["date_of_birth", "gender", "medi_cal_id"],
                    "actor_role": caller_role,
                },
            ))
            await _audit_session.commit()
    except Exception as _audit_exc:  # noqa: BLE001
        import logging as _logging
        _logging.getLogger("compass.audit").error(
            "phi_read audit log insert failed for member %s: %s",
            member_user.id,
            _audit_exc,
        )

    # ── Build resource_needs + resource_need_levels ───────────────────────────
    # resource_needs: primary_need first, then additional_needs (de-duped).
    resource_needs_ordered: list[str] = (
        ([member_profile.primary_need] if member_profile.primary_need else [])
        + [
            n
            for n in (member_profile.additional_needs or [])
            if n and n != member_profile.primary_need
        ]
    )

    # Convert stored JSONB dict → list[ResourceNeedLevelItem] in priority order.
    # Slugs present in resource_needs come first (high→med→low priority order);
    # any orphaned entries (in the dict but not in resource_needs) follow.
    stored_levels: dict[str, str] = member_profile.resource_need_levels or {}
    _seen_level_slugs: set[str] = set()
    resource_need_levels_list: list[ResourceNeedLevelItem] = []
    for slug in resource_needs_ordered:
        if slug in stored_levels:
            resource_need_levels_list.append(
                ResourceNeedLevelItem(slug=slug, level=stored_levels[slug])
            )
            _seen_level_slugs.add(slug)
    for slug, level in stored_levels.items():
        if slug not in _seen_level_slugs:
            resource_need_levels_list.append(ResourceNeedLevelItem(slug=slug, level=level))

    return CHWMemberProfileDetail(
        id=member_user.id,
        first_name=first_name,
        last_name=last_name,
        preferred_name=member_profile.preferred_name,
        phone_e164=member_user.phone,
        email=member_user.email,
        primary_language=member_profile.primary_language,
        additional_languages=additional_languages,
        address=(
            ", ".join(
                p for p in (member_profile.address_line1, member_profile.address_line2) if p
            )
            or None
        ),
        city=(
            f"{member_profile.city}, {member_profile.state}"
            if member_profile.city and member_profile.state
            else member_profile.city
        ),
        zip_code=member_profile.zip_code,
        # MCO = insurance plan in Medi-Cal context.
        # New signups write to insurance_company (curated dropdown); legacy/CHW-edited
        # records write to insurance_provider. Coalesce both so the CHW profile always
        # shows a value for members regardless of which intake path they used.
        mco=member_profile.insurance_company or member_profile.insurance_provider,
        address_line1=member_profile.address_line1,
        address_line2=member_profile.address_line2,
        city_name=member_profile.city,
        state=member_profile.state,
        ecm_eligible=False,   # ECM eligibility not yet stored — Phase 2 flag
        primary_categories=primary_categories,
        resource_needs=resource_needs_ordered,
        resource_need_levels=resource_need_levels_list,
        billing_units=billing_units,
        session_count=session_count,
        last_session_at=last_session_at,
        open_goals=open_goals,
        open_followups=open_followups,
        consent_status=consent_status,
        recent_sessions=recent_sessions,
        # Member's avatar lives on the User row; presign for the CHW client so
        # the CHW Member Profile screen shows the photo the member set.
        profile_picture_url=presigned_avatar_url(member_user.profile_picture_url),
        # PHI demographics — decrypted / read from MemberProfile
        date_of_birth=member_profile.date_of_birth,
        gender=member_profile.gender,
        medi_cal_id=member_profile.medi_cal_id,  # EncryptedString decrypts on access
        # Closure disposition — drives the "Closed" badge + read-only CTAs.
        closure_status=member_profile.closure_status,
        closure_reason=member_profile.closure_reason,
        closed_at=member_profile.closed_at,
    )


@router.patch(
    "/members/{member_id}/preferred-name",
    response_model=PreferredNameResponse,
    summary="Set a member's preferred name (CHW-editable demographics field)",
)
async def update_member_preferred_name(
    member_id: UUID,
    data: PreferredNameUpdate,
    caller=Depends(_require_chw_or_admin_key),
    db: AsyncSession = Depends(get_db),
) -> PreferredNameResponse:
    """Update the member's preferred name from the CHW Member Profile screen.

    Authorization mirrors GET /chw/members/{member_id}: a CHW must have an
    active care relationship (session or matched service request); admins are
    unrestricted. A null/blank value clears the preferred name.

    Errors:
      403 — CHW has no active relationship with this member
      404 — member profile not found
    """
    from app.models.request import ServiceRequest
    from app.models.session import Session
    from app.models.user import MemberProfile

    caller_role: str = caller["role"]
    caller_user = caller["user"]

    # Relationship gate (same as the GET member-detail endpoint).
    if caller_role != "admin":
        assert caller_user is not None
        session_exists = await db.execute(
            select(func.count())
            .select_from(Session)
            .where(Session.chw_id == caller_user.id)
            .where(Session.member_id == member_id)
        )
        if (session_exists.scalar() or 0) == 0:
            request_exists = await db.execute(
                select(func.count())
                .select_from(ServiceRequest)
                .where(ServiceRequest.matched_chw_id == caller_user.id)
                .where(ServiceRequest.member_id == member_id)
            )
            if (request_exists.scalar() or 0) == 0:
                raise HTTPException(
                    status_code=403,
                    detail="You do not have an active relationship with this member.",
                )

    result = await db.execute(
        select(MemberProfile).where(MemberProfile.user_id == member_id)
    )
    profile = result.scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=404, detail="Member not found.")

    profile.preferred_name = data.preferred_name
    await db.commit()
    await db.refresh(profile)
    return PreferredNameResponse(preferred_name=profile.preferred_name)


async def _assert_chw_member_relationship_or_admin(
    caller: dict,
    member_id: UUID,
    db: AsyncSession,
) -> None:
    """Raise 403 unless the caller may act on this member.

    Admins are unrestricted. A CHW must have an active care relationship —
    at least one session OR a matched service request — mirroring the gate used
    by GET /chw/members/{member_id} and the preferred-name/demographics writes.
    """
    from app.models.request import ServiceRequest
    from app.models.session import Session

    if caller["role"] == "admin":
        return

    caller_user = caller["user"]
    assert caller_user is not None
    session_exists = await db.execute(
        select(func.count())
        .select_from(Session)
        .where(Session.chw_id == caller_user.id)
        .where(Session.member_id == member_id)
    )
    if (session_exists.scalar() or 0) > 0:
        return

    request_exists = await db.execute(
        select(func.count())
        .select_from(ServiceRequest)
        .where(ServiceRequest.matched_chw_id == caller_user.id)
        .where(ServiceRequest.member_id == member_id)
    )
    if (request_exists.scalar() or 0) > 0:
        return

    raise HTTPException(
        status_code=403,
        detail="You do not have an active relationship with this member.",
    )


@router.post(
    "/members/{member_id}/close",
    response_model=MemberClosureResponse,
    summary="Close a member's case with a disposition + reason",
)
async def close_member(
    member_id: UUID,
    data: CloseMemberRequest,
    caller=Depends(_require_chw_or_admin_key),
    db: AsyncSession = Depends(get_db),
) -> MemberClosureResponse:
    """Close a member from the CHW Member Profile.

    Records the disposition (status) + reason and stamps the audit trail
    (closed_at / closed_by). Idempotent: closing an already-closed member
    overwrites the disposition. Reversible via POST .../reopen.

    Authorization mirrors the other member-write endpoints: a CHW needs an
    active care relationship; admins are unrestricted.

    Errors:
      403 — CHW has no active relationship with this member
      404 — member profile not found
      422 — invalid status or reason slug
    """
    from app.models.user import MemberProfile

    await _assert_chw_member_relationship_or_admin(caller, member_id, db)

    result = await db.execute(
        select(MemberProfile).where(MemberProfile.user_id == member_id)
    )
    profile = result.scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=404, detail="Member not found.")

    caller_user = caller["user"]
    profile.closure_status = data.status
    profile.closure_reason = data.reason
    profile.closed_at = datetime.now(UTC)
    profile.closed_by = caller_user.id if caller_user is not None else None
    await db.commit()
    await db.refresh(profile)
    return MemberClosureResponse(
        member_id=member_id,
        closure_status=profile.closure_status,
        closure_reason=profile.closure_reason,
        closed_at=profile.closed_at,
    )


@router.post(
    "/members/{member_id}/reopen",
    response_model=MemberClosureResponse,
    summary="Reopen a previously-closed member (clears the disposition)",
)
async def reopen_member(
    member_id: UUID,
    caller=Depends(_require_chw_or_admin_key),
    db: AsyncSession = Depends(get_db),
) -> MemberClosureResponse:
    """Reopen a closed member — clears status/reason/closed_at/closed_by.

    Idempotent: reopening an already-open member is a no-op that returns the
    (null) closure state. Same relationship gate as close.

    Errors:
      403 — CHW has no active relationship with this member
      404 — member profile not found
    """
    from app.models.user import MemberProfile

    await _assert_chw_member_relationship_or_admin(caller, member_id, db)

    result = await db.execute(
        select(MemberProfile).where(MemberProfile.user_id == member_id)
    )
    profile = result.scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=404, detail="Member not found.")

    profile.closure_status = None
    profile.closure_reason = None
    profile.closed_at = None
    profile.closed_by = None
    await db.commit()
    return MemberClosureResponse(member_id=member_id)


@router.get(
    "/members/{member_id}/session-notes",
    response_model=list[SessionNoteItem],
    summary="List CHW-authored session documentation summaries for a member",
)
async def get_member_session_notes(
    member_id: UUID,
    caller=Depends(_require_chw_or_admin_key),
    db: AsyncSession = Depends(get_db),
) -> list[SessionNoteItem]:
    """Return the CHW-authored documentation summary for each of the member's
    documented sessions — the "original" session notes shown in the View Notes
    and Case Notes timelines.

    Scoped like the member-detail session history: a CHW sees only their own
    sessions with this member; admins see all. Newest first. Sessions without a
    documentation summary are omitted.

    Errors:
      403 — CHW has no active relationship with this member
    """
    from app.models.session import Session, SessionDocumentation

    await _assert_chw_member_relationship_or_admin(caller, member_id, db)

    caller_role: str = caller["role"]
    caller_user = caller["user"]

    stmt = (
        select(Session, SessionDocumentation)
        .join(SessionDocumentation, SessionDocumentation.session_id == Session.id)
        .where(Session.member_id == member_id)
    )
    if caller_role != "admin":
        assert caller_user is not None
        stmt = stmt.where(Session.chw_id == caller_user.id)
    # Order newest-first by when the session occurred (fallback to documentation time).
    stmt = stmt.order_by(
        func.coalesce(
            Session.started_at, Session.scheduled_at, SessionDocumentation.submitted_at
        ).desc()
    )

    rows = (await db.execute(stmt)).all()
    return [
        SessionNoteItem(
            session_id=session.id,
            occurred_at=session.started_at or session.scheduled_at,
            mode=session.mode,
            summary=doc.summary,
            submitted_at=doc.submitted_at,
        )
        for session, doc in rows
    ]


@router.patch("/members/{member_id}/demographics")
async def update_member_demographics(
    member_id: UUID,
    data: MemberDemographicsUpdate,
    caller=Depends(_require_chw_or_admin_key),
    db: AsyncSession = Depends(get_db),
):
    """CHW edits a member's demographics from the Member Profile pencil.

    Only the supplied fields change. first_name/last_name combine into
    User.name; phone → User.phone; insurance → both insurance_provider (display)
    and insurance_company (billing); the rest → MemberProfile.

    Authorization mirrors the preferred-name endpoint: the CHW must have an
    active relationship (session or matched request); admins are unrestricted.
    """
    from app.models.request import ServiceRequest
    from app.models.session import Session
    from app.models.user import MemberProfile, User

    caller_role: str = caller["role"]
    caller_user = caller["user"]

    if caller_role != "admin":
        assert caller_user is not None
        session_exists = await db.execute(
            select(func.count())
            .select_from(Session)
            .where(Session.chw_id == caller_user.id)
            .where(Session.member_id == member_id)
        )
        if (session_exists.scalar() or 0) == 0:
            request_exists = await db.execute(
                select(func.count())
                .select_from(ServiceRequest)
                .where(ServiceRequest.matched_chw_id == caller_user.id)
                .where(ServiceRequest.member_id == member_id)
            )
            if (request_exists.scalar() or 0) == 0:
                raise HTTPException(
                    status_code=403,
                    detail="You do not have an active relationship with this member.",
                )

    profile = (
        await db.execute(select(MemberProfile).where(MemberProfile.user_id == member_id))
    ).scalar_one_or_none()
    member_user = await db.get(User, member_id)
    if profile is None or member_user is None:
        raise HTTPException(status_code=404, detail="Member not found.")

    payload = data.model_dump(exclude_unset=True)

    # first/last name → User.name (preserve the untouched half from the current name).
    if "first_name" in payload or "last_name" in payload:
        cur_parts = (member_user.name or "").split(" ", 1)
        cur_first = cur_parts[0] if cur_parts else ""
        cur_last = cur_parts[1] if len(cur_parts) > 1 else ""
        new_first = (payload.pop("first_name", None) if "first_name" in payload else None)
        new_last = (payload.pop("last_name", None) if "last_name" in payload else None)
        first = (new_first if new_first is not None else cur_first).strip()
        last = (new_last if new_last is not None else cur_last).strip()
        combined = f"{first} {last}".strip()
        if combined:
            member_user.name = combined

    if "phone" in payload:
        member_user.phone = payload.pop("phone") or None

    if "insurance" in payload:
        insurance = payload.pop("insurance")
        profile.insurance_provider = insurance
        profile.insurance_company = insurance

    # Remaining keys map 1:1 to MemberProfile columns (preferred_name,
    # date_of_birth, gender, medi_cal_id, address_line1/2, city, state, zip_code,
    # primary_language).
    for field, value in payload.items():
        setattr(profile, field, value)

    await db.commit()
    return {"member_id": str(member_id), "updated": True}


@router.patch("/members/{member_id}/resource-needs")
async def update_member_resource_needs(
    member_id: UUID,
    data: ResourceNeedsUpdate,
    caller=Depends(_require_chw_or_admin_key),
    db: AsyncSession = Depends(get_db),
):
    """CHW edits a member's resource needs (Resource Needs card pencil).

    ``needs`` is a priority-ordered list of resource categories. The first
    becomes primary_need; the rest become additional_needs. An empty list clears
    both. Authorization mirrors the other CHW member-edit endpoints.
    """
    from app.models.request import ServiceRequest
    from app.models.session import Session
    from app.models.user import MemberProfile

    caller_role: str = caller["role"]
    caller_user = caller["user"]

    if caller_role != "admin":
        assert caller_user is not None
        session_exists = await db.execute(
            select(func.count())
            .select_from(Session)
            .where(Session.chw_id == caller_user.id)
            .where(Session.member_id == member_id)
        )
        if (session_exists.scalar() or 0) == 0:
            request_exists = await db.execute(
                select(func.count())
                .select_from(ServiceRequest)
                .where(ServiceRequest.matched_chw_id == caller_user.id)
                .where(ServiceRequest.member_id == member_id)
            )
            if (request_exists.scalar() or 0) == 0:
                raise HTTPException(
                    status_code=403,
                    detail="You do not have an active relationship with this member.",
                )

    profile = (
        await db.execute(select(MemberProfile).where(MemberProfile.user_id == member_id))
    ).scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=404, detail="Member not found.")

    needs = data.needs  # already validated + deduped + lowercased
    levels_list = data.levels  # list[ResourceNeedLevelItem]; deduplicated + validated

    # Build a dict from the incoming list for internal use.
    raw_levels_dict: dict[str, str] = {item.slug: item.level for item in levels_list}

    # Normalise: every slug in ``needs`` gets a level; any omitted → "medium".
    normalized_levels: dict[str, str] = {
        slug: raw_levels_dict.get(slug, "medium") for slug in needs
    }

    # Stable sort by level rank (high=0, medium=1, low=2).
    # Python's sorted() is stable: ties preserve the caller's original order.
    ordered: list[str] = sorted(
        needs, key=lambda slug: _LEVEL_RANK[normalized_levels[slug]]
    )

    profile.primary_need = ordered[0] if ordered else None
    profile.additional_needs = ordered[1:]
    # Store as a dict (no migration needed — JSONB column unchanged).
    profile.resource_need_levels = normalized_levels

    # Persist the resource needs FIRST, on their own. Recording the member's
    # needs is the CHW's core intent; it must never fail because of the secondary
    # journey auto-provisioning step below.
    await db.commit()

    # Reconcile the member's active journeys to the new needs — a best-effort side
    # effect. If it raises (e.g. unexpected template data), the needs are already
    # saved, so log and return success rather than 500ing. An unhandled 500 here
    # would, on web, surface only as "Failed to fetch" (generated outside
    # CORSMiddleware). See backend/TESTING.md rule #3.
    from app.services.journey_reconciler import reconcile_member_journeys_to_needs

    reconcile_chw_id = caller_user.id if caller_role == "chw" else None
    try:
        await reconcile_member_journeys_to_needs(
            db, member_id, ordered, chw_id=reconcile_chw_id
        )
        await db.commit()
    except Exception as exc:  # noqa: BLE001 — provisioning must not block the save
        await db.rollback()
        import logging as _logging

        _logging.getLogger("compass.chw").exception(
            "resource-needs: journey reconciliation failed for member %s "
            "(needs saved; journeys not reconciled): %s",
            member_id,
            exc,
        )

    # Return levels as a list of {slug, level} objects in resource_needs order.
    # Slug stays a string value — immune to camelCase key transforms on mobile.
    return {
        "member_id": str(member_id),
        "resource_needs": ordered,
        "resource_need_levels": [
            {"slug": slug, "level": normalized_levels[slug]} for slug in ordered
        ],
    }


# ─── Billable Units aggregation (per-member cap widget) ───────────────────────

# Medi-Cal per-member daily and yearly unit caps.
# Source: cofounder spec (Phase 1 Second Run, T05).
DAILY_CAP: int = 4
YEARLY_CAP: int = 10

# California wall-clock timezone — used for all service_date comparisons.
# Mirrors the pattern in app/services/billing_csv_writer.py.
_LA_TZ: ZoneInfo = ZoneInfo("America/Los_Angeles")


@router.get("/members/{member_id}/billable-units")
async def get_billable_units(
    member_id: UUID,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return daily and yearly Medi-Cal billable-unit counts for a CHW↔member pair.

    The response drives the "Billable Units (Medi-Cal)" widget on the CHW Member
    Profile screen, which shows:
      - Today: N used / (DAILY_CAP − N) remaining
      - This Year: N used / (YEARLY_CAP − N) remaining

    Counting rules:
    - Only claims where ``chw_id == current_user.id`` AND ``member_id == path param``
      are counted. Each CHW's cap is independent per Medi-Cal billing rules.
    - ``service_date`` (the calendar date the service was delivered) is the
      authoritative date field. Falls back to the date component of ``created_at``
      for legacy rows where ``service_date`` is NULL (via ``billing_service.check_unit_caps``).
    - The "current day" and "current year" are computed in **America/Los_Angeles**
      wall-clock time (not UTC) so the widget reflects the California billing day.

    Authorization: CHW must have at least one session linked to the member.
    Uses ``assert_shared_session`` from ``relationship_guards``, which raises 403
    when no shared session exists.

    Args:
        member_id: Path parameter — UUID of the member whose caps are queried.
        current_user: Authenticated CHW (injected by ``require_role("chw")``).
        db: Async database session.

    Returns:
        A dict with keys ``daily``, ``yearly``, and ``as_of_la_local_date``.

    Raises:
        HTTPException(403): No care relationship (no shared session).
    """
    from app.services.billing_service import check_unit_caps
    from app.services.relationship_guards import assert_shared_session

    # Authorization: CHW must have a shared session with this member.
    await assert_shared_session(db, chw_id=current_user.id, member_id=member_id)

    # Compute the current date in LA wall-clock time.
    # datetime.now(_LA_TZ).date() gives the correct California billing date
    # regardless of the server's UTC offset — critical for late-night sessions.
    today_la_date: date = datetime.now(_LA_TZ).date()  # California billing date

    caps = await check_unit_caps(
        db,
        chw_id=current_user.id,
        member_id=member_id,
        session_date=today_la_date,
    )

    return {
        "daily": {
            "used": caps["daily_used"],
            "limit": DAILY_CAP,
            "remaining": caps["daily_remaining"],
        },
        "yearly": {
            "used": caps["yearly_used"],
            "limit": YEARLY_CAP,
            "remaining": caps["yearly_remaining"],
        },
        "as_of_la_local_date": today_la_date.isoformat(),
    }
