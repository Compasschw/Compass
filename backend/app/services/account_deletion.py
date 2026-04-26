"""Account deletion service — soft-delete + PII anonymisation.

Implements the Apple / Google Play required account-deletion flow while
satisfying HIPAA 45 CFR §164.530(j)'s 6-year retention requirement for
PHI-adjacent audit records.

Strategy: soft-delete + anonymise, never hard-delete.
- The User row is kept so that ServiceRequest / Session / BillingClaim /
  AuditLog foreign-key references remain valid for 6 years.
- All PII fields on User, CHWProfile, and MemberProfile are overwritten with
  anonymised sentinel values.
- Auxiliary PII carriers (DeviceToken, MagicLinkToken, RefreshToken) are
  deleted — they have no retention value.
- MemberConsent rows are retained for HIPAA consent audit but the signature
  column is redacted to "[deleted]".
- A dedicated AuditLog row is written from within this service so that the
  full anonymisation event is self-contained for incident-response queries.

See also: models/user.py TODO(hard-delete-scheduler) for the 6-year purge job.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditLog
from app.models.device import DeviceToken
from app.models.magic_link import MagicLinkToken
from app.models.user import CHWProfile, MemberProfile, User

logger = logging.getLogger("compass.account_deletion")

# ─── Sentinel values written over PII fields ─────────────────────────────────

_ANONYMISED_NAME = "Deleted User"
_ANONYMISED_ZIP = "00000"
_REDACTED_CONSENT_SIGNATURE = "[deleted]"

_SIX_YEARS_DAYS = 365 * 6 + 2  # 6 calendar years including 2 leap-day buffers


def _anonymised_email(user_id: uuid.UUID) -> str:
    """Build a deterministic non-routable sentinel email for the anonymised row.

    The email must remain unique in the `users.email` column.  Using the UUID
    guarantees uniqueness without revealing any original PII.
    """
    return f"deleted-{user_id}@deleted.compasschw.local"


# ─── Public entry point ───────────────────────────────────────────────────────


async def execute_account_deletion(
    db: AsyncSession,
    user: User,
    ip_address: str | None,
    user_agent: str | None,
) -> None:
    """Soft-delete and anonymise a user account in a single database transaction.

    Idempotent: if `user.deleted_at` is already set the function returns
    immediately without performing any writes, preserving the original
    deletion timestamp.

    Steps (all within one implicit transaction via the caller's session):
    1. Guard — idempotency check.
    2. Soft-delete the User row (deleted_at, is_active, data_retention_until).
    3. Scrub PII on the User row.
    4. Scrub PII on CHWProfile / MemberProfile (whichever exists).
    5. Hard-delete DeviceToken rows (push tokens have zero retention value).
    6. Hard-delete MagicLinkToken rows (cannot be used after is_active=False anyway).
    7. Hard-delete RefreshToken rows.
    8. Redact MemberConsent signature fields (rows are HIPAA-retained).
    9. Write a HIPAA audit row capturing exactly what was anonymised vs retained.

    Args:
        db: Async SQLAlchemy session. The caller is responsible for commit/rollback.
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
    retention_until = (now + timedelta(days=_SIX_YEARS_DAYS)).date()
    anonymised_email = _anonymised_email(user.id)

    # ── Step 2 & 3: Soft-delete + anonymise User ──────────────────────────────
    user.deleted_at = now
    user.is_active = False
    user.data_retention_until = retention_until
    user.email = anonymised_email
    user.name = _ANONYMISED_NAME
    user.phone = None
    user.password_hash = ""          # Empty hash — bcrypt will never match this.
    user.profile_picture_url = None

    # ── Step 4a: Anonymise CHWProfile if present ──────────────────────────────
    chw_result = await db.execute(
        select(CHWProfile).where(CHWProfile.user_id == user.id)
    )
    chw_profile = chw_result.scalar_one_or_none()
    chw_anonymised = False
    if chw_profile is not None:
        chw_profile.bio = None
        chw_profile.zip_code = _ANONYMISED_ZIP
        chw_profile.latitude = None
        chw_profile.longitude = None
        chw_profile.languages = []
        chw_profile.specializations = []
        chw_profile.is_available = False
        chw_profile.availability_windows = None
        # Stripe Connect IDs are not PHI but have no value after deletion.
        chw_profile.stripe_connected_account_id = None
        chw_profile.stripe_payouts_enabled = False
        chw_profile.stripe_details_submitted = False
        chw_anonymised = True

    # ── Step 4b: Anonymise MemberProfile if present ───────────────────────────
    member_result = await db.execute(
        select(MemberProfile).where(MemberProfile.user_id == user.id)
    )
    member_profile = member_result.scalar_one_or_none()
    member_anonymised = False
    if member_profile is not None:
        member_profile.zip_code = _ANONYMISED_ZIP
        member_profile.latitude = None
        member_profile.longitude = None
        member_profile.primary_need = None
        member_profile.additional_needs = None
        member_profile.insurance_provider = None
        member_profile.medi_cal_id = None          # AES-256-GCM encrypted PHI — null it.
        member_profile.preferred_mode = None
        member_anonymised = True

    # ── Step 5: Hard-delete DeviceToken rows ──────────────────────────────────
    device_result = await db.execute(
        delete(DeviceToken).where(DeviceToken.user_id == user.id)
    )
    device_tokens_deleted = device_result.rowcount  # type: ignore[union-attr]

    # ── Step 6: Hard-delete MagicLinkToken rows ───────────────────────────────
    ml_result = await db.execute(
        delete(MagicLinkToken).where(MagicLinkToken.user_id == user.id)
    )
    magic_link_tokens_deleted = ml_result.rowcount  # type: ignore[union-attr]

    # ── Step 7: Hard-delete RefreshToken rows ─────────────────────────────────
    from app.models.auth import RefreshToken

    rt_result = await db.execute(
        delete(RefreshToken).where(RefreshToken.user_id == user.id)
    )
    refresh_tokens_deleted = rt_result.rowcount  # type: ignore[union-attr]

    # ── Step 8: Redact MemberConsent signatures (rows retained for HIPAA) ─────
    consent_rows_redacted = 0
    try:
        from app.models.communication import MemberConsent  # type: ignore[import]

        consent_result = await db.execute(
            update(MemberConsent)
            .where(MemberConsent.user_id == user.id)
            .values(signature="[deleted]")
        )
        consent_rows_redacted = consent_result.rowcount  # type: ignore[union-attr]
    except (ImportError, AttributeError):
        # MemberConsent model may not exist in all project variants — skip gracefully.
        logger.debug("account_deletion: MemberConsent model not found, skipping redaction")

    # ── Step 9: Write HIPAA audit row ─────────────────────────────────────────
    audit_details: dict = {
        "anonymised": {
            "user_email": True,
            "user_name": True,
            "user_phone": True,
            "user_password_hash": True,
            "user_profile_picture_url": True,
            "chw_profile": chw_anonymised,
            "member_profile": member_anonymised,
        },
        "hard_deleted": {
            "device_tokens": device_tokens_deleted,
            "magic_link_tokens": magic_link_tokens_deleted,
            "refresh_tokens": refresh_tokens_deleted,
        },
        "redacted": {
            "member_consent_signatures": consent_rows_redacted,
        },
        "retained_for_hipaa": [
            "service_requests",
            "sessions",
            "billing_claims",
            "session_followups",
            "audit_log",
            "member_consents (rows retained, signature redacted)",
        ],
        "data_retention_until": retention_until.isoformat(),
    }

    db.add(
        AuditLog(
            user_id=user.id,
            action="SELF_DELETE",
            resource="account_self_deletion",
            resource_id=str(user.id),
            ip_address=ip_address,
            user_agent=user_agent,
            details=audit_details,
        )
    )

    logger.info(
        "account_deletion.complete user_id=%s retention_until=%s",
        user.id,
        retention_until.isoformat(),
    )
