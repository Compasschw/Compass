"""Account deletion service — TRUE hard-delete of member PHI, in-place tombstone.

Founder decision (2026-07, Epic E4): hard-delete SUPERSEDES the prior
soft-delete / anonymise-only strategy. This is a LOCKED product decision —
every member-owned PHI row is now actually removed from the database rather
than pseudonymised-and-retained. This module is the single implementation of
that policy; the previous parallel inline implementation in
``routers/member.py::delete_my_account`` (``DELETE /api/v1/member/account``)
has been deleted outright — there is now exactly one account-deletion code
path, reached via ``DELETE /api/v1/auth/users/me``.

Why the ``users`` row is scrubbed IN PLACE instead of a literal
``DELETE FROM users``
---------------------------------------------------------------------------
Two tables retain a hard FK to ``users.id`` with ``ondelete="RESTRICT"`` AND
have ``UPDATE``/``DELETE`` fully REVOKEd from the application's Postgres role:

  - ``wellness_points_ledger.member_id``  (migration y8v2w3x4z5a6_add_journeys.py)
  - ``reward_redemptions.member_id``      (migration z9w3x4y5a6b7_add_rewards.py)

Both are intentionally append-only ledgers (points/redemption audit trails)
that the app is architecturally forbidden from mutating or deleting, even by
a superuser bug. Because of this, a literal ``DELETE FROM users WHERE id=...``
would be rejected by Postgres RESTRICT the moment any such ledger row exists
for that user — and the app has no privilege to repoint or delete those rows
to work around it. So instead of removing the ``users`` row, this service
scrubs every PII/PHI-identifying column on that SAME row to non-identifying
sentinel values (see ``_scrub_user_row``) and hard-deletes every OTHER
member-owned PHI table that does not carry this restriction. The end state is
functionally equivalent to a hard delete from the perspective of any
data subject: no PHI is recoverable, and the only thing left behind is an
opaque, scrubbed row that ledger/billing/audit rows can still point to.

This still satisfies Apple App Store Review Guideline §5.1.1(v) and the
Google Play "Account deletion" policy at least as strongly as the prior
anonymise-only approach — both require irrecoverable removal of the user's
data, not removal of every SQL row physically. A scrubbed row with zero PII
and zero linked PHI rows meets that bar.

FK-graph treatment table
-------------------------------------------------------------------------
Table                          | Treatment                  | Reason
--------------------------------|-----------------------------|---------------------------------------------
users (this row)                | scrub-in-place (tombstone) | RESTRICT+REVOKE on wellness_points_ledger/reward_redemptions blocks literal DELETE
member_profiles                 | DELETE                     | member-owned PHI, no retention requirement
chw_profiles                    | DELETE (defensive)         | member accounts don't have one; guarded like legacy code
chw_intake_responses            | DELETE (defensive)         | same as above
device_tokens                   | DELETE                     | push tokens, zero retention value
magic_link_tokens               | DELETE                     | single-use, zero retention value
refresh_tokens                  | DELETE (hard)               | user row is being torn down; nothing to keep revoked tokens for
calendar_events                 | DELETE (user_id match)     | member-owned PHI
file_attachments                | DELETE (via message_id)    | member-owned PHI; must precede messages (FK)
call_logs                       | DELETE (via conversation_id)| member-owned PHI; must precede conversations (FK)
messages                        | DELETE (sender_id or convo)| member-owned PHI; must precede conversations (FK)
conversations                   | DELETE (chw_id/member_id)  | member-owned PHI
case_notes                      | DELETE (member_id)         | member-owned PHI, no retention requirement
flag_notes                      | DELETE (member_id)         | member-owned PHI, no retention requirement
member_documents                | DELETE (row, not soft)     | S3 objects already wiped; metadata has no further purpose
member_assessments              | DELETE (member_id)         | cascades to member_assessment_responses via ondelete=CASCADE
member_assessment_responses     | cascade (no direct write)  | ondelete=CASCADE on assessment_id
session_followups               | DELETE (member_id)         | member-owned PHI, no retention requirement
member_journeys                 | DELETE (member_id)         | cascades to member_journey_step_states via ondelete=CASCADE
member_journey_step_states      | cascade (no direct write)  | ondelete=CASCADE on member_journey_id
member_consents                 | DELETE (member_id OR session_id in member's sessions) | FK to sessions has no ondelete; must clear before deleting sessions
session_documentation           | DELETE (via deletable session_id) | unique FK per session, no cascade; must precede sessions
communication_sessions          | DELETE (via deletable session_id) | NOT NULL FK to sessions.id, no cascade, not otherwise member-scoped; must precede sessions (recording/transcript PHI — not in the original spec's table, added because the FK made session deletion impossible without it)
consent_requests                | cascade (no direct write)  | ondelete=CASCADE on session_id
session_transcripts             | cascade (no direct write)  | ondelete=CASCADE on session_id
sessions                        | DELETE (member_id), EXCEPT sessions still referenced by a billing_claims row | billing_claims.session_id is a NOT NULL FK with no ondelete/cascade and billing_claims must be retained — those specific sessions are left in place instead (member_id FK still points at the scrubbed users row, so no PII survives on them either)
service_requests                | DELETE (member_id), EXCEPT requests still referenced by a retained (billing-claimed) session | Session.request_id is a NOT NULL FK with no ondelete/cascade — same carve-out reason as sessions above
reward_transactions             | DELETE (member_id)         | app-owned ledger (models/reward.py), NOT DB-protected — distinct from reward_redemptions
testimonials                    | DELETE (member_id), BEFORE sessions | session_id FK is nullable-on-insert but still blocks a session's DELETE while a row references it — must precede the sessions step
twilio_proxy_sessions           | DELETE (member_id)         | member-owned PHI, no retention requirement
billing_claims                  | untouched                  | FK points at scrubbed users.id row; no PII resolvable via join
audit_log                       | untouched                  | FK points at scrubbed users.id row; audit trail integrity preserved
wellness_points_ledger          | DB-privilege-blocked       | ondelete=RESTRICT + UPDATE/DELETE REVOKEd from app role
reward_redemptions              | DB-privilege-blocked       | ondelete=RESTRICT + UPDATE/DELETE REVOKEd from app role
session_transcripts.speaker_user_id | untouched (nullable FK)| cascades automatically via session deletion above; no separate write needed
resources / credentials / chw_credential_validations | untouched | not relevant to member deletion

S3 cleanup
----------
``delete_member_phi_objects`` is still called and still required — it wipes
the member's S3-resident PHI (documents, attachments, legacy uploads, all
versions). Failures are logged at ERROR and recorded in the audit row but
never block or revert the DB transaction.

Transactionality
-----------------
The entire operation (row-scrub + every DELETE + AuditLog write) executes
against the caller-supplied ``AsyncSession`` with NO internal commit. The
caller (``routers/auth.py::delete_account``) commits exactly once after this
function returns, so any exception anywhere in this function leaves the
account fully intact after the caller's rollback.
"""

import logging
import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditLog
from app.models.billing import BillingClaim
from app.models.calendar import CalendarEvent
from app.models.case_note import CaseNote
from app.models.chw_intake import CHWIntakeResponse
from app.models.communication import CommunicationSession
from app.models.conversation import CallLog, Conversation, FileAttachment, Message
from app.models.device import DeviceToken
from app.models.flag_note import FlagNote
from app.models.followup import SessionFollowup
from app.models.journeys import MemberJourney
from app.models.magic_link import MagicLinkToken
from app.models.member_document import MemberDocument
from app.models.request import ServiceRequest
from app.models.reward import RewardTransaction
from app.models.session import MemberConsent, Session, SessionDocumentation
from app.models.testimonial import Testimonial
from app.models.twilio import TwilioProxySession
from app.models.user import CHWProfile, MemberProfile, User

logger = logging.getLogger("compass.account_deletion")

# ─── Sentinel values written over the scrubbed users row ─────────────────────

_TOMBSTONE_ROLE = "deleted"
_TOMBSTONE_NAME = "Deleted User"

_SIX_YEARS_DAYS = 365 * 6 + 2  # informational only — see data_retention_until note below


def _tombstone_email() -> str:
    """Build a freshly-random, non-routable sentinel email for the scrubbed row.

    MUST be random (uuid4), never derived from the user's id or original
    email — a deterministic value would make the scrubbed row still linkable
    back to the original account, and (more importantly for product) it must
    never collide with a value a future re-registration could plausibly
    generate. Freeing the ORIGINAL email for immediate re-registration is a
    hard requirement of this feature (see backend/tests/test_account_deletion.py).
    """
    return f"deleted-{uuid.uuid4()}@deleted.compasschw.local"


# ─── Public entry points ───────────────────────────────────────────────────


async def execute_account_deletion(
    db: AsyncSession,
    user: User,
    ip_address: str | None,
    user_agent: str | None,
) -> None:
    """Hard-delete a member's PHI and scrub the ``users`` row in place.

    Idempotent: if ``user.deleted_at`` is already set the function returns
    immediately without performing any writes, preserving the original
    deletion timestamp.

    No internal commit — see module docstring "Transactionality". The caller
    is responsible for ``await db.commit()`` after this returns, and for
    letting any raised exception propagate so the session rolls back.

    Args:
        db: Async SQLAlchemy session. Caller commits/rolls back.
        user: The authenticated User ORM instance to be deleted.
        ip_address: Remote IP of the requesting client (for the audit row).
        user_agent: User-Agent header of the requesting client (for the audit row).
    """
    if user.deleted_at is not None:
        logger.info(
            "account_deletion.already_deleted user_id=%s deleted_at=%s",
            user.id,
            user.deleted_at.isoformat(),
        )
        return

    now = datetime.now(UTC)
    user_id = user.id

    # ── Step 1: scrub the users row in place (tombstone) ──────────────────────
    retention_until = _scrub_user_row(user, now)

    # ── Step 2: defensive profile-table scrubs (member accounts don't carry
    #    a CHWProfile/CHWIntakeResponse, but guard exactly like the legacy
    #    code did in case of bad state) ─────────────────────────────────────
    chw_profile_deleted = await _delete_where(db, CHWProfile, CHWProfile.user_id == user_id)
    chw_intake_deleted = await _delete_where(
        db, CHWIntakeResponse, CHWIntakeResponse.user_id == user_id
    )

    # ── Step 3: member_profiles — hard delete ──────────────────────────────
    member_profile_deleted = await _delete_where(
        db, MemberProfile, MemberProfile.user_id == user_id
    )

    # ── Step 4: auth/device carriers — hard delete ─────────────────────────
    device_tokens_deleted = await _delete_where(db, DeviceToken, DeviceToken.user_id == user_id)
    magic_link_tokens_deleted = await _delete_where(
        db, MagicLinkToken, MagicLinkToken.user_id == user_id
    )
    refresh_tokens_deleted = await _delete_where_import_refresh_token(db, user_id)

    # ── Step 5: calendar events owned by this member ───────────────────────
    calendar_events_deleted = await _delete_where(
        db, CalendarEvent, CalendarEvent.user_id == user_id
    )

    # ── Step 6: messaging graph — children before parents ──────────────────
    #   file_attachments -> call_logs -> messages -> conversations
    conversation_ids = await _scalars(
        db,
        select(Conversation.id).where(
            or_(Conversation.chw_id == user_id, Conversation.member_id == user_id)
        ),
    )
    message_ids: list[uuid.UUID] = []
    if conversation_ids:
        message_ids = await _scalars(
            db,
            select(Message.id).where(
                or_(
                    Message.conversation_id.in_(conversation_ids),
                    Message.sender_id == user_id,
                )
            ),
        )
        # Conversation.member_id/chw_id may not cover every message this
        # member sent (e.g. legacy rows) — also catch by sender_id directly,
        # then widen conversation_ids to include any conversation those
        # extra messages belong to so call_logs/conversations cleanup is complete.
        extra_conversation_ids = await _scalars(
            db,
            select(Message.conversation_id).where(Message.sender_id == user_id).distinct(),
        )
        for cid in extra_conversation_ids:
            if cid not in conversation_ids:
                conversation_ids.append(cid)

    file_attachments_deleted = 0
    if message_ids:
        file_attachments_deleted = await _delete_where(
            db, FileAttachment, FileAttachment.message_id.in_(message_ids)
        )

    call_logs_deleted = 0
    if conversation_ids:
        call_logs_deleted = await _delete_where(
            db, CallLog, CallLog.conversation_id.in_(conversation_ids)
        )

    messages_deleted = 0
    if message_ids:
        messages_deleted = await _delete_where(db, Message, Message.id.in_(message_ids))

    conversations_deleted = 0
    if conversation_ids:
        conversations_deleted = await _delete_where(
            db, Conversation, Conversation.id.in_(conversation_ids)
        )

    # ── Step 7: case notes + flag notes authored about this member ─────────
    case_notes_deleted = await _delete_where(db, CaseNote, CaseNote.member_id == user_id)
    flag_notes_deleted = await _delete_where(db, FlagNote, FlagNote.member_id == user_id)

    # ── Step 8: member documents — hard delete metadata rows (S3 wiped below) ─
    member_documents_deleted = await _delete_where(
        db, MemberDocument, MemberDocument.member_id == user_id
    )

    # ── Step 9: assessments — deleting the parent cascades responses ───────
    member_assessments_deleted = await _delete_member_assessments(db, user_id)

    # ── Step 10: session_followups ──────────────────────────────────────────
    session_followups_deleted = await _delete_where(
        db, SessionFollowup, SessionFollowup.member_id == user_id
    )

    # ── Step 11: member_journeys — deleting the parent cascades step states ──
    member_journeys_deleted = await _delete_member_journeys(db, user_id)

    # ── Step 12: testimonials — MUST run before sessions (testimonials.session_id
    #    is a nullable FK, but a row referencing a session still blocks that
    #    session's DELETE; nullable only means an INSERT may omit it) ─────────
    testimonials_deleted = await _delete_where(db, Testimonial, Testimonial.member_id == user_id)

    # ── Step 13: sessions — must clear member_consents + session_documentation
    #    + communication_sessions first (none of the three cascade); consent_requests
    #    and session_transcripts DO cascade automatically via ondelete=CASCADE
    #    on session_id.
    #
    #    IMPORTANT deletability carve-out: billing_claims.session_id is a
    #    NOT NULL FK with no ondelete, and billing_claims must be RETAINED
    #    (see module docstring / FK-graph table — Medi-Cal 7-year retention).
    #    A Session with an existing BillingClaim therefore CANNOT be deleted
    #    without violating that FK — so those specific sessions are left in
    #    place (member_id FK still points at the now-scrubbed users row, so
    #    no PII survives on them either; same treatment as billing_claims
    #    itself). Every OTHER member session (no billing claim) is deleted.
    all_session_ids = await _scalars(db, select(Session.id).where(Session.member_id == user_id))

    billed_session_ids: set[uuid.UUID] = set()
    if all_session_ids:
        billed_session_ids = set(
            await _scalars(
                db,
                select(BillingClaim.session_id).where(
                    BillingClaim.session_id.in_(all_session_ids)
                ),
            )
        )
    deletable_session_ids = [sid for sid in all_session_ids if sid not in billed_session_ids]

    if all_session_ids:
        member_consents_condition = or_(
            MemberConsent.member_id == user_id,
            MemberConsent.session_id.in_(all_session_ids),
        )
    else:
        member_consents_condition = MemberConsent.member_id == user_id
    member_consents_deleted = await _delete_where(db, MemberConsent, member_consents_condition)

    session_documentation_deleted = 0
    communication_sessions_deleted = 0
    if deletable_session_ids:
        session_documentation_deleted = await _delete_where(
            db,
            SessionDocumentation,
            SessionDocumentation.session_id.in_(deletable_session_ids),
        )
        communication_sessions_deleted = await _delete_where(
            db,
            CommunicationSession,
            CommunicationSession.session_id.in_(deletable_session_ids),
        )

    sessions_deleted = 0
    if deletable_session_ids:
        sessions_deleted = await _delete_where(
            db, Session, Session.id.in_(deletable_session_ids)
        )

    # ── Step 14: service_requests — only requests with no remaining session.
    #    Session.request_id is a NOT NULL FK with no ondelete, so a request
    #    still referenced by a billing-claim-protected session (see above)
    #    cannot be deleted either; it is left in place for the same reason. ──
    retained_request_ids: set[uuid.UUID] = set()
    if billed_session_ids:
        retained_request_ids = set(
            await _scalars(
                db, select(Session.request_id).where(Session.id.in_(billed_session_ids))
            )
        )
    service_requests_condition = ServiceRequest.member_id == user_id
    if retained_request_ids:
        service_requests_condition = service_requests_condition & ServiceRequest.id.notin_(
            retained_request_ids
        )
    service_requests_deleted = await _delete_where(db, ServiceRequest, service_requests_condition)

    # ── Step 15: reward_transactions (app-owned ledger — NOT reward_redemptions) ─
    reward_transactions_deleted = await _delete_where(
        db, RewardTransaction, RewardTransaction.member_id == user_id
    )

    # ── Step 16: twilio_proxy_sessions ───────────────────────────────────────
    twilio_proxy_sessions_deleted = await _delete_where(
        db, TwilioProxySession, TwilioProxySession.member_id == user_id
    )

    # ── Step 17: wipe member-owned S3 PHI objects ───────────────────────────
    from app.services.s3_phi_cleanup import delete_member_phi_objects

    s3_cleanup = await delete_member_phi_objects(user_id)

    # ── Step 18: write HIPAA/audit-trail row describing exactly what happened ─
    audit_details: dict = {
        "hard_deleted": {
            "member_profiles": member_profile_deleted,
            "chw_profiles": chw_profile_deleted,
            "chw_intake_responses": chw_intake_deleted,
            "device_tokens": device_tokens_deleted,
            "magic_link_tokens": magic_link_tokens_deleted,
            "refresh_tokens": refresh_tokens_deleted,
            "calendar_events": calendar_events_deleted,
            "file_attachments": file_attachments_deleted,
            "call_logs": call_logs_deleted,
            "messages": messages_deleted,
            "conversations": conversations_deleted,
            "case_notes": case_notes_deleted,
            "flag_notes": flag_notes_deleted,
            "member_documents": member_documents_deleted,
            "member_assessments": member_assessments_deleted,
            "session_followups": session_followups_deleted,
            "member_journeys": member_journeys_deleted,
            "member_consents": member_consents_deleted,
            "session_documentation": session_documentation_deleted,
            "communication_sessions": communication_sessions_deleted,
            "sessions": sessions_deleted,
            "service_requests": service_requests_deleted,
            "reward_transactions": reward_transactions_deleted,
            "testimonials": testimonials_deleted,
            "twilio_proxy_sessions": twilio_proxy_sessions_deleted,
        },
        "scrubbed_in_place": {
            "users_row": True,
        },
        "s3_phi_cleanup": s3_cleanup.as_audit_details(),
        "retained_for_hipaa": [
            "billing_claims (FK to scrubbed users row; no PII resolvable)",
            "audit_log (FK to scrubbed users row; no PII resolvable)",
            (
                f"{len(billed_session_ids)} session(s) still referenced by a "
                "billing_claims row (member_id FK to scrubbed users row; no "
                "PII resolvable) — cannot be deleted while billing_claims.session_id "
                "is a NOT NULL FK with no cascade"
                if billed_session_ids
                else "sessions referenced by billing_claims, if any (none for this account)"
            ),
        ],
        "db_privilege_blocked": [
            "wellness_points_ledger (RESTRICT + UPDATE/DELETE revoked from app role)",
            "reward_redemptions (RESTRICT + UPDATE/DELETE revoked from app role)",
        ],
        "data_retention_until": retention_until.isoformat(),
    }

    db.add(
        AuditLog(
            user_id=user_id,
            action="HARD_DELETE",
            resource="account_hard_deletion",
            resource_id=str(user_id),
            ip_address=ip_address,
            user_agent=user_agent,
            details=audit_details,
        )
    )

    if not s3_cleanup.ok:
        # DB deletion still proceeds — but this must never pass silently:
        # leftover S3 objects are exactly the right-to-delete violation this
        # step exists to prevent. The audit row carries the per-bucket errors.
        logger.error(
            "account_deletion.s3_cleanup_incomplete user_id=%s errors=%s",
            user_id,
            "; ".join(s3_cleanup.errors),
        )

    logger.info(
        "account_deletion.complete user_id=%s retention_until=%s",
        user_id,
        retention_until.isoformat(),
    )


async def deactivate_member_account(db: AsyncSession, user: User) -> None:
    """Deactivate (not delete) a member's account — reversible, data-preserving.

    Sets ``is_active = False`` and revokes (does NOT delete) every
    ``RefreshToken`` row for the user, so all existing sessions are killed
    immediately while the underlying data remains fully intact.

    Retention/reactivation steps are TBD — owner: JT. This function currently
    only flips ``is_active`` and revokes sessions; data is retained intact
    and reversible by an as-yet-undefined admin/support reactivation path.

    No internal commit — matches the pattern of ``execute_account_deletion``.
    The caller commits.
    """
    from app.models.auth import RefreshToken

    user.is_active = False

    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked.is_(False))
        .values(revoked=True)
    )


# ─── Internal helpers ──────────────────────────────────────────────────────


def _scrub_user_row(user: User, now: datetime) -> date:
    """Overwrite every PII-identifying column on the users row in place.

    Returns the (informational-only) data_retention_until date. There is no
    scheduled purge job anymore — the row is already non-identifying the
    moment this function returns — so the value is kept only as a
    human-readable "this is roughly how long we expect this tombstone to
    stick around" marker, never load-bearing for any query or job.
    """
    retention_until: date = (now + timedelta(days=_SIX_YEARS_DAYS)).date()

    user.deleted_at = now
    user.role = _TOMBSTONE_ROLE
    user.is_active = False
    user.email = _tombstone_email()
    user.name = _TOMBSTONE_NAME
    user.phone = None
    user.phone_verified_at = None
    user.password_hash = ""  # Empty hash — bcrypt will never match this.
    user.profile_picture_url = None
    user.data_retention_until = retention_until
    # must_change_password, first_login_at, last_active_at: left as-is —
    # harmless timestamps/flags, not PII, no product reason to touch them.

    return retention_until


async def _delete_where(db: AsyncSession, model, condition) -> int:
    """Execute a DELETE against ``model`` filtered by ``condition``; return rowcount."""
    result = await db.execute(delete(model).where(condition))
    return result.rowcount  # type: ignore[attr-defined]


async def _delete_where_import_refresh_token(db: AsyncSession, user_id: uuid.UUID) -> int:
    """Hard-delete RefreshToken rows — imported locally to avoid a circular import
    at module load time (mirrors the pattern used by the pre-existing code)."""
    from app.models.auth import RefreshToken

    return await _delete_where(db, RefreshToken, RefreshToken.user_id == user_id)


async def _scalars(db: AsyncSession, stmt) -> list:
    """Run a SELECT and return the scalar results as a plain list."""
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def _delete_member_assessments(db: AsyncSession, user_id: uuid.UUID) -> int:
    """Delete MemberAssessment rows for this member.

    MemberAssessmentResponse rows cascade automatically via
    ``ondelete="CASCADE"`` on ``assessment_id`` — no separate delete needed.
    """
    from app.models.assessment import MemberAssessment

    return await _delete_where(db, MemberAssessment, MemberAssessment.member_id == user_id)


async def _delete_member_journeys(db: AsyncSession, user_id: uuid.UUID) -> int:
    """Delete MemberJourney rows for this member.

    MemberJourneyStepState rows cascade automatically via
    ``ondelete="CASCADE"`` on ``member_journey_id`` — no separate delete needed.
    """
    return await _delete_where(db, MemberJourney, MemberJourney.member_id == user_id)
