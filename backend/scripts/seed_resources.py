"""Seed the resource catalog with ~15 real-sounding LA-area community resources.

This script is clearly seed data — resource names are realistic but the
specific phone numbers, addresses, and hours are illustrative. Before any
client-facing demo, verify details against the actual organization websites.

Categories covered: food, housing, mental_health, rehab, healthcare, legal,
transportation, other — all 8 catalog values represented.

Usage (from inside the running container or a local venv with DATABASE_URL set):
    docker exec -w /code compass-api python -m scripts.seed_resources
    # or locally:
    python -m scripts.seed_resources

Safe to run multiple times: existing resources with the same name are skipped
(upsert-by-name logic). Delete and re-run if you need to reset the catalog.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.models.resource import Resource

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("compass.seed_resources")


# ─── Seed data ─────────────────────────────────────────────────────────────────


@dataclass
class SeedResource:
    name: str
    description: str
    category: str
    phone: str | None = None
    url: str | None = None
    address: str | None = None
    zip_code: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    hours: str | None = None
    eligibility: str | None = None
    languages: list[str] = field(default_factory=list)


SEED_RESOURCES: list[SeedResource] = [
    # ── Food ──────────────────────────────────────────────────────────────────
    SeedResource(
        name="South LA Food Pantry",
        description=(
            "Weekly food distribution serving South Los Angeles residents. "
            "No income verification required. Provides fresh produce, canned goods, "
            "and hygiene items. USDA SNAP outreach on-site every Tuesday."
        ),
        category="food",
        phone="(323) 555-0141",
        address="1234 Vermont Ave, Los Angeles, CA 90044",
        zip_code="90044",
        latitude=33.9648,
        longitude=-118.2920,
        hours="Mon/Wed/Fri 9 AM–1 PM, Sat 8 AM–12 PM",
        eligibility="Residents of South LA zip codes 90001–90059. Walk-ins welcome.",
        languages=["English", "Spanish"],
    ),
    SeedResource(
        name="Compton Community Food Bank",
        description=(
            "Large food bank serving Compton and surrounding areas. Emergency food "
            "boxes available same-day. Partners with Feeding America. Monthly commodity "
            "distribution for qualifying seniors on the first Wednesday of each month."
        ),
        category="food",
        phone="(310) 555-0183",
        address="456 Willowbrook Ave, Compton, CA 90220",
        zip_code="90220",
        latitude=33.8904,
        longitude=-118.2201,
        hours="Tue–Thu 8 AM–3 PM",
        eligibility="Open to all Compton-area residents; proof of address requested but not required.",
        languages=["English", "Spanish", "Armenian"],
    ),
    # ── Housing ───────────────────────────────────────────────────────────────
    SeedResource(
        name="Skid Row Housing Trust",
        description=(
            "Permanent supportive housing for formerly homeless individuals in "
            "downtown Los Angeles. Offers case management, mental health services, "
            "and peer support alongside housing placement. Prioritizes chronically "
            "homeless adults with serious mental illness or substance use disorders."
        ),
        category="housing",
        phone="(213) 555-0102",
        url="https://srht.org",
        address="600 S Main St, Los Angeles, CA 90014",
        zip_code="90014",
        latitude=34.0411,
        longitude=-118.2519,
        hours="Mon–Fri 8 AM–5 PM (intake by appointment)",
        eligibility=(
            "Chronically homeless adults with a disabling condition. "
            "Must have CalAIM or Medi-Cal enrollment (or be enrolled at intake)."
        ),
        languages=["English", "Spanish"],
    ),
    SeedResource(
        name="PATH Homeless Services — LA",
        description=(
            "Rapid rehousing and bridge housing for individuals and families "
            "experiencing homelessness in Los Angeles County. Outreach teams operate "
            "7 days a week in Watts, Inglewood, and Culver City corridors. "
            "Coordinates with LA County Housing for Authority vouchers."
        ),
        category="housing",
        phone="(323) 555-0177",
        url="https://epath.org",
        address="340 N Madison Ave, Los Angeles, CA 90004",
        zip_code="90004",
        latitude=34.0741,
        longitude=-118.3085,
        hours="Mon–Sun 8 AM–8 PM (drop-in); outreach 24/7",
        eligibility="Individuals and families experiencing homelessness in LA County.",
        languages=["English", "Spanish", "Korean"],
    ),
    # ── Mental Health ──────────────────────────────────────────────────────────
    SeedResource(
        name="DIDI Hirsch Mental Health Services",
        description=(
            "Comprehensive outpatient mental health and substance use treatment "
            "for adults and children across LA County. Sliding-scale fees; Medi-Cal "
            "and most insurance accepted. Crisis stabilization unit available. "
            "24-hour Suicide Prevention Hotline operated by DIDI Hirsch."
        ),
        category="mental_health",
        phone="(800) 854-7771",
        url="https://didihirsch.org",
        address="4760 S Sepulveda Blvd, Culver City, CA 90230",
        zip_code="90230",
        latitude=33.9878,
        longitude=-118.4023,
        hours="Mon–Fri 8 AM–6 PM; Crisis line 24/7",
        eligibility="All ages; sliding-scale fees; Medi-Cal accepted.",
        languages=["English", "Spanish", "Farsi", "Korean"],
    ),
    SeedResource(
        name="Exodus Recovery — South LA Outpatient",
        description=(
            "Community mental health center providing individual therapy, group therapy, "
            "psychiatric medication management, and case management. Specialty programs "
            "for trauma, grief, and co-occurring disorders. Medi-Cal primary payer."
        ),
        category="mental_health",
        phone="(323) 555-0199",
        address="9808 Vermont Ave, Los Angeles, CA 90044",
        zip_code="90044",
        latitude=33.9561,
        longitude=-118.2948,
        hours="Mon–Fri 8 AM–5 PM",
        eligibility="Adults 18+ with Medi-Cal or uninsured. Walk-in assessment available Tuesdays 10 AM–1 PM.",
        languages=["English", "Spanish"],
    ),
    # ── Rehab ─────────────────────────────────────────────────────────────────
    SeedResource(
        name="Beit T'Shuvah Residential Recovery",
        description=(
            "Long-term residential addiction treatment integrating the 12-step "
            "model with Jewish spirituality and psychotherapy. Accepts all faiths. "
            "Offers 30-, 60-, and 90-day programs as well as intensive outpatient. "
            "Family therapy included. Sliding-scale fees; Medi-Cal accepted."
        ),
        category="rehab",
        phone="(310) 555-0148",
        url="https://beittshuvah.org",
        address="8831 Venice Blvd, Los Angeles, CA 90034",
        zip_code="90034",
        latitude=34.0159,
        longitude=-118.3908,
        hours="Mon–Fri 9 AM–5 PM (admissions); residential 24/7",
        eligibility="Adults 18+ with substance use disorder. Sliding-scale; Medi-Cal and insurance accepted.",
        languages=["English", "Spanish"],
    ),
    SeedResource(
        name="Watts Healthcare — SUD Outpatient Program",
        description=(
            "Federally Qualified Health Center (FQHC) providing outpatient substance "
            "use disorder (SUD) treatment integrated with primary care. MAT (Medication-"
            "Assisted Treatment) including buprenorphine and naltrexone. No waiting list "
            "for Medi-Cal patients. Transportation vouchers available."
        ),
        category="rehab",
        phone="(323) 555-0166",
        address="10300 Compton Ave, Los Angeles, CA 90002",
        zip_code="90002",
        latitude=33.9434,
        longitude=-118.2478,
        hours="Mon–Fri 8 AM–5 PM; MAT walk-in Wed 8–10 AM",
        eligibility="Medi-Cal preferred; sliding-scale for uninsured.",
        languages=["English", "Spanish"],
    ),
    # ── Healthcare ────────────────────────────────────────────────────────────
    SeedResource(
        name="LA County + USC Medical Center — Community Clinic",
        description=(
            "Public hospital outpatient clinic serving uninsured and underinsured "
            "patients in the greater East LA area. Comprehensive primary care, OB/GYN, "
            "pediatrics, and chronic disease management. Medi-Cal and My Health LA "
            "accepted. Same-day appointments available via walk-in triage."
        ),
        category="healthcare",
        phone="(323) 409-5000",
        url="https://dhs.lacounty.gov/lacusc",
        address="2051 Marengo St, Los Angeles, CA 90033",
        zip_code="90033",
        latitude=34.0586,
        longitude=-118.2096,
        hours="Mon–Fri 7 AM–5 PM; ER 24/7",
        eligibility="All patients; income-based sliding scale for uninsured.",
        languages=["English", "Spanish", "Mandarin", "Korean", "Vietnamese"],
    ),
    SeedResource(
        name="AltaMed Health Services — Watts Clinic",
        description=(
            "FQHC providing comprehensive primary care, dental, behavioral health, "
            "and women's health services. Medi-Cal enrollment assistance on-site. "
            "Sliding-scale fees for uninsured. Pediatric immunizations available "
            "walk-in. PACE program for seniors 55+."
        ),
        category="healthcare",
        phone="(323) 555-0122",
        url="https://altamed.org",
        address="10000 Compton Ave, Los Angeles, CA 90002",
        zip_code="90002",
        latitude=33.9440,
        longitude=-118.2488,
        hours="Mon–Fri 8 AM–5 PM, Sat 9 AM–1 PM",
        eligibility="Open to all; Medi-Cal, Medicare, most insurance, and sliding-scale uninsured.",
        languages=["English", "Spanish"],
    ),
    # ── Legal ─────────────────────────────────────────────────────────────────
    SeedResource(
        name="Inner City Law Center",
        description=(
            "Free civil legal aid for homeless individuals and families in Los Angeles. "
            "Specializes in housing stability (eviction defense, habitability), "
            "benefits advocacy (SSI/SSDI, MediCal, CalFresh), and expungements. "
            "Walk-in clinic at Skid Row location every Monday and Wednesday."
        ),
        category="legal",
        phone="(213) 891-2880",
        url="https://innercitylaw.org",
        address="1309 E 7th St, Los Angeles, CA 90021",
        zip_code="90021",
        latitude=34.0362,
        longitude=-118.2360,
        hours="Mon/Wed 9 AM–12 PM (walk-in); by appointment other days",
        eligibility="Homeless or at-risk of homelessness in LA County. Income verified at intake.",
        languages=["English", "Spanish"],
    ),
    SeedResource(
        name="Bet Tzedek Legal Services",
        description=(
            "Free and low-cost legal services for people in need across LA County. "
            "Focus areas: consumer debt, elder law, housing, employment, and "
            "immigration (DACA, TPS). Phone helpline available for intake screening. "
            "In-person clinics in West Adams and Hollywood offices."
        ),
        category="legal",
        phone="(323) 939-0506",
        url="https://bettzedek.org",
        address="3250 Wilshire Blvd, Los Angeles, CA 90010",
        zip_code="90010",
        latitude=34.0605,
        longitude=-118.3098,
        hours="Mon–Fri 9 AM–5 PM; helpline Mon–Thu 10 AM–3 PM",
        eligibility="Low-income LA County residents; income limits apply per program area.",
        languages=["English", "Spanish", "Korean", "Farsi", "Armenian"],
    ),
    # ── Transportation ────────────────────────────────────────────────────────
    SeedResource(
        name="LA Metro Access Services — Paratransit",
        description=(
            "Shared-ride paratransit service for individuals with disabilities who "
            "cannot use the fixed-route Metro bus or rail system. ADA-certified. "
            "Door-to-door service throughout LA County. Requires prior eligibility "
            "determination (application takes 21 days). CHWs can assist with the "
            "application process."
        ),
        category="transportation",
        phone="(800) 827-0829",
        url="https://accessla.org",
        hours="Service hours: 24/7. Scheduling office: Mon–Fri 8 AM–5 PM",
        eligibility="ADA-certified disability that prevents use of fixed-route transit. Application required.",
        languages=["English", "Spanish", "Multiple (TDD available)"],
    ),
    # ── Other ─────────────────────────────────────────────────────────────────
    SeedResource(
        name="211 LA — 24/7 Social Services Helpline",
        description=(
            "Comprehensive social services referral hotline for Los Angeles County. "
            "Call or text 211 to connect with trained specialists who can refer to "
            "food, housing, mental health, utility assistance, childcare, re-entry "
            "support, and more. Online resource database searchable at 211la.org."
        ),
        category="other",
        phone="211",
        url="https://211la.org",
        hours="24/7, 365 days a year",
        eligibility="Any LA County resident.",
        languages=["English", "Spanish", "over 140 languages via interpreter"],
    ),
]


# ─── Runner ────────────────────────────────────────────────────────────────────


async def seed(db: AsyncSession) -> None:
    """Insert seed resources, skipping any that already exist by name."""
    inserted = 0
    skipped = 0

    for seed_item in SEED_RESOURCES:
        existing_result = await db.execute(
            select(Resource).where(Resource.name == seed_item.name)
        )
        if existing_result.scalar_one_or_none() is not None:
            logger.info("SKIP (exists): %s", seed_item.name)
            skipped += 1
            continue

        resource = Resource(
            name=seed_item.name,
            description=seed_item.description,
            category=seed_item.category,
            phone=seed_item.phone,
            url=seed_item.url,
            address=seed_item.address,
            zip_code=seed_item.zip_code,
            latitude=seed_item.latitude,
            longitude=seed_item.longitude,
            hours=seed_item.hours,
            eligibility=seed_item.eligibility,
            languages=seed_item.languages,
            status="active",
        )
        db.add(resource)
        logger.info("INSERT: %s [%s]", seed_item.name, seed_item.category)
        inserted += 1

    await db.commit()
    logger.info(
        "Seed complete: %d inserted, %d skipped (already existed)", inserted, skipped
    )


async def main() -> None:
    engine = create_async_engine(settings.database_url, echo=False)
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as db:
        await seed(db)
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
