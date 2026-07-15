"""SMS eligibility rules for masked-number CHW<->member messaging.

A member is SMS-eligible iff ALL of:
  1. ``User.phone`` is present and normalizes to E.164.
  2. ``User.phone_verified_at`` is not NULL — phone ownership was proven via
     the OTP verification flow (``app/routers/phone_verification.py``).
  3. The normalized phone is not the sentinel placeholder number
     (555-555-5555 and its common formatting variants) — some CHW-driven
     "add member" / demo flows use this as a UI placeholder before a real
     number is collected; sending real SMS to it would be a silent no-op at
     best and a misrouted message at worst.
  4. ``MemberProfile.sms_opt_out`` is False (the member hasn't texted STOP).
  5. The normalized phone is UNIQUE among all OTHER SMS-eligible members.
     Inbound routing (``POST /api/v1/communication/sms/inbound``) keys
     EXCLUSIVELY off the member's From number — this is the disambiguation
     guarantee that routing design depends on. Two SMS-eligible members
     sharing one phone would make inbound replies ambiguous, so neither is
     eligible until the duplication is resolved.

Assumption: ``User.phone`` is stored already-normalized to E.164 (every
write path — registration, phone-change, Pear sync — goes through
``app.services.auth_service._normalize_phone_e164``). The uniqueness check
below therefore compares the normalized candidate value directly against the
stored column rather than re-normalizing every row in SQL.

Used by:
  - ``POST /api/v1/conversations/{id}/sms`` (outbound send gate).
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import MemberProfile, User
from app.services.auth_service import _normalize_phone_e164
from app.utils.phone import PLACEHOLDER_PHONE_E164

# Sentinel placeholder phone number, compared AFTER normalization so every
# raw formatting variant ("555-555-5555", "(555) 555-5555", "5555555555",
# "+1 555 555 5555") collapses to this one E.164 value.
#
# Re-exported (not redefined) from app.utils.phone — QA batch (2026-07-14),
# Part 3 introduced that module as the single named constant for this
# sentinel, referenced by the phone-uniqueness exemption (migration
# phoneidx0715) and the call-block guard (routers/communication.py). Kept
# under this name here too (rather than renaming every call site) since
# existing tests (tests/test_sms_eligibility.py, tests/test_sms_messaging.py,
# tests/test_message_sms_fanout.py) already import/assert on
# ``SENTINEL_PHONE_E164`` and the ``"sentinel_phone"`` reason code.
SENTINEL_PHONE_E164 = PLACEHOLDER_PHONE_E164

# CTIA-standard SMS opt-out keywords (case-insensitive, whole-message
# match). Kept here — not only in the inbound webhook — so any future
# eligibility-preview endpoint and the webhook share one source of truth.
STOP_KEYWORDS: frozenset[str] = frozenset(
    {"STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "OPT-OUT"}
)


@dataclass(frozen=True)
class SmsEligibilityResult:
    """Outcome of an SMS eligibility check.

    ``reason_code`` is a stable machine-readable string for FE branching;
    ``detail`` is a human-readable message safe to surface directly to a
    CHW (contains no PHI beyond "this member").
    """

    eligible: bool
    reason_code: str | None = None
    detail: str | None = None
    normalized_phone: str | None = None


def normalize_phone_e164(value: str | None) -> str | None:
    """Public re-export of auth_service's E.164 normalizer.

    Callers outside auth_service should use this name rather than reaching
    into ``app.services.auth_service._normalize_phone_e164`` directly.
    """
    return _normalize_phone_e164(value)


async def check_sms_eligibility(
    db: AsyncSession,
    *,
    member_user: User,
    member_profile: MemberProfile,
) -> SmsEligibilityResult:
    """Return whether ``member_user`` can currently receive masked SMS.

    Args:
        db: Active async database session.
        member_user: The target member's User row.
        member_profile: The target member's MemberProfile row.

    Returns:
        SmsEligibilityResult. When ``eligible`` is True, ``normalized_phone``
        is always populated and is the E.164 address to send to.
    """
    if member_user.role != "member":
        return SmsEligibilityResult(
            eligible=False,
            reason_code="not_a_member",
            detail="Target user is not a member.",
        )

    normalized = normalize_phone_e164(member_user.phone)
    if not normalized:
        return SmsEligibilityResult(
            eligible=False,
            reason_code="no_phone",
            detail="Member has no phone number on file.",
        )

    if member_user.phone_verified_at is None:
        return SmsEligibilityResult(
            eligible=False,
            reason_code="phone_not_verified",
            detail="Member's phone number has not been verified.",
        )

    if normalized == SENTINEL_PHONE_E164:
        return SmsEligibilityResult(
            eligible=False,
            reason_code="sentinel_phone",
            detail="Member's phone is a placeholder number and cannot receive SMS.",
        )

    if member_profile.sms_opt_out:
        return SmsEligibilityResult(
            eligible=False,
            reason_code="opted_out",
            detail="Member has opted out of SMS (replied STOP).",
        )

    # Uniqueness: any OTHER member who would ALSO be SMS-eligible with this
    # same normalized phone breaks inbound routing (we can't tell them apart
    # by From number). Scoped to role=member, verified, not opted out, not
    # soft-deleted, excluding this member's own row.
    duplicate_count_stmt = (
        select(func.count())
        .select_from(User)
        .join(MemberProfile, MemberProfile.user_id == User.id)
        .where(
            User.role == "member",
            User.id != member_user.id,
            User.deleted_at.is_(None),
            User.phone == normalized,
            User.phone_verified_at.is_not(None),
            MemberProfile.sms_opt_out.is_(False),
        )
    )
    duplicate_count = (await db.execute(duplicate_count_stmt)).scalar_one()
    if duplicate_count > 0:
        return SmsEligibilityResult(
            eligible=False,
            reason_code="duplicate_phone",
            detail=(
                "Another member shares this phone number; SMS routing "
                "would be ambiguous."
            ),
        )

    return SmsEligibilityResult(eligible=True, normalized_phone=normalized)
