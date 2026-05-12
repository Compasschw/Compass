from datetime import UTC, datetime
from uuid import UUID, uuid5, NAMESPACE_URL

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPBearer
from sqlalchemy import case, extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import require_role
from app.schemas.billing import EarningsSummary
from app.schemas.chw import (
    ActiveJourneyInfo,
    CHWMapDataResponse,
    CHWMemberProfileDetail,
    CHWMemberProfileView,
    MapMemberPin,
    MapResourcePin,
    MembersRosterItem,
)
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

        # Age from DOB — MemberProfile currently stores no dob field so we
        # return null. This is a v1 stub; the field is wired when the
        # demographics schema extension ships.
        # TODO(demographics-ext): replace with real DOB from member_profiles.dob
        age: int | None = None

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
        status: str = "active" if (has_recent_session or has_active_request) else "inactive"

        # Engagement bucket from 60-day session count.
        session_60_count = recent_60_by_member.get(member_id) or 0
        if session_60_count >= 3:
            engagement = "highly"
        elif session_60_count >= 1:
            engagement = "moderately"
        else:
            engagement = "disengaged"

        # Active journey.
        active_journey_info: ActiveJourneyInfo | None = None
        journey = journey_by_member.get(member_id)
        if journey is not None:
            template = templates_by_id.get(journey.template_id)
            current_step = steps_by_id.get(journey.current_step_id) if journey.current_step_id else None
            progress_pct = progress_by_journey.get(journey.id, 0.0)
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
