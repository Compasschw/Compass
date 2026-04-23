"""Seed the three founder admin accounts + a few demo CHW/member profiles.

Run this once against the production EC2 DB to create the accounts
Akram, Jemal, and TJ use to log in and play with the platform before the
public launch. All three are role=admin, pre-onboarded, and share the
dev password defined below (rotate before go-live).

Also seeds 3 demo CHW profiles + 2 demo member profiles so the admin
apps have data to click through (Find CHW results, requests list, etc.).

Usage:
    docker exec -w /code compass-api python -m scripts.seed_founders

The script is idempotent — re-running it updates existing rows rather
than duplicating them. Safe to run multiple times.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models.user import CHWProfile, MemberProfile, User
from app.utils.security import hash_password

logger = logging.getLogger("compass.seed")

FOUNDER_PASSWORD = "CompassDev2026!"


@dataclass
class FounderSeed:
    email: str
    name: str
    phone: str
    role: str = "admin"
    # Extra profile rows — founders as admin still get a CHW + member profile
    # seeded so role-specific endpoints don't 404 when they explore.
    also_chw: bool = True
    also_member: bool = True


FOUNDERS: list[FounderSeed] = [
    FounderSeed(email="akram@joincompasschw.com", name="Akram Mahmoud", phone="+13109999001"),
    FounderSeed(email="jemal@joincompasschw.com", name="Jemal",           phone="+13109999002"),
    FounderSeed(email="tj@joincompasschw.com",    name="TJ",              phone="+13109999003"),
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
]


# ─── Helpers ─────────────────────────────────────────────────────────────────


async def _upsert_user(
    db: AsyncSession,
    email: str,
    name: str,
    phone: str,
    role: str,
    password: str,
) -> User:
    """Create or update a user row, return the hydrated model."""
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
    spec: DemoCHW | None = None,
    zip_fallback: str = "90033",
) -> None:
    result = await db.execute(select(CHWProfile).where(CHWProfile.user_id == user_id))
    profile = result.scalar_one_or_none()
    if profile is None:
        profile = CHWProfile(
            id=uuid.uuid4(),
            user_id=user_id,
            specializations=(spec.specializations if spec else ["healthcare"]),
            languages=(spec.languages if spec else ["English"]),
            bio=(spec.bio if spec else "Founding team admin account."),
            zip_code=(spec.zip_code if spec else zip_fallback),
            years_experience=(spec.years_experience if spec else 0),
            is_available=True,
            rating=5.0,
            rating_count=0,
            total_sessions=0,
        )
        db.add(profile)
    elif spec is not None:
        profile.specializations = spec.specializations
        profile.languages = spec.languages
        profile.bio = spec.bio
        profile.zip_code = spec.zip_code
        profile.years_experience = spec.years_experience
        profile.is_available = True
    await db.flush()


async def _upsert_member_profile(
    db: AsyncSession,
    user_id: uuid.UUID,
    spec: DemoMember | None = None,
) -> None:
    result = await db.execute(select(MemberProfile).where(MemberProfile.user_id == user_id))
    profile = result.scalar_one_or_none()
    if profile is None:
        profile = MemberProfile(
            id=uuid.uuid4(),
            user_id=user_id,
            zip_code=(spec.zip_code if spec else "90033"),
            primary_language=(spec.primary_language if spec else "English"),
            primary_need=(spec.primary_need if spec else "healthcare"),
            rewards_balance=0,
        )
        db.add(profile)
    elif spec is not None:
        profile.zip_code = spec.zip_code
        profile.primary_language = spec.primary_language
        profile.primary_need = spec.primary_need
    await db.flush()


# ─── Main ────────────────────────────────────────────────────────────────────


async def seed() -> None:
    async with async_session() as db:
        # Founders — 3 admin users, each also given CHW + member profiles so
        # any role-gated endpoint renders rather than 404s.
        for f in FOUNDERS:
            user = await _upsert_user(
                db,
                email=f.email,
                name=f.name,
                phone=f.phone,
                role=f.role,
                password=FOUNDER_PASSWORD,
            )
            if f.also_chw:
                await _upsert_chw_profile(db, user.id)
            if f.also_member:
                await _upsert_member_profile(db, user.id)

        # Demo CHWs — show up in Find CHW search results for member role.
        for c in DEMO_CHWS:
            user = await _upsert_user(
                db,
                email=c.email,
                name=c.name,
                phone=c.phone,
                role="chw",
                password=FOUNDER_PASSWORD,
            )
            await _upsert_chw_profile(db, user.id, spec=c)

        # Demo members — show up in request / session lists for CHW role.
        for m in DEMO_MEMBERS:
            user = await _upsert_user(
                db,
                email=m.email,
                name=m.name,
                phone=m.phone,
                role="member",
                password=FOUNDER_PASSWORD,
            )
            await _upsert_member_profile(db, user.id, spec=m)

        await db.commit()

    print()
    print("✓ Seed complete.")
    print()
    print("Founder logins (all role=admin, pre-onboarded):")
    for f in FOUNDERS:
        print(f"  {f.email:<32} password: {FOUNDER_PASSWORD}")
    print()
    print("Demo CHW accounts (role=chw):")
    for c in DEMO_CHWS:
        print(f"  {c.email:<32} zip={c.zip_code} specs={c.specializations}")
    print()
    print("Demo member accounts (role=member):")
    for m in DEMO_MEMBERS:
        print(f"  {m.email:<32} zip={m.zip_code} need={m.primary_need}")
    print()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
    asyncio.run(seed())
