"""Pre-launch seed cleanup script.

Wipes all [SEED]-tagged demo rows from the database before the May 18 public
launch. Idempotent — safe to run multiple times.

Cascade deletion order (matches FK constraints):
  1. communication_sessions  (FK → sessions)
  2. session_transcripts     (FK → sessions, ON DELETE CASCADE so auto-removed,
                              but we delete explicitly for clarity + counting)
  3. session_followups       (FK → sessions, ON DELETE CASCADE likewise)
  4. billing_claims          (FK → sessions)
  5. sessions                (FK → service_requests)
  6. service_requests        (seed-tagged only)
  7. demo_users              (emails ending in *.demo@compasschw.com ONLY)

Founder accounts (akram@, jemal@, jt@ joincompasschw.com):
  - User row and profile rows are preserved
  - Sessions and claims they OWN are deleted (those were demo data)
  - [SEED]-tagged ServiceRequests matched to them are cleared

Usage:
    docker exec -w /code compass-api python -m scripts.cleanup_seed_data [--dry-run]

Flags:
    --dry-run   Print what WOULD be deleted without committing any changes.

HIPAA: This script never logs PHI (no session notes, transcript text,
medi_cal_id, or diagnosis codes). Row counts only.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models.billing import BillingClaim
from app.models.communication import CommunicationSession
from app.models.followup import SessionFollowup
from app.models.request import ServiceRequest
from app.models.session import Session, SessionTranscript
from app.models.user import CHWProfile, MemberProfile, User

logger = logging.getLogger("compass.cleanup_seed")

# ─── Constants ────────────────────────────────────────────────────────────────

SEED_REQ_MARKER: str = "[SEED]"
SEED_SESSION_MARKER: str = "[SEED]"

# Demo user email suffix — only these are deleted. Founder emails are excluded.
DEMO_EMAIL_SUFFIX: str = ".demo@compasschw.com"

# Founder emails that must NEVER be deleted, regardless of what they own.
FOUNDER_EMAILS: frozenset[str] = frozenset(
    {
        "akram@joincompasschw.com",
        "jemal@joincompasschw.com",
        "jt@joincompasschw.com",
    }
)


# ─── Summary accumulator ──────────────────────────────────────────────────────


class CleanupSummary:
    """Tracks row counts deleted (or would-be-deleted in dry-run)."""

    def __init__(self) -> None:
        self.communication_sessions: int = 0
        self.session_transcripts: int = 0
        self.session_followups: int = 0
        self.claims: int = 0
        self.sessions: int = 0
        self.requests: int = 0
        self.demo_users: int = 0

    @property
    def total(self) -> int:
        return (
            self.communication_sessions
            + self.session_transcripts
            + self.session_followups
            + self.claims
            + self.sessions
            + self.requests
            + self.demo_users
        )

    def print(self, dry_run: bool) -> None:
        prefix = "[DRY-RUN] Would clean" if dry_run else "Cleaned"
        print(
            f"{prefix} {self.total} rows: "
            f"comm_sessions={self.communication_sessions} "
            f"transcripts={self.session_transcripts} "
            f"followups={self.session_followups} "
            f"claims={self.claims} "
            f"sessions={self.sessions} "
            f"requests={self.requests} "
            f"demo_users={self.demo_users}"
        )


# ─── Helpers to build session ID sets ─────────────────────────────────────────


async def _collect_seed_session_ids(db: AsyncSession) -> list:
    """Return the set of session UUIDs to wipe.

    Includes:
    - Sessions whose notes start with SEED_SESSION_MARKER
    - Sessions whose request_id is a [SEED]-tagged ServiceRequest
    """
    seeded_req_ids_subq = select(ServiceRequest.id).where(
        ServiceRequest.description.like(f"{SEED_REQ_MARKER}%")
    )
    result = await db.execute(
        select(Session.id).where(
            Session.notes.like(f"{SEED_SESSION_MARKER}%")
            | Session.request_id.in_(seeded_req_ids_subq)
        )
    )
    return [row[0] for row in result.all()]


async def _collect_founder_session_ids(db: AsyncSession) -> list:
    """Return session UUIDs owned by founders (chw_id OR member_id is a founder).

    These sessions were demo data seeded for walkthroughs and should be wiped
    even though the founder user row itself is preserved.
    """
    founder_result = await db.execute(
        select(User.id).where(User.email.in_(FOUNDER_EMAILS))
    )
    founder_ids = [row[0] for row in founder_result.all()]
    if not founder_ids:
        return []

    result = await db.execute(
        select(Session.id).where(
            Session.chw_id.in_(founder_ids) | Session.member_id.in_(founder_ids)
        )
    )
    return [row[0] for row in result.all()]


async def _collect_demo_user_ids(db: AsyncSession) -> list:
    """Return user IDs whose email ends with DEMO_EMAIL_SUFFIX.

    Never includes founder accounts — they are explicitly filtered out as a
    second safety check even if DEMO_EMAIL_SUFFIX somehow matched them.
    """
    result = await db.execute(
        select(User.id, User.email).where(
            User.email.like(f"%{DEMO_EMAIL_SUFFIX}")
        )
    )
    rows = result.all()
    # Explicit founder safety guard: skip any row whose email is a founder email.
    return [row[0] for row in rows if row[1] not in FOUNDER_EMAILS]


# ─── Count helpers (used in dry-run) ──────────────────────────────────────────


async def _count_comm_sessions(db: AsyncSession, session_ids: list) -> int:
    if not session_ids:
        return 0
    result = await db.execute(
        select(func.count(CommunicationSession.id)).where(
            CommunicationSession.session_id.in_(session_ids)
        )
    )
    return result.scalar_one() or 0


async def _count_session_transcripts(db: AsyncSession, session_ids: list) -> int:
    if not session_ids:
        return 0
    result = await db.execute(
        select(func.count(SessionTranscript.id)).where(
            SessionTranscript.session_id.in_(session_ids)
        )
    )
    return result.scalar_one() or 0


async def _count_session_followups(db: AsyncSession, session_ids: list) -> int:
    if not session_ids:
        return 0
    result = await db.execute(
        select(func.count(SessionFollowup.id)).where(
            SessionFollowup.session_id.in_(session_ids)
        )
    )
    return result.scalar_one() or 0


async def _count_billing_claims(db: AsyncSession, session_ids: list) -> int:
    if not session_ids:
        return 0
    result = await db.execute(
        select(func.count(BillingClaim.id)).where(
            BillingClaim.session_id.in_(session_ids)
        )
    )
    return result.scalar_one() or 0


async def _count_seed_requests(db: AsyncSession) -> int:
    result = await db.execute(
        select(func.count(ServiceRequest.id)).where(
            ServiceRequest.description.like(f"{SEED_REQ_MARKER}%")
        )
    )
    return result.scalar_one() or 0


async def _count_demo_users(db: AsyncSession, demo_user_ids: list) -> int:
    return len(demo_user_ids)


# ─── Main cleanup logic ────────────────────────────────────────────────────────


async def run_cleanup(dry_run: bool) -> CleanupSummary:
    """Execute (or simulate) the full seed cleanup. Returns populated summary."""
    summary = CleanupSummary()

    async with async_session() as db:
        # ── 1. Determine which session IDs to wipe ────────────────────────────
        seed_session_ids = await _collect_seed_session_ids(db)
        founder_session_ids = await _collect_founder_session_ids(db)

        # Union: wipe sessions from both pools.
        all_session_ids = list(set(seed_session_ids) | set(founder_session_ids))

        logger.info(
            "Session IDs to wipe: %d (%d seed-tagged, %d founder-owned)",
            len(all_session_ids),
            len(seed_session_ids),
            len(founder_session_ids),
        )

        # ── 2. Demo user IDs ──────────────────────────────────────────────────
        demo_user_ids = await _collect_demo_user_ids(db)
        logger.info("Demo user IDs to delete: %d", len(demo_user_ids))

        if dry_run:
            # Count what would be deleted and return without committing.
            summary.communication_sessions = await _count_comm_sessions(db, all_session_ids)
            summary.session_transcripts = await _count_session_transcripts(db, all_session_ids)
            summary.session_followups = await _count_session_followups(db, all_session_ids)
            summary.claims = await _count_billing_claims(db, all_session_ids)
            summary.sessions = len(all_session_ids)
            summary.requests = await _count_seed_requests(db)
            summary.demo_users = await _count_demo_users(db, demo_user_ids)
            return summary

        # ── 3. Live deletion — respect FK order ───────────────────────────────

        # 3a. communication_sessions (FK → sessions)
        if all_session_ids:
            result = await db.execute(
                delete(CommunicationSession).where(
                    CommunicationSession.session_id.in_(all_session_ids)
                )
            )
            summary.communication_sessions = result.rowcount or 0
            logger.info("Deleted %d communication_sessions", summary.communication_sessions)

        # 3b. session_transcripts (FK → sessions, ON DELETE CASCADE, but explicit for count)
        if all_session_ids:
            result = await db.execute(
                delete(SessionTranscript).where(
                    SessionTranscript.session_id.in_(all_session_ids)
                )
            )
            summary.session_transcripts = result.rowcount or 0
            logger.info("Deleted %d session_transcripts", summary.session_transcripts)

        # 3c. session_followups (FK → sessions, ON DELETE CASCADE, but explicit for count)
        if all_session_ids:
            result = await db.execute(
                delete(SessionFollowup).where(
                    SessionFollowup.session_id.in_(all_session_ids)
                )
            )
            summary.session_followups = result.rowcount or 0
            logger.info("Deleted %d session_followups", summary.session_followups)

        # 3d. billing_claims (FK → sessions)
        if all_session_ids:
            result = await db.execute(
                delete(BillingClaim).where(
                    BillingClaim.session_id.in_(all_session_ids)
                )
            )
            summary.claims = result.rowcount or 0
            logger.info("Deleted %d billing_claims", summary.claims)

        # 3e. sessions themselves
        if all_session_ids:
            result = await db.execute(
                delete(Session).where(Session.id.in_(all_session_ids))
            )
            summary.sessions = result.rowcount or 0
            logger.info("Deleted %d sessions", summary.sessions)

        # 3f. [SEED]-tagged service_requests (some may no longer have sessions
        #     pointing at them; delete the ones that remain)
        result = await db.execute(
            delete(ServiceRequest).where(
                ServiceRequest.description.like(f"{SEED_REQ_MARKER}%")
            )
        )
        summary.requests = result.rowcount or 0
        logger.info("Deleted %d service_requests", summary.requests)

        # 3g. Demo user rows + their profiles.
        #     CHWProfile and MemberProfile have FKs to users but no ON DELETE CASCADE
        #     in the schema, so delete profiles first.
        if demo_user_ids:
            await db.execute(
                delete(CHWProfile).where(CHWProfile.user_id.in_(demo_user_ids))
            )
            await db.execute(
                delete(MemberProfile).where(MemberProfile.user_id.in_(demo_user_ids))
            )
            result = await db.execute(
                delete(User).where(User.id.in_(demo_user_ids))
            )
            summary.demo_users = result.rowcount or 0
            logger.info("Deleted %d demo users (+ their profiles)", summary.demo_users)

        await db.commit()

    return summary


# ─── CLI ──────────────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cleanup_seed_data",
        description=(
            "Wipe all [SEED]-tagged demo rows from the database. "
            "Idempotent — safe to run multiple times. "
            "Founder accounts (akram@, jemal@, jt@) are never deleted."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what WOULD be deleted without committing any changes.",
    )
    return parser


async def _main(dry_run: bool) -> int:
    if dry_run:
        print("[DRY-RUN MODE] No changes will be committed.\n")

    try:
        summary = await run_cleanup(dry_run=dry_run)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    summary.print(dry_run=dry_run)

    if not dry_run and summary.total == 0:
        print("(Nothing to clean — database was already clean.)")

    return 0


def main() -> int:
    args = _build_parser().parse_args()
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
    return asyncio.run(_main(dry_run=args.dry_run))


if __name__ == "__main__":
    sys.exit(main())
