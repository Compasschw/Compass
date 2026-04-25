"""Seed founder CHW accounts + demo data for dashboard walkthroughs.

Run this once against the production EC2 DB to create:
  - 3 founder CHW accounts (Akram, Jemal, JT) with pre-filled CHWProfile
    and MemberProfile. Pre-onboarded, role=chw so they land in the CHW
    app on login and the dashboard queries resolve.
  - 3 demo CHWs (Maria, Kevin, Ana) so the member-side "Find CHW"
    results are populated.
  - 3 demo members (Rosa, Sam, Luis) so there are people to attach
    service requests / sessions to.
  - Seeded ServiceRequests, Sessions, and BillingClaims tied to each
    founder so the CHW dashboard renders with realistic numbers:
      · Upcoming scheduled session
      · 3 completed sessions in the last 7 days
      · Earnings (pending + paid) + rating + open requests

All seeded ServiceRequests have description prefix "[SEED]" and all
seeded Sessions have notes prefix "[SEED]" so re-runs of this script
wipe the prior seed cleanly before re-inserting. Founder / demo user
rows are upserted (never deleted) to keep their auth + profile data
stable across reseeds.

Usage:
    docker exec -w /code compass-api python -m scripts.seed_founders

Safe to run multiple times.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models.billing import BillingClaim
from app.models.communication import CommunicationSession
from app.models.request import ServiceRequest
from app.models.session import Session
from app.models.user import CHWProfile, MemberProfile, User
from app.services.billing_service import calculate_earnings
from app.utils.security import hash_password

logger = logging.getLogger("compass.seed")

FOUNDER_PASSWORD = "CompassDev2026!"

# Marker prefixes for idempotent re-seed.
SEED_REQ_MARKER = "[SEED]"
SEED_SESSION_MARKER = "[SEED]"


# ─── Users to seed ────────────────────────────────────────────────────────────


@dataclass
class FounderSeed:
    """One founder's seed config.

    Each founder demos the platform from a different role:
      - Akram (admin): web admin dashboard via ADMIN_KEY (no CHW profile)
      - Jemal (chw): in-app CHW experience — browse requests, run sessions, earnings
      - JT (member): in-app member experience — find CHW, request services, roadmap

    `has_chw_profile` is True only when `role == "chw"`; non-CHW founders do NOT
    get a CHWProfile row, so they don't accidentally surface in member-side
    "Find CHW" browse results. Every founder gets a MemberProfile so the app
    doesn't 404 if they ever navigate into member-facing flows.
    """

    email: str
    name: str
    phone: str
    role: str
    has_chw_profile: bool
    zip_code: str = "90033"
    # Only relevant when has_chw_profile is True.
    specializations: tuple[str, ...] = ("housing", "healthcare")
    languages: tuple[str, ...] = ("English",)
    years_experience: int = 5
    bio: str = "Founding team — CompassCHW."


FOUNDERS: list[FounderSeed] = [
    FounderSeed(
        email="akram@joincompasschw.com",
        name="Akram Mahmoud",
        phone="+13109999001",
        role="admin",
        has_chw_profile=False,
        zip_code="90066",
        languages=("English", "Arabic"),
        years_experience=5,
        bio="Co-founder + CTO, CompassCHW. Admin access via web dashboard.",
    ),
    FounderSeed(
        email="jemal@joincompasschw.com",
        name="Jemal",
        phone="+13109999002",
        role="chw",
        has_chw_profile=True,
        zip_code="90022",
        specializations=("food", "housing"),
        languages=("English",),
        years_experience=4,
        bio="Co-founder, CompassCHW. Demo CHW account.",
    ),
    FounderSeed(
        email="jt@joincompasschw.com",
        name="JT",
        phone="+13109999003",
        role="member",
        has_chw_profile=False,
        zip_code="91331",
        languages=("English",),
        years_experience=0,
        bio="Co-founder, CompassCHW. Demo member account.",
    ),
]


@dataclass
class DemoCHW:
    email: str
    name: str
    phone: str
    zip_code: str
    specializations: list[str]
    languages: list[str]
    years_experience: int
    bio: str


DEMO_CHWS: list[DemoCHW] = [
    DemoCHW(
        email="maria.demo@compasschw.com",
        name="Maria Rodriguez",
        phone="+13109998001",
        zip_code="90033",
        specializations=["housing", "food"],
        languages=["English", "Spanish"],
        years_experience=6,
        bio="Bilingual CHW with 6 years of experience navigating housing + food "
            "programs in East LA. Former community member.",
    ),
    DemoCHW(
        email="kevin.demo@compasschw.com",
        name="Kevin Tran",
        phone="+13109998002",
        zip_code="91331",
        specializations=["mental_health", "rehab"],
        languages=["English", "Vietnamese"],
        years_experience=4,
        bio="San Fernando Valley CHW specializing in behavioral health referrals "
            "and substance use recovery support.",
    ),
    DemoCHW(
        email="ana.demo@compasschw.com",
        name="Ana Chen",
        phone="+13109998003",
        zip_code="90022",
        specializations=["healthcare", "housing"],
        languages=["English", "Mandarin", "Cantonese"],
        years_experience=3,
        bio="Focused on Medi-Cal enrollment + chronic disease self-management "
            "coaching in Monterey Park and the eastern LA basin.",
    ),
]


@dataclass
class DemoMember:
    email: str
    name: str
    phone: str
    zip_code: str
    primary_language: str
    primary_need: str


DEMO_MEMBERS: list[DemoMember] = [
    DemoMember(
        email="rosa.demo@compasschw.com",
        name="Rosa Delgado",
        phone="+13109997001",
        zip_code="90033",
        primary_language="Spanish",
        primary_need="housing",
    ),
    DemoMember(
        email="sam.demo@compasschw.com",
        name="Sam Nguyen",
        phone="+13109997002",
        zip_code="91331",
        primary_language="Vietnamese",
        primary_need="mental_health",
    ),
    DemoMember(
        email="luis.demo@compasschw.com",
        name="Luis Herrera",
        phone="+13109997003",
        zip_code="90022",
        primary_language="Spanish",
        primary_need="food",
    ),
]


# ─── Demo scenarios ───────────────────────────────────────────────────────────


@dataclass
class OpenRequestSpec:
    """An open (unmatched) ServiceRequest — shows up in CHW dashboard 'Open Requests'."""
    member_email: str
    vertical: str
    urgency: str  # routine | soon | urgent
    description: str
    preferred_mode: str  # in_person | virtual | phone
    estimated_units: int


OPEN_REQUESTS: list[OpenRequestSpec] = [
    OpenRequestSpec(
        member_email="rosa.demo@compasschw.com",
        vertical="housing",
        urgency="urgent",
        description="Needs help filing a Section 8 voucher renewal — notice is due Friday.",
        preferred_mode="in_person",
        estimated_units=3,
    ),
    OpenRequestSpec(
        member_email="sam.demo@compasschw.com",
        vertical="mental_health",
        urgency="soon",
        description="Looking for a Vietnamese-speaking counselor referral and warm handoff.",
        preferred_mode="virtual",
        estimated_units=2,
    ),
    OpenRequestSpec(
        member_email="luis.demo@compasschw.com",
        vertical="food",
        urgency="routine",
        description="Wants help enrolling in CalFresh + finding a nearby food pantry.",
        preferred_mode="phone",
        estimated_units=2,
    ),
    OpenRequestSpec(
        member_email="rosa.demo@compasschw.com",
        vertical="healthcare",
        urgency="soon",
        description="Needs help scheduling a PCP visit and understanding her Medi-Cal plan.",
        preferred_mode="in_person",
        estimated_units=2,
    ),
]


@dataclass
class FounderScenario:
    """Per-founder demo data: 1 upcoming + completed sessions + claims.

    Each tuple in `completed_sessions` is (days_ago, vertical, mode, duration_min,
    member_email, claim_status).
    """
    founder_email: str
    upcoming_vertical: str
    upcoming_mode: str
    upcoming_days_ahead: int
    upcoming_member_email: str
    completed_sessions: list[tuple[int, str, str, int, str, str]]


FOUNDER_SCENARIOS: list[FounderScenario] = [
    # Jemal is the only CHW-role founder; his dashboard needs populated
    # sessions + claims so the earnings/upcoming/open-requests views render.
    FounderScenario(
        founder_email="jemal@joincompasschw.com",
        upcoming_vertical="food",
        upcoming_mode="phone",
        upcoming_days_ahead=2,
        upcoming_member_email="luis.demo@compasschw.com",
        completed_sessions=[
            (1, "food",          "phone",     45, "luis.demo@compasschw.com", "paid"),
            (2, "food",          "phone",     30, "luis.demo@compasschw.com", "paid"),
            (3, "housing",       "in_person", 60, "rosa.demo@compasschw.com", "submitted"),
            (5, "healthcare",    "phone",     45, "luis.demo@compasschw.com", "pending"),
            (6, "food",          "phone",     60, "luis.demo@compasschw.com", "paid"),
        ],
    ),
]


@dataclass
class MemberScenario:
    """Per-member-founder demo data — populates the member-side experience.

    Each entry in `own_requests` is (vertical, urgency, description, preferred_mode,
    estimated_units, status, matched_chw_email).  `status` is "open" or "matched";
    "matched" requires matched_chw_email.  `upcoming_session` is an optional
    (chw_email, vertical, mode, days_ahead) tuple that produces a scheduled
    session visible on MemberSessions / MemberHome.
    """

    member_email: str
    own_requests: list[tuple[str, str, str, str, int, str, str | None]]
    upcoming_session: tuple[str, str, str, int] | None


MEMBER_SCENARIOS: list[MemberScenario] = [
    # JT (member-role founder) needs some of his own requests + an upcoming
    # session with one of the demo CHWs so his MemberHome / MemberSessions
    # screens render populated instead of empty.
    MemberScenario(
        member_email="jt@joincompasschw.com",
        own_requests=[
            (
                "mental_health",
                "soon",
                "Looking for support navigating a new behavioral-health diagnosis.",
                "virtual",
                2,
                "matched",
                "kevin.demo@compasschw.com",
            ),
            (
                "healthcare",
                "routine",
                "Needs help understanding Medi-Cal specialty referrals.",
                "phone",
                2,
                "open",
                None,
            ),
        ],
        upcoming_session=("kevin.demo@compasschw.com", "mental_health", "virtual", 2),
    ),
]


# ─── User upsert helpers ──────────────────────────────────────────────────────


async def _upsert_user(
    db: AsyncSession,
    email: str,
    name: str,
    phone: str,
    role: str,
    password: str,
) -> User:
    """Create or update a user row by email, return the hydrated model."""
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None:
        user = User(
            id=uuid.uuid4(),
            email=email,
            password_hash=hash_password(password),
            name=name,
            phone=phone,
            role=role,
            is_active=True,
            is_onboarded=True,
        )
        db.add(user)
        logger.info("Created user: %s (%s)", email, role)
    else:
        user.name = name
        user.phone = phone
        user.role = role
        user.password_hash = hash_password(password)
        user.is_active = True
        user.is_onboarded = True
        logger.info("Updated user: %s (%s)", email, role)
    await db.flush()
    return user


async def _upsert_chw_profile(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    specializations: list[str],
    languages: list[str],
    bio: str,
    zip_code: str,
    years_experience: int,
    rating: float = 4.9,
    rating_count: int = 12,
    total_sessions: int = 0,
) -> None:
    result = await db.execute(select(CHWProfile).where(CHWProfile.user_id == user_id))
    profile = result.scalar_one_or_none()
    if profile is None:
        profile = CHWProfile(
            id=uuid.uuid4(),
            user_id=user_id,
            specializations=specializations,
            languages=languages,
            bio=bio,
            zip_code=zip_code,
            years_experience=years_experience,
            is_available=True,
            rating=rating,
            rating_count=rating_count,
            total_sessions=total_sessions,
        )
        db.add(profile)
    else:
        profile.specializations = specializations
        profile.languages = languages
        profile.bio = bio
        profile.zip_code = zip_code
        profile.years_experience = years_experience
        profile.is_available = True
        profile.rating = rating
        profile.rating_count = rating_count
    await db.flush()


async def _upsert_member_profile(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    zip_code: str = "90033",
    primary_language: str = "English",
    primary_need: str = "healthcare",
) -> None:
    result = await db.execute(select(MemberProfile).where(MemberProfile.user_id == user_id))
    profile = result.scalar_one_or_none()
    if profile is None:
        profile = MemberProfile(
            id=uuid.uuid4(),
            user_id=user_id,
            zip_code=zip_code,
            primary_language=primary_language,
            primary_need=primary_need,
            rewards_balance=0,
        )
        db.add(profile)
    else:
        profile.zip_code = zip_code
        profile.primary_language = primary_language
        profile.primary_need = primary_need
    await db.flush()


# ─── Demo-data helpers ────────────────────────────────────────────────────────


async def _wipe_previous_seed(db: AsyncSession) -> None:
    """Remove prior seeded demo rows so re-runs don't pile up duplicates.

    Order matters because of foreign keys — children must be deleted before
    parents:
        communication_sessions → billing_claims → sessions → service_requests

    Cascade scope: we wipe anything tagged with `[SEED]` AND any downstream
    rows that were created later against a seeded parent (e.g. a session
    produced when Jemal accepted a seeded request via the UI — the session
    won't have the SEED marker but it still points at a seeded request, so
    dropping the request would FK-violate).
    """
    # IDs of all sessions to wipe: tagged-seed plus any session whose
    # request_id is a seeded request.
    seeded_request_ids_subq = select(ServiceRequest.id).where(
        ServiceRequest.description.like(f"{SEED_REQ_MARKER}%")
    )
    session_ids_result = await db.execute(
        select(Session.id).where(
            (Session.notes.like(f"{SEED_SESSION_MARKER}%"))
            | (Session.request_id.in_(seeded_request_ids_subq))
        )
    )
    session_ids_to_wipe: list[uuid.UUID] = [
        row[0] for row in session_ids_result.all()
    ]

    # 1. Delete communication_sessions linked to any session we'll wipe.
    # (Vonage masked-calling webhooks create these; if any exist from a
    # prior demo/test, they'd block deletion of the parent session.)
    if session_ids_to_wipe:
        await db.execute(
            delete(CommunicationSession).where(
                CommunicationSession.session_id.in_(session_ids_to_wipe)
            )
        )

        # 2. Delete billing claims for any session we'll wipe.
        await db.execute(
            delete(BillingClaim).where(
                BillingClaim.session_id.in_(session_ids_to_wipe)
            )
        )

        # 3. Delete the sessions themselves.
        await db.execute(
            delete(Session).where(Session.id.in_(session_ids_to_wipe))
        )

    # 4. Delete service requests tagged as seed.
    await db.execute(
        delete(ServiceRequest).where(
            ServiceRequest.description.like(f"{SEED_REQ_MARKER}%")
        )
    )
    await db.flush()


async def _cleanup_stale_profiles(
    db: AsyncSession, founders_by_email: dict[str, User]
) -> None:
    """Remove CHWProfile rows for founders who are no longer role=chw.

    When a founder's role flips (e.g., akram admin, jt member), the previously
    seeded CHWProfile becomes stale — it would still surface in member-side
    "Find CHW" browse results. This runs AFTER user role updates and BEFORE
    the scenario seeders so the data is internally consistent.
    """
    stale_user_ids = [
        founder.id
        for email, founder in founders_by_email.items()
        if founder.role != "chw"
    ]
    if not stale_user_ids:
        return

    await db.execute(
        delete(CHWProfile).where(CHWProfile.user_id.in_(stale_user_ids))
    )
    await db.flush()
    logger.info("Cleaned up %d stale CHWProfile row(s)", len(stale_user_ids))


async def _seed_open_requests(
    db: AsyncSession, members_by_email: dict[str, User]
) -> None:
    """Seed open (unmatched) ServiceRequests — populate CHW "Open Requests" feed."""
    for spec in OPEN_REQUESTS:
        member = members_by_email[spec.member_email]
        req = ServiceRequest(
            id=uuid.uuid4(),
            member_id=member.id,
            matched_chw_id=None,
            vertical=spec.vertical,
            urgency=spec.urgency,
            description=f"{SEED_REQ_MARKER} {spec.description}",
            preferred_mode=spec.preferred_mode,
            status="open",
            estimated_units=spec.estimated_units,
        )
        db.add(req)
    await db.flush()


async def _seed_founder_scenario(
    db: AsyncSession,
    scenario: FounderScenario,
    founders_by_email: dict[str, User],
    members_by_email: dict[str, User],
) -> None:
    """Seed upcoming + completed sessions (with matched requests + claims)
    for a single founder CHW."""
    founder = founders_by_email[scenario.founder_email]
    now = datetime.now(UTC)

    # ── Upcoming scheduled session ────────────────────────────────────────────
    upcoming_member = members_by_email[scenario.upcoming_member_email]
    scheduled_at = now + timedelta(days=scenario.upcoming_days_ahead, hours=1)

    upcoming_request = ServiceRequest(
        id=uuid.uuid4(),
        member_id=upcoming_member.id,
        matched_chw_id=founder.id,
        vertical=scenario.upcoming_vertical,
        urgency="soon",
        description=f"{SEED_REQ_MARKER} Scheduled follow-up with {upcoming_member.name}.",
        preferred_mode=scenario.upcoming_mode,
        status="matched",
        estimated_units=2,
    )
    db.add(upcoming_request)
    await db.flush()

    upcoming_session = Session(
        id=uuid.uuid4(),
        request_id=upcoming_request.id,
        chw_id=founder.id,
        member_id=upcoming_member.id,
        vertical=scenario.upcoming_vertical,
        status="scheduled",
        mode=scenario.upcoming_mode,
        scheduled_at=scheduled_at,
        notes=f"{SEED_SESSION_MARKER} Upcoming session — follow-up from initial intake.",
    )
    db.add(upcoming_session)

    # ── Completed sessions + billing claims ───────────────────────────────────
    for days_ago, vertical, mode, duration_min, member_email, claim_status in scenario.completed_sessions:
        member = members_by_email[member_email]
        started_at = now - timedelta(days=days_ago, hours=2)
        ended_at = started_at + timedelta(minutes=duration_min)
        units = max(1, duration_min // 15)  # 15-min billing increments, min 1
        earnings = calculate_earnings(units)

        # Matched ServiceRequest (status=completed), tagged so wipe catches it.
        done_request = ServiceRequest(
            id=uuid.uuid4(),
            member_id=member.id,
            matched_chw_id=founder.id,
            vertical=vertical,
            urgency="routine",
            description=f"{SEED_REQ_MARKER} Completed session with {member.name}.",
            preferred_mode=mode,
            status="completed",
            estimated_units=units,
        )
        db.add(done_request)
        await db.flush()

        done_session = Session(
            id=uuid.uuid4(),
            request_id=done_request.id,
            chw_id=founder.id,
            member_id=member.id,
            vertical=vertical,
            status="completed",
            mode=mode,
            scheduled_at=started_at,
            started_at=started_at,
            ended_at=ended_at,
            duration_minutes=duration_min,
            suggested_units=units,
            units_billed=units,
            gross_amount=Decimal(str(earnings["gross"])),
            net_amount=Decimal(str(earnings["net"])),
            notes=f"{SEED_SESSION_MARKER} Completed — {duration_min} min.",
        )
        db.add(done_session)
        await db.flush()

        # Billing claim — service_date = the calendar day the session happened.
        claim = BillingClaim(
            id=uuid.uuid4(),
            session_id=done_session.id,
            chw_id=founder.id,
            member_id=member.id,
            diagnosis_codes=["Z59.1"],  # Inadequate housing — sample Z-code
            procedure_code="98960",
            modifier="U2",
            units=units,
            gross_amount=Decimal(str(earnings["gross"])),
            platform_fee=Decimal(str(earnings["platform_fee"])),
            pear_suite_fee=Decimal(str(earnings["pear_suite_fee"])),
            net_payout=Decimal(str(earnings["net"])),
            status=claim_status,
            service_date=ended_at.date(),
            submitted_at=ended_at if claim_status in {"submitted", "paid"} else None,
            adjudicated_at=ended_at + timedelta(hours=6) if claim_status == "paid" else None,
            paid_at=ended_at + timedelta(hours=6) if claim_status == "paid" else None,
            paid_to_chw_at=ended_at + timedelta(hours=8) if claim_status == "paid" else None,
        )
        db.add(claim)

    await db.flush()


async def _seed_member_scenario(
    db: AsyncSession,
    scenario: MemberScenario,
    member_founders_by_email: dict[str, User],
    demo_chws_by_email: dict[str, User],
) -> None:
    """Seed the member-side data: this member's own service requests + optional
    upcoming scheduled session with a demo CHW.

    Makes MemberHome / MemberSessions / MemberRoadmap render populated instead
    of empty when the member-role founder logs in.
    """
    member = member_founders_by_email.get(scenario.member_email)
    if member is None:
        logger.warning(
            "Skipping member scenario — member %s not found", scenario.member_email
        )
        return

    # ── Own requests (open + matched) ─────────────────────────────────────────
    for vertical, urgency, description, mode, units, status, chw_email in scenario.own_requests:
        matched_chw_id: uuid.UUID | None = None
        if status == "matched":
            if chw_email is None or chw_email not in demo_chws_by_email:
                logger.warning(
                    "Matched request for member %s needs a valid CHW email (got %s)",
                    scenario.member_email,
                    chw_email,
                )
                continue
            matched_chw_id = demo_chws_by_email[chw_email].id

        req = ServiceRequest(
            id=uuid.uuid4(),
            member_id=member.id,
            matched_chw_id=matched_chw_id,
            vertical=vertical,
            urgency=urgency,
            description=f"{SEED_REQ_MARKER} {description}",
            preferred_mode=mode,
            status=status,
            estimated_units=units,
        )
        db.add(req)

    # ── Upcoming session with a demo CHW ──────────────────────────────────────
    if scenario.upcoming_session is not None:
        chw_email, vertical, mode, days_ahead = scenario.upcoming_session
        chw_user = demo_chws_by_email.get(chw_email)
        if chw_user is None:
            logger.warning(
                "Skipping upcoming session — CHW %s not found in seeded CHWs",
                chw_email,
            )
        else:
            now = datetime.now(UTC)
            scheduled_at = now + timedelta(days=days_ahead, hours=2)

            upcoming_req = ServiceRequest(
                id=uuid.uuid4(),
                member_id=member.id,
                matched_chw_id=chw_user.id,
                vertical=vertical,
                urgency="soon",
                description=f"{SEED_REQ_MARKER} Scheduled follow-up session.",
                preferred_mode=mode,
                status="matched",
                estimated_units=2,
            )
            db.add(upcoming_req)
            await db.flush()

            upcoming_session = Session(
                id=uuid.uuid4(),
                request_id=upcoming_req.id,
                chw_id=chw_user.id,
                member_id=member.id,
                vertical=vertical,
                status="scheduled",
                mode=mode,
                scheduled_at=scheduled_at,
                notes=f"{SEED_SESSION_MARKER} Member-side upcoming session.",
            )
            db.add(upcoming_session)

    await db.flush()


# ─── Main ─────────────────────────────────────────────────────────────────────


async def _migrate_renamed_emails(db: AsyncSession) -> None:
    """One-time migration for renamed founder emails.

    Before running the upsert loop, rename any founder rows whose email
    changed in source. Today this handles tj@joincompasschw.com →
    jt@joincompasschw.com — renaming in place preserves all FK
    relationships (CHWProfile, sessions, claims) so the subsequent upsert
    only needs to update name/role.

    Safe to run on every seed — becomes a no-op once the old email no
    longer exists. If both old and new emails exist (e.g. a failed prior
    seed created the new one), the migration aborts and logs a warning —
    operator should resolve manually.
    """
    legacy_to_current = {"tj@joincompasschw.com": "jt@joincompasschw.com"}

    for legacy_email, current_email in legacy_to_current.items():
        legacy_result = await db.execute(
            select(User).where(User.email == legacy_email)
        )
        legacy_user = legacy_result.scalar_one_or_none()
        if legacy_user is None:
            continue

        current_result = await db.execute(
            select(User).where(User.email == current_email)
        )
        if current_result.scalar_one_or_none() is not None:
            logger.warning(
                "Both %s and %s exist — skipping rename. "
                "Manual merge required.",
                legacy_email,
                current_email,
            )
            continue

        await db.execute(
            update(User)
            .where(User.email == legacy_email)
            .values(email=current_email)
        )
        await db.flush()
        logger.info("Migrated %s → %s", legacy_email, current_email)


async def seed() -> None:
    async with async_session() as db:
        founders_by_email: dict[str, User] = {}
        members_by_email: dict[str, User] = {}

        # ── One-time email migrations (tj@ → jt@ etc) must run before upsert
        # so the renamed row is what gets updated.
        await _migrate_renamed_emails(db)

        # ── Founders: one per role (admin, chw, member) for multi-perspective demo.
        # Each founder always gets a MemberProfile so member-facing flows don't
        # 404 if they navigate into them. CHWProfile is created only when
        # has_chw_profile is True (i.e., the dedicated CHW founder).
        for f in FOUNDERS:
            user = await _upsert_user(
                db,
                email=f.email,
                name=f.name,
                phone=f.phone,
                role=f.role,
                password=FOUNDER_PASSWORD,
            )
            founders_by_email[f.email] = user
            if f.has_chw_profile:
                await _upsert_chw_profile(
                    db,
                    user.id,
                    specializations=list(f.specializations),
                    languages=list(f.languages),
                    bio=f.bio,
                    zip_code=f.zip_code,
                    years_experience=f.years_experience,
                )
            await _upsert_member_profile(db, user.id, zip_code=f.zip_code)

        # ── Demo CHWs — visible in member-side Find CHW search.
        for c in DEMO_CHWS:
            user = await _upsert_user(
                db,
                email=c.email,
                name=c.name,
                phone=c.phone,
                role="chw",
                password=FOUNDER_PASSWORD,
            )
            await _upsert_chw_profile(
                db,
                user.id,
                specializations=c.specializations,
                languages=c.languages,
                bio=c.bio,
                zip_code=c.zip_code,
                years_experience=c.years_experience,
            )

        # ── Demo members — used as member_id on seeded requests/sessions.
        for m in DEMO_MEMBERS:
            user = await _upsert_user(
                db,
                email=m.email,
                name=m.name,
                phone=m.phone,
                role="member",
                password=FOUNDER_PASSWORD,
            )
            members_by_email[m.email] = user
            await _upsert_member_profile(
                db,
                user.id,
                zip_code=m.zip_code,
                primary_language=m.primary_language,
                primary_need=m.primary_need,
            )

        # ── Wipe prior seed rows so this script is idempotent.
        await _wipe_previous_seed(db)

        # ── Clean up CHWProfile rows left behind when a founder's role flipped.
        await _cleanup_stale_profiles(db, founders_by_email)

        # ── Open requests feed (visible to CHW-role founders).
        await _seed_open_requests(db, members_by_email)

        # ── CHW founder scenarios: upcoming + completed sessions + claims.
        # Build a combined dict so CHW scenarios can still reference demo CHWs
        # as matched CHW for member scenarios too.
        chw_users_by_email: dict[str, User] = {
            f.email: founders_by_email[f.email]
            for f in FOUNDERS
            if f.has_chw_profile and f.email in founders_by_email
        }
        for scenario in FOUNDER_SCENARIOS:
            await _seed_founder_scenario(
                db, scenario, founders_by_email, members_by_email
            )

        # ── Member founder scenarios: own requests + upcoming session with a demo CHW.
        # Founders with role=member need their OWN data to populate member screens.
        member_founders_by_email: dict[str, User] = {
            f.email: founders_by_email[f.email]
            for f in FOUNDERS
            if f.role == "member"
        }
        demo_chws_by_email: dict[str, User] = {}
        # Rehydrate demo CHW users so we can match requests to them.
        for c in DEMO_CHWS:
            result = await db.execute(select(User).where(User.email == c.email))
            chw_user = result.scalar_one_or_none()
            if chw_user is not None:
                demo_chws_by_email[c.email] = chw_user

        for scenario in MEMBER_SCENARIOS:
            await _seed_member_scenario(
                db,
                scenario,
                member_founders_by_email,
                demo_chws_by_email,
            )

        await db.commit()

    print()
    print("✓ Seed complete.")
    print()
    print("Founder logins (pre-onboarded):")
    for f in FOUNDERS:
        print(f"  {f.email:<32} role={f.role:<7} password: {FOUNDER_PASSWORD}")
    print()
    print("Demo CHW accounts (role=chw):")
    for c in DEMO_CHWS:
        print(f"  {c.email:<32} zip={c.zip_code} specs={c.specializations}")
    print()
    print("Demo member accounts (role=member):")
    for m in DEMO_MEMBERS:
        print(f"  {m.email:<32} zip={m.zip_code} need={m.primary_need}")
    print()
    print(f"Seeded {len(OPEN_REQUESTS)} open requests + founder scenarios.")
    print()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
    asyncio.run(seed())
