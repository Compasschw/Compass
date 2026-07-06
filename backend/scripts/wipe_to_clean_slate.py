"""Clean-slate database wipe for Compass production launch.

PURPOSE
-------
Resets the database to a state suitable for real-member launch by deleting all
transactional / PHI rows while preserving three founder accounts and all
product-configuration data.

WHAT IS PRESERVED
-----------------
1. Founder user rows (login + profile) for:
     akram@joincompasschw.com
     jt@joincompasschw.com
     jemal@joincompasschw.com
   Note: akram@ may not yet exist — the script silently skips missing accounts.

2. Product-configuration / reference tables (rows untouched):
     alembic_version          — migration state; must never be wiped
     journey_templates        — care-pathway definitions
     journey_template_steps   — steps within templates
     institution_registry     — accredited institution reference data
     redemption_items         — (legacy) reward catalog items (read-only config)
     reward_catalog_items     — current reward catalog
     pear_suite_template_map  — CPT-code → Pear activity template mapping
     resources                — admin-curated community resource catalog
     admin_totp_secrets       — admin TOTP credential for the admin console

3. System / infrastructure tables (not application data):
     waitlist_entries         — pre-launch marketing signups; no FK deps on users

WHAT IS DELETED (FK-safe order — children before parents)
---------------------------------------------------------
TIER 1 — deepest children (no outbound FKs to transactional tables):
  member_assessment_responses  (FK → member_assessments)
  member_journey_step_states   (FK → member_journeys, journey_template_steps)
  file_attachments             (FK → messages)

TIER 2 — second-level children:
  communication_touches        (FK → users; append-only log; fully wiped)
  communication_sessions       (FK → sessions)
  session_transcripts          (FK → sessions, users)
  session_documentation        (FK → sessions)
  consent_requests             (FK → sessions, users)
  member_consents              (FK → sessions, users)
  session_followups            (FK → sessions, users)
  billing_claims               (FK → sessions, users)
  call_logs                    (FK → conversations)
  case_notes                   (FK → sessions, users)
  testimonials                 (FK → sessions, users)
  member_assessments           (FK → sessions, users)
  member_documents             (FK → users)
  flag_notes                   (FK → users)
  calendar_events              (FK → sessions, users)
  twilio_proxy_sessions        (FK → users)
  resource_suggestions         (FK → users)
  reward_transactions          (FK → users)
  reward_redemptions           (FK → users, reward_catalog_items)
  wellness_points_ledger       (FK → users)
  audit_log                    (FK → users; wiped in full)
  refresh_tokens               (FK → users)
  magic_link_tokens            (FK → users)
  device_tokens                (FK → users)
  phone_verifications          (FK → users, ON DELETE CASCADE)

TIER 3 — messages (FK → conversations + users):
  messages (nulling read cursors on conversations first — see below)

TIER 4 — conversation-level:
  conversations  (FK → sessions via conversations.session_id;
                  read cursors hold FK to messages — nulled before messages deleted)

TIER 5 — sessions / requests:
  sessions          (FK → service_requests, users, conversations)
  service_requests  (FK → users)

TIER 6 — profiles for non-founder users:
  chw_intake_responses     (FK → users)
  credentials              (FK → users)
  chw_credential_validations (FK → users, institution_registry)
  member_journeys          (FK → users, journey_templates)
  chw_profiles             (FK → users)  — only non-founder rows
  member_profiles          (FK → users)  — only non-founder rows

TIER 7 — user rows not in KEEP_EMAILS (including soft-deleted tombstones)

HIPAA
-----
This script NEVER logs PHI.  Only table names, row counts, user IDs (UUIDs),
and the redacted DB host are printed.  No session notes, transcript text,
medi_cal_id, DOB, case-note body, or flag-note body are accessed or printed.

USAGE
-----
Dry-run (prints what WOULD be deleted, commits nothing):
    docker exec -w /code backend-api-1 python -m scripts.wipe_to_clean_slate --dry-run

Apply (executes inside a single transaction; rolls back on any error):
    docker exec -w /code backend-api-1 python -m scripts.wipe_to_clean_slate --apply

One of --dry-run or --apply is required.

ACCOUNTABILITY CHECK
--------------------
At startup the script prints which DB host it will operate against (password
redacted) and the 3 keep-email addresses so the operator can visually confirm
before proceeding.

SAFETY INVARIANT
----------------
At runtime the script queries the information_schema for every table in the
public schema and asserts every one is in exactly one of:
  WIPE_ENTIRELY, DELETE_NON_KEPT_PROFILES, PRESERVE, SKIP_INFRA
If an unknown table appears (e.g. from a new migration), the script aborts
loudly so no data is silently skipped.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from collections.abc import Sequence
from urllib.parse import urlparse

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.engine import CursorResult
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models.assessment import MemberAssessment, MemberAssessmentResponse
from app.models.audit import AuditLog
from app.models.auth import RefreshToken
from app.models.billing import BillingClaim
from app.models.calendar import CalendarEvent
from app.models.case_note import CaseNote
from app.models.chw_intake import CHWIntakeResponse
from app.models.communication import CommunicationSession
from app.models.conversation import CallLog, Conversation, FileAttachment, Message
from app.models.credential import CHWCredentialValidation, Credential
from app.models.device import DeviceToken
from app.models.flag_note import FlagNote
from app.models.followup import SessionFollowup
from app.models.journeys import MemberJourney, MemberJourneyStepState, WellnessPointsLedger
from app.models.magic_link import MagicLinkToken
from app.models.member_document import MemberDocument
from app.models.phone_verification import PhoneVerification
from app.models.request import ServiceRequest
from app.models.resource import ResourceSuggestion
from app.models.reward import RewardTransaction
from app.models.rewards import RewardRedemption
from app.models.session import ConsentRequest, MemberConsent, Session, SessionDocumentation, SessionTranscript
from app.models.testimonial import Testimonial
from app.models.twilio import TwilioProxySession
from app.models.user import CHWProfile, MemberProfile, User
from app.services.communication_touch_log import CommunicationTouch

logger = logging.getLogger("compass.wipe_to_clean_slate")


# ─── Typed delete helper ──────────────────────────────────────────────────────


async def _exec_delete(db: AsyncSession, stmt: object) -> int:
    """Execute a DELETE statement and return the number of rows deleted.

    SQLAlchemy's async ``execute`` returns ``CursorResult`` for DML, which
    carries ``rowcount``.  We cast explicitly so mypy is satisfied without
    silencing the type checker globally.
    """
    result: CursorResult = await db.execute(stmt)  # type: ignore[arg-type, assignment, call-overload]
    return result.rowcount or 0


# ─── Founder accounts — these user rows + profiles are PRESERVED ──────────────

_DEFAULT_KEEP_EMAILS: frozenset[str] = frozenset(
    {
        "akram@joincompasschw.com",
        "jt@joincompasschw.com",
        "jemal@joincompasschw.com",
    }
)

# Optional one-off override via env var (comma-separated emails), e.g. to delete
# specific founder/test accounts for a fresh end-to-end test:
#   WIPE_KEEP_EMAILS=akram@joincompasschw.com  → keeps ONLY akram, deletes the
#   rest (jemal@ + jt@ + all their data). Emails are lower-cased + trimmed.
# When unset, the default founder set is preserved (no behaviour change).
def _resolve_keep_emails() -> frozenset[str]:
    import os

    raw = os.environ.get("WIPE_KEEP_EMAILS")
    if not raw or not raw.strip():
        return _DEFAULT_KEEP_EMAILS
    return frozenset(e.strip().lower() for e in raw.split(",") if e.strip())


KEEP_EMAILS: frozenset[str] = _resolve_keep_emails()

# ─── Table classification for the completeness assertion ──────────────────────
#
# Every table in the `public` schema must appear in exactly ONE of these sets.
# The script aborts on any unclassified table to prevent silent data leakage.

# Wiped entirely (all rows deleted regardless of user association).
WIPE_ENTIRELY: frozenset[str] = frozenset(
    {
        # Tier 1 — deepest children
        "member_assessment_responses",
        "member_journey_step_states",
        "file_attachments",
        # Tier 2 — second-level children
        "communication_touches",
        "communication_sessions",
        "session_transcripts",
        "session_documentation",
        "consent_requests",
        "member_consents",
        "session_followups",
        "billing_claims",
        "call_logs",
        "case_notes",
        "testimonials",
        "member_assessments",
        "member_documents",
        "flag_notes",
        "calendar_events",
        "twilio_proxy_sessions",
        "resource_suggestions",
        "reward_transactions",
        "reward_redemptions",
        "wellness_points_ledger",
        "audit_log",
        "refresh_tokens",
        "magic_link_tokens",
        "device_tokens",
        "phone_verifications",
        # Tier 3/4
        "messages",
        "conversations",
        # Tier 5
        "sessions",
        "service_requests",
        # Tier 6 — profile/credential tables for non-founders
        # (note: chw_profiles + member_profiles appear in DELETE_NON_KEPT_PROFILES
        #  because founder rows must survive; the others below are fully wiped)
        "chw_intake_responses",
        "credentials",
        "chw_credential_validations",
        "member_journeys",
    }
)

# Only non-founder profile rows are deleted; founder rows survive.
DELETE_NON_KEPT_PROFILES: frozenset[str] = frozenset(
    {
        "chw_profiles",
        "member_profiles",
        "users",
    }
)

# Fully preserved — zero rows touched.
PRESERVE: frozenset[str] = frozenset(
    {
        "alembic_version",
        "journey_templates",
        "journey_template_steps",
        "institution_registry",
        "redemption_items",
        "reward_catalog_items",
        "pear_suite_template_map",
        "resources",
        "admin_totp_secrets",
        "waitlist_entries",
    }
)

# Infrastructure / marketing tables not directly linked to PHI user data.
# (Currently empty: waitlist_entries is preserved as real launch leads.)
SKIP_INFRA: frozenset[str] = frozenset()

ALL_KNOWN_TABLES: frozenset[str] = (
    WIPE_ENTIRELY | DELETE_NON_KEPT_PROFILES | PRESERVE | SKIP_INFRA
)


# ─── Summary ──────────────────────────────────────────────────────────────────


class TableCount:
    """Holds the before-count and deleted-count for one table."""

    __slots__ = ("table", "total_rows", "deleted")

    def __init__(self, table: str, total_rows: int, deleted: int = 0) -> None:
        self.table = table
        self.total_rows = total_rows
        self.deleted = deleted


class WipeSummary:
    """Accumulates per-table row counts for the final report."""

    def __init__(self) -> None:
        self._counts: list[TableCount] = []

    def record(self, table: str, total_rows: int, deleted: int) -> None:
        self._counts.append(TableCount(table, total_rows, deleted))

    @property
    def total_deleted(self) -> int:
        return sum(c.deleted for c in self._counts)

    @property
    def total_preserved(self) -> int:
        return sum(c.total_rows - c.deleted for c in self._counts)

    def print_report(self, *, dry_run: bool) -> None:
        """Print the per-table report.  Never prints cell values — only counts."""
        mode = "DRY-RUN — would delete" if dry_run else "APPLIED — deleted"
        print(f"\n{'=' * 64}")
        print(f"  Compass Clean-Slate Wipe Report ({mode})")
        print(f"{'=' * 64}")
        print(f"  {'Table':<40} {'Rows':>8}  {'Deleted':>8}")
        print(f"  {'-' * 40}  {'-' * 8}  {'-' * 8}")
        for c in sorted(self._counts, key=lambda x: x.table):
            print(f"  {c.table:<40} {c.total_rows:>8}  {c.deleted:>8}")
        print(f"  {'-' * 40}  {'-' * 8}  {'-' * 8}")
        print(f"  {'TOTAL':<40} {'':>8}  {self.total_deleted:>8}")
        print(f"{'=' * 64}\n")


# ─── Safety helpers ───────────────────────────────────────────────────────────


async def _assert_all_tables_classified(db: AsyncSession) -> None:
    """Query information_schema and abort if any table is unaccounted for.

    This guard ensures that new tables added by future migrations are not
    silently skipped during a wipe — the operator must explicitly classify them.
    """
    result = await db.execute(
        text(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
        )
    )
    db_tables: set[str] = {row[0] for row in result.all()}
    unknown = db_tables - ALL_KNOWN_TABLES
    if unknown:
        logger.error(
            "ABORT: unclassified table(s) found in the database: %s. "
            "Add them to one of the classification sets in this script before proceeding.",
            sorted(unknown),
        )
        raise RuntimeError(
            f"Unclassified table(s): {sorted(unknown)}. "
            "Classify each table in WIPE_ENTIRELY, DELETE_NON_KEPT_PROFILES, "
            "PRESERVE, or SKIP_INFRA before running --apply."
        )
    logger.info(
        "Table classification check passed: %d DB tables, all accounted for.",
        len(db_tables),
    )


async def _resolve_keep_user_ids(db: AsyncSession) -> list:
    """Return the list of user UUIDs whose accounts must be preserved.

    If a keep-email does not exist in the DB (e.g. akram@ not yet created)
    it is silently skipped — this is expected and not an error.

    Returns:
        A list of UUID values (may be shorter than KEEP_EMAILS if some are absent).
    """
    result = await db.execute(
        select(User.id, User.email).where(User.email.in_(KEEP_EMAILS))
    )
    rows = result.all()
    found_emails = {row[1] for row in rows}
    missing = KEEP_EMAILS - found_emails
    if missing:
        logger.info(
            "Keep-email(s) not found in DB (will be skipped): %s", sorted(missing)
        )
    return [row[0] for row in rows]


async def _count_table(db: AsyncSession, table_name: str) -> int:
    """Return the current row count for a table by name."""
    result = await db.execute(text(f"SELECT COUNT(*) FROM {table_name}"))  # noqa: S608
    return result.scalar_one() or 0


# ─── Per-table count helpers (dry-run) ───────────────────────────────────────


async def _count_non_keeper_profiles(
    db: AsyncSession,
    model: type,
    keep_user_ids: Sequence,
) -> int:
    """Count rows in a profile table whose user_id is NOT a keeper."""
    col = model.user_id  # type: ignore[attr-defined]
    if keep_user_ids:
        result = await db.execute(
            select(func.count()).where(col.notin_(keep_user_ids))
        )
    else:
        result = await db.execute(select(func.count()))
    return result.scalar_one() or 0


async def _count_non_keeper_users(
    db: AsyncSession, keep_user_ids: Sequence
) -> int:
    """Count User rows that are NOT in the keeper set."""
    if keep_user_ids:
        result = await db.execute(
            select(func.count(User.id)).where(User.id.notin_(keep_user_ids))
        )
    else:
        result = await db.execute(select(func.count(User.id)))
    return result.scalar_one() or 0


# ─── Main wipe logic ─────────────────────────────────────────────────────────


async def run_wipe(*, dry_run: bool) -> WipeSummary:
    """Execute (or simulate) the full clean-slate wipe.

    All deletions run inside a single transaction.  On any error the
    transaction is rolled back in full — no partial state is committed.

    Args:
        dry_run: When True, counts are computed and printed but the
                 transaction is rolled back unconditionally before return.

    Returns:
        A WipeSummary with per-table counts.

    Raises:
        RuntimeError: If the table classification check fails (unknown table).
        Exception:    Any DB error — the transaction is rolled back first.
    """
    summary = WipeSummary()

    async with async_session() as db:
        # ── Safety: assert every table is classified before touching anything ──
        await _assert_all_tables_classified(db)

        # ── Resolve the keep-user IDs ─────────────────────────────────────────
        keep_user_ids = await _resolve_keep_user_ids(db)
        print(f"\nKeep-email accounts resolved: {len(keep_user_ids)} user ID(s)")
        for uid in keep_user_ids:
            # Safe to print UUID — not PHI
            print(f"  preserved user id: {uid}")

        # ────────────────────────────────────────────────────────────────────────
        # TIER 1 — Deepest children (no outbound FKs to other transactional tables)
        # ────────────────────────────────────────────────────────────────────────

        # member_assessment_responses (FK → member_assessments)
        total = await _count_table(db, "member_assessment_responses")
        deleted = total if dry_run else await _exec_delete(db, delete(MemberAssessmentResponse))
        summary.record("member_assessment_responses", total, deleted)
        logger.info("member_assessment_responses: total=%d deleted=%d", total, deleted)

        # member_journey_step_states (FK → member_journeys, journey_template_steps)
        total = await _count_table(db, "member_journey_step_states")
        deleted = total if dry_run else await _exec_delete(db, delete(MemberJourneyStepState))
        summary.record("member_journey_step_states", total, deleted)
        logger.info("member_journey_step_states: total=%d deleted=%d", total, deleted)

        # file_attachments (FK → messages)
        total = await _count_table(db, "file_attachments")
        deleted = total if dry_run else await _exec_delete(db, delete(FileAttachment))
        summary.record("file_attachments", total, deleted)
        logger.info("file_attachments: total=%d deleted=%d", total, deleted)

        # ────────────────────────────────────────────────────────────────────────
        # TIER 2 — Second-level children
        # ────────────────────────────────────────────────────────────────────────

        # communication_touches (FK → users; append-only compliance log)
        total = await _count_table(db, "communication_touches")
        deleted = total if dry_run else await _exec_delete(db, delete(CommunicationTouch))
        summary.record("communication_touches", total, deleted)
        logger.info("communication_touches: total=%d deleted=%d", total, deleted)

        # communication_sessions (FK → sessions)
        total = await _count_table(db, "communication_sessions")
        deleted = total if dry_run else await _exec_delete(db, delete(CommunicationSession))
        summary.record("communication_sessions", total, deleted)
        logger.info("communication_sessions: total=%d deleted=%d", total, deleted)

        # session_transcripts (FK → sessions, users)
        total = await _count_table(db, "session_transcripts")
        deleted = total if dry_run else await _exec_delete(db, delete(SessionTranscript))
        summary.record("session_transcripts", total, deleted)
        logger.info("session_transcripts: total=%d deleted=%d", total, deleted)

        # session_documentation (FK → sessions)
        total = await _count_table(db, "session_documentation")
        deleted = total if dry_run else await _exec_delete(db, delete(SessionDocumentation))
        summary.record("session_documentation", total, deleted)
        logger.info("session_documentation: total=%d deleted=%d", total, deleted)

        # consent_requests (FK → sessions, users; ON DELETE CASCADE from sessions
        # but we delete explicitly for an accurate count)
        total = await _count_table(db, "consent_requests")
        deleted = total if dry_run else await _exec_delete(db, delete(ConsentRequest))
        summary.record("consent_requests", total, deleted)
        logger.info("consent_requests: total=%d deleted=%d", total, deleted)

        # member_consents (FK → sessions, users)
        total = await _count_table(db, "member_consents")
        deleted = total if dry_run else await _exec_delete(db, delete(MemberConsent))
        summary.record("member_consents", total, deleted)
        logger.info("member_consents: total=%d deleted=%d", total, deleted)

        # session_followups (FK → sessions, users; ON DELETE CASCADE from sessions)
        total = await _count_table(db, "session_followups")
        deleted = total if dry_run else await _exec_delete(db, delete(SessionFollowup))
        summary.record("session_followups", total, deleted)
        logger.info("session_followups: total=%d deleted=%d", total, deleted)

        # billing_claims (FK → sessions, users)
        total = await _count_table(db, "billing_claims")
        deleted = total if dry_run else await _exec_delete(db, delete(BillingClaim))
        summary.record("billing_claims", total, deleted)
        logger.info("billing_claims: total=%d deleted=%d", total, deleted)

        # call_logs (FK → conversations)
        total = await _count_table(db, "call_logs")
        deleted = total if dry_run else await _exec_delete(db, delete(CallLog))
        summary.record("call_logs", total, deleted)
        logger.info("call_logs: total=%d deleted=%d", total, deleted)

        # case_notes (FK → sessions, users)
        total = await _count_table(db, "case_notes")
        deleted = total if dry_run else await _exec_delete(db, delete(CaseNote))
        summary.record("case_notes", total, deleted)
        logger.info("case_notes: total=%d deleted=%d", total, deleted)

        # testimonials (FK → sessions, users)
        total = await _count_table(db, "testimonials")
        deleted = total if dry_run else await _exec_delete(db, delete(Testimonial))
        summary.record("testimonials", total, deleted)
        logger.info("testimonials: total=%d deleted=%d", total, deleted)

        # member_assessments (FK → sessions, users)
        total = await _count_table(db, "member_assessments")
        deleted = total if dry_run else await _exec_delete(db, delete(MemberAssessment))
        summary.record("member_assessments", total, deleted)
        logger.info("member_assessments: total=%d deleted=%d", total, deleted)

        # member_documents (FK → users)
        total = await _count_table(db, "member_documents")
        deleted = total if dry_run else await _exec_delete(db, delete(MemberDocument))
        summary.record("member_documents", total, deleted)
        logger.info("member_documents: total=%d deleted=%d", total, deleted)

        # flag_notes (FK → users)
        total = await _count_table(db, "flag_notes")
        deleted = total if dry_run else await _exec_delete(db, delete(FlagNote))
        summary.record("flag_notes", total, deleted)
        logger.info("flag_notes: total=%d deleted=%d", total, deleted)

        # calendar_events (FK → sessions, users)
        total = await _count_table(db, "calendar_events")
        deleted = total if dry_run else await _exec_delete(db, delete(CalendarEvent))
        summary.record("calendar_events", total, deleted)
        logger.info("calendar_events: total=%d deleted=%d", total, deleted)

        # twilio_proxy_sessions (FK → users)
        total = await _count_table(db, "twilio_proxy_sessions")
        deleted = total if dry_run else await _exec_delete(db, delete(TwilioProxySession))
        summary.record("twilio_proxy_sessions", total, deleted)
        logger.info("twilio_proxy_sessions: total=%d deleted=%d", total, deleted)

        # resource_suggestions (FK → users)
        total = await _count_table(db, "resource_suggestions")
        deleted = total if dry_run else await _exec_delete(db, delete(ResourceSuggestion))
        summary.record("resource_suggestions", total, deleted)
        logger.info("resource_suggestions: total=%d deleted=%d", total, deleted)

        # reward_transactions (FK → users)
        total = await _count_table(db, "reward_transactions")
        deleted = total if dry_run else await _exec_delete(db, delete(RewardTransaction))
        summary.record("reward_transactions", total, deleted)
        logger.info("reward_transactions: total=%d deleted=%d", total, deleted)

        # reward_redemptions (FK → users, reward_catalog_items)
        total = await _count_table(db, "reward_redemptions")
        deleted = total if dry_run else await _exec_delete(db, delete(RewardRedemption))
        summary.record("reward_redemptions", total, deleted)
        logger.info("reward_redemptions: total=%d deleted=%d", total, deleted)

        # wellness_points_ledger (FK → users; append-only, wiped in full)
        total = await _count_table(db, "wellness_points_ledger")
        deleted = total if dry_run else await _exec_delete(db, delete(WellnessPointsLedger))
        summary.record("wellness_points_ledger", total, deleted)
        logger.info("wellness_points_ledger: total=%d deleted=%d", total, deleted)

        # audit_log (FK → users; wiped in full — fresh audit trail for real launch)
        total = await _count_table(db, "audit_log")
        deleted = total if dry_run else await _exec_delete(db, delete(AuditLog))
        summary.record("audit_log", total, deleted)
        logger.info("audit_log: total=%d deleted=%d", total, deleted)

        # refresh_tokens (FK → users)
        total = await _count_table(db, "refresh_tokens")
        deleted = total if dry_run else await _exec_delete(db, delete(RefreshToken))
        summary.record("refresh_tokens", total, deleted)
        logger.info("refresh_tokens: total=%d deleted=%d", total, deleted)

        # magic_link_tokens (FK → users)
        total = await _count_table(db, "magic_link_tokens")
        deleted = total if dry_run else await _exec_delete(db, delete(MagicLinkToken))
        summary.record("magic_link_tokens", total, deleted)
        logger.info("magic_link_tokens: total=%d deleted=%d", total, deleted)

        # device_tokens (FK → users)
        total = await _count_table(db, "device_tokens")
        deleted = total if dry_run else await _exec_delete(db, delete(DeviceToken))
        summary.record("device_tokens", total, deleted)
        logger.info("device_tokens: total=%d deleted=%d", total, deleted)

        # phone_verifications (FK → users, ON DELETE CASCADE — explicit for count)
        total = await _count_table(db, "phone_verifications")
        deleted = total if dry_run else await _exec_delete(db, delete(PhoneVerification))
        summary.record("phone_verifications", total, deleted)
        logger.info("phone_verifications: total=%d deleted=%d", total, deleted)

        # ────────────────────────────────────────────────────────────────────────
        # TIER 3 — messages
        #
        # conversations.chw_read_up_to and conversations.member_read_up_to are
        # FK references into messages.id.  We must null those cursors before
        # deleting messages to avoid a FK violation, then delete messages, then
        # delete the now-childless conversation rows in Tier 4.
        # ────────────────────────────────────────────────────────────────────────

        total = await _count_table(db, "messages")
        if not dry_run:
            # Null out the read-cursor FKs on all conversations first.
            await db.execute(
                update(Conversation).values(
                    chw_read_up_to=None, member_read_up_to=None
                )
            )
            deleted = await _exec_delete(db, delete(Message))
        else:
            deleted = total
        summary.record("messages", total, deleted)
        logger.info("messages: total=%d deleted=%d", total, deleted)

        # ────────────────────────────────────────────────────────────────────────
        # TIER 4 — conversations
        #
        # conversations and sessions form a CIRCULAR FK pair:
        #   conversations.session_id  → sessions   (nullable)
        #   sessions.conversation_id  → conversations (nullable)
        # Sessions are deleted in Tier 5 (after this), so we must first null the
        # sessions.conversation_id back-reference, otherwise deleting the
        # conversation rows here violates sessions_conversation_id_fkey.
        # ────────────────────────────────────────────────────────────────────────

        total = await _count_table(db, "conversations")
        if not dry_run:
            # Break the circular FK: null sessions' pointer into conversations.
            await db.execute(update(Session).values(conversation_id=None))
            deleted = await _exec_delete(db, delete(Conversation))
        else:
            deleted = total
        summary.record("conversations", total, deleted)
        logger.info("conversations: total=%d deleted=%d", total, deleted)

        # ────────────────────────────────────────────────────────────────────────
        # TIER 5 — sessions, then service_requests
        #
        # sessions.conversation_id FK to conversations is nullable and the
        # conversation rows are now gone, so this delete is clean.
        # service_requests has no children remaining at this point.
        # ────────────────────────────────────────────────────────────────────────

        total = await _count_table(db, "sessions")
        deleted = total if dry_run else await _exec_delete(db, delete(Session))
        summary.record("sessions", total, deleted)
        logger.info("sessions: total=%d deleted=%d", total, deleted)

        total = await _count_table(db, "service_requests")
        deleted = total if dry_run else await _exec_delete(db, delete(ServiceRequest))
        summary.record("service_requests", total, deleted)
        logger.info("service_requests: total=%d deleted=%d", total, deleted)

        # ────────────────────────────────────────────────────────────────────────
        # TIER 6 — Profile / credential tables
        #
        # member_journeys: FK to users (RESTRICT) and journey_templates (RESTRICT).
        # All MemberJourneyStepState children were deleted in Tier 1.
        # ────────────────────────────────────────────────────────────────────────

        # chw_intake_responses (FK → users; unique per user — wipe entirely)
        total = await _count_table(db, "chw_intake_responses")
        deleted = total if dry_run else await _exec_delete(db, delete(CHWIntakeResponse))
        summary.record("chw_intake_responses", total, deleted)
        logger.info("chw_intake_responses: total=%d deleted=%d", total, deleted)

        # credentials (FK → users — includes verified_by FK; wipe entirely)
        total = await _count_table(db, "credentials")
        deleted = total if dry_run else await _exec_delete(db, delete(Credential))
        summary.record("credentials", total, deleted)
        logger.info("credentials: total=%d deleted=%d", total, deleted)

        # chw_credential_validations (FK → users, institution_registry)
        total = await _count_table(db, "chw_credential_validations")
        deleted = total if dry_run else await _exec_delete(db, delete(CHWCredentialValidation))
        summary.record("chw_credential_validations", total, deleted)
        logger.info("chw_credential_validations: total=%d deleted=%d", total, deleted)

        # member_journeys (FK → users, journey_templates; RESTRICT so children
        # must be gone first — verified by Tier 1 step_states delete above)
        total = await _count_table(db, "member_journeys")
        deleted = total if dry_run else await _exec_delete(db, delete(MemberJourney))
        summary.record("member_journeys", total, deleted)
        logger.info("member_journeys: total=%d deleted=%d", total, deleted)

        # chw_profiles — delete non-keeper rows only
        total = await _count_table(db, "chw_profiles")
        if not dry_run:
            stmt_chw = (
                delete(CHWProfile).where(CHWProfile.user_id.notin_(keep_user_ids))
                if keep_user_ids
                else delete(CHWProfile)
            )
            deleted = await _exec_delete(db, stmt_chw)
        else:
            if keep_user_ids:
                cnt_result = await db.execute(
                    select(func.count(CHWProfile.id)).where(
                        CHWProfile.user_id.notin_(keep_user_ids)
                    )
                )
            else:
                cnt_result = await db.execute(select(func.count(CHWProfile.id)))
            deleted = cnt_result.scalar_one() or 0
        summary.record("chw_profiles", total, deleted)
        logger.info("chw_profiles: total=%d deleted=%d", total, deleted)

        # member_profiles — delete non-keeper rows only
        total = await _count_table(db, "member_profiles")
        if not dry_run:
            stmt_mp = (
                delete(MemberProfile).where(MemberProfile.user_id.notin_(keep_user_ids))
                if keep_user_ids
                else delete(MemberProfile)
            )
            deleted = await _exec_delete(db, stmt_mp)
        else:
            if keep_user_ids:
                cnt_result = await db.execute(
                    select(func.count(MemberProfile.id)).where(
                        MemberProfile.user_id.notin_(keep_user_ids)
                    )
                )
            else:
                cnt_result = await db.execute(select(func.count(MemberProfile.id)))
            deleted = cnt_result.scalar_one() or 0
        summary.record("member_profiles", total, deleted)
        logger.info("member_profiles: total=%d deleted=%d", total, deleted)

        # ────────────────────────────────────────────────────────────────────────
        # TIER 7 — users
        #
        # Delete all User rows not in KEEP_EMAILS, including soft-deleted
        # tombstones (deleted-*@deleted.compasschw.local).  Profile rows for
        # these accounts were already removed in Tier 6.
        # ────────────────────────────────────────────────────────────────────────

        total = await _count_table(db, "users")
        if not dry_run:
            stmt_u = (
                delete(User).where(User.id.notin_(keep_user_ids))
                if keep_user_ids
                else delete(User)
            )
            deleted = await _exec_delete(db, stmt_u)
        else:
            deleted = await _count_non_keeper_users(db, keep_user_ids)
        summary.record("users", total, deleted)
        logger.info("users: total=%d deleted=%d", total, deleted)

        # ── Finalise ─────────────────────────────────────────────────────────────

        if dry_run:
            # Explicit rollback — we made no changes, but rolling back is safer
            # than relying on the session manager when reads preceded any writes.
            await db.rollback()
            logger.info("Dry-run complete — no changes committed.")
        else:
            await db.commit()
            logger.info("Transaction committed successfully.")

    return summary


# ─── DB host printer (HIPAA-safe: redacts password) ──────────────────────────


def _print_db_host() -> None:
    """Print the DB host derived from the DATABASE_URL, with password redacted."""
    from app.config import settings  # local import to avoid circular at module level

    raw_url: str = settings.database_url
    try:
        parsed = urlparse(raw_url)
        host = parsed.hostname or "unknown"
        port = parsed.port or ""
        db_name = parsed.path.lstrip("/") or "unknown"
        port_str = f":{port}" if port else ""
        print(f"  DB host:     {host}{port_str}")
        print(f"  DB name:     {db_name}")
    except Exception:  # noqa: BLE001
        print("  DB host:     (could not parse DATABASE_URL)")


# ─── CLI ─────────────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="wipe_to_clean_slate",
        description=(
            "Reset the Compass database to a clean slate for real-member launch. "
            "DESTRUCTIVE: deletes all transactional / PHI data. "
            "Preserves product config tables and three founder accounts. "
            "Exactly one of --dry-run or --apply is required."
        ),
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Print per-table would-be-deleted counts without committing any changes. "
            "Safe to run as many times as needed."
        ),
    )
    mode.add_argument(
        "--apply",
        action="store_true",
        help=(
            "Execute the wipe inside a single transaction. "
            "Rolls back in full on any error. "
            "IRREVERSIBLE — ensure you have a DB snapshot first."
        ),
    )
    return parser


async def _main(*, dry_run: bool) -> int:
    """Async entry point.

    Returns:
        0 on success, 1 on error.
    """
    print("\n" + "=" * 64)
    print("  Compass Clean-Slate Wipe")
    print("  " + ("DRY-RUN MODE — no changes will be committed" if dry_run else "APPLY MODE — changes WILL be committed"))
    print("=" * 64)
    _print_db_host()
    print(f"  Keep emails: {sorted(KEEP_EMAILS)}")
    print("=" * 64 + "\n")

    if not dry_run:
        print(
            "WARNING: --apply will permanently delete all transactional data.\n"
            "         Ensure you have a database snapshot before continuing.\n"
            "         Press Ctrl-C within 5 seconds to abort...\n"
        )
        import time
        time.sleep(5)

    try:
        summary = await run_wipe(dry_run=dry_run)
    except RuntimeError as exc:
        print(f"\nABORTED: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"\nERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        logger.exception("Unhandled error during wipe")
        return 1

    summary.print_report(dry_run=dry_run)
    print(
        f"{'[DRY-RUN] Would delete' if dry_run else 'Deleted'} "
        f"{summary.total_deleted} rows total."
    )

    return 0


def main() -> int:
    """Synchronous entry point for `python -m scripts.wipe_to_clean_slate`."""
    args = _build_parser().parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="[%(levelname)s] %(name)s — %(message)s",
    )
    return asyncio.run(_main(dry_run=args.dry_run))


if __name__ == "__main__":
    sys.exit(main())
