"""CHW compliance checklist evaluation (Epic D).

Single source of truth for "can this CHW work" — used both by the
CHW-facing checklist endpoint (GET /api/v1/credentials/checklist) and by
the feature-flagged work gate wired into accept_request / schedule_session /
create_session / start_session.

Locked rule (see epic spec — do not soften without a product decision):
  - profile complete: User.name non-empty, User.phone non-empty,
    CHWProfile.zip_code non-empty
  - CHWProfile.bio present and <= _BIO_MAX_LENGTH chars (mirrors the C3
    bio-length rule enforced in app.schemas.user.CHWProfileUpdate.bio,
    Field(max_length=120) — that Pydantic field is not importable here
    without pulling in the full schemas.user module's unrelated validators,
    so the limit is re-declared as a local constant with this docstring as
    the explicit cross-reference. If that Field's max_length ever changes,
    update _BIO_MAX_LENGTH to match.)
  - ALL 4 document credential types (hipaa_training,
    professional_service_agreement, liability_insurance, chw_certification)
    must be status="verified" in the `credentials` table — a row that is
    missing (never submitted) OR "pending"/"rejected" both block. Uploaded-
    but-pending is NOT sufficient; this is intentional.
  - CHWProfile.background_check_status == "clear" — "consider", "pending",
    and "not_started" all block.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.credential import Credential
from app.models.user import CHWProfile, User

# Mirrors app.schemas.user.CHWProfileUpdate.bio's Field(max_length=120) — see
# module docstring above for why this is a separate constant rather than an
# import.
_BIO_MAX_LENGTH = 120

# The 4 document-upload credential types that must be independently verified.
# Order here is the order codes are appended to `missing` when several are
# absent, which keeps test assertions and frontend rendering deterministic.
DOCUMENT_CREDENTIAL_TYPES: tuple[str, ...] = (
    "hipaa_training",
    "professional_service_agreement",
    "liability_insurance",
    "chw_certification",
)

# All 5 checklist item codes surfaced to the frontend (4 documents +
# background_check), in display order.
ALL_REQUIREMENT_CODES: tuple[str, ...] = (*DOCUMENT_CREDENTIAL_TYPES, "background_check")

_VERIFIED_STATUS = "verified"
_BACKGROUND_CHECK_CLEAR = "clear"

# Machine-readable codes for the two profile-shape requirements, distinct
# from the 5 checklist-item codes above (these two aren't individually
# trackable checklist rows — they gate on User/CHWProfile fields directly).
_CODE_PROFILE_INCOMPLETE = "profile_incomplete"
_CODE_BIO_INVALID = "bio_missing_or_too_long"


@dataclass(frozen=True)
class ChwComplianceStatus:
    """Structured result for the CHW-facing checklist endpoint.

    ``credentials`` maps each of the 4 document types to its current status
    ("missing" | "pending" | "verified" | "rejected"). ``background_check``
    is the raw CHWProfile.background_check_status value. ``can_work`` /
    ``missing`` mirror chw_can_work()'s return values so the endpoint can
    return everything the frontend needs in one payload.
    """

    can_work: bool
    missing: list[str]
    credentials: dict[str, str]
    background_check_status: str


async def _load_credential_statuses(db: AsyncSession, chw_id: uuid.UUID) -> dict[str, str]:
    """Return {type: status} for the 4 document credential types.

    A type with no row is reported as "missing" rather than omitted, so
    callers never need a second existence check.
    """
    result = await db.execute(
        select(Credential.type, Credential.status).where(
            Credential.chw_id == chw_id,
            Credential.type.in_(DOCUMENT_CREDENTIAL_TYPES),
        )
    )
    by_type = {row.type: row.status for row in result.all()}
    return {t: by_type.get(t, "missing") for t in DOCUMENT_CREDENTIAL_TYPES}


def _bio_is_valid(bio: str | None) -> bool:
    if bio is None:
        return False
    stripped = bio.strip()
    if not stripped:
        return False
    return len(stripped) <= _BIO_MAX_LENGTH


async def chw_can_work(db: AsyncSession, chw_user: User) -> tuple[bool, list[str]]:
    """Evaluate the full compliance checklist for a CHW.

    Returns ``(can_work, missing)`` where ``missing`` is a list of stable,
    machine-readable requirement codes (never empty when can_work is False,
    always empty when can_work is True). Defensive against a CHW with no
    CHWProfile row at all (should be unreachable in practice — every CHW
    account gets one at registration — but a malformed/partial account must
    never raise here; it should simply fail every profile/bio/credential
    check and report all applicable codes).

    Args:
        db: Active async session (read-only — no writes performed).
        chw_user: The authenticated User row for the CHW being evaluated.
            Caller is responsible for confirming chw_user.role == "chw"
            before calling; this function does not re-check role so it can
            be unit-tested against a bare User/CHWProfile pair.

    Returns:
        Tuple of (can_work: bool, missing: list[str]).
    """
    missing: list[str] = []

    profile_result = await db.execute(
        select(CHWProfile).where(CHWProfile.user_id == chw_user.id)
    )
    profile: CHWProfile | None = profile_result.scalar_one_or_none()

    name_ok = bool(chw_user.name and chw_user.name.strip())
    phone_ok = bool(chw_user.phone and chw_user.phone.strip())
    zip_ok = bool(profile and profile.zip_code and profile.zip_code.strip())
    if not (name_ok and phone_ok and zip_ok):
        missing.append(_CODE_PROFILE_INCOMPLETE)

    bio_ok = _bio_is_valid(profile.bio if profile else None)
    if not bio_ok:
        missing.append(_CODE_BIO_INVALID)

    credential_statuses = await _load_credential_statuses(db, chw_user.id)
    for cred_type in DOCUMENT_CREDENTIAL_TYPES:
        if credential_statuses[cred_type] != _VERIFIED_STATUS:
            missing.append(cred_type)

    background_status = profile.background_check_status if profile else "not_started"
    if background_status != _BACKGROUND_CHECK_CLEAR:
        missing.append("background_check")

    return (len(missing) == 0, missing)


async def get_compliance_status(db: AsyncSession, chw_user: User) -> ChwComplianceStatus:
    """Full checklist payload for GET /api/v1/credentials/checklist.

    Runs chw_can_work() plus one extra query for the credential-status map
    so the frontend can render all 5 items (status chip per item) in a
    single round trip, per the epic's "one payload" recommendation.
    """
    can_work, missing = await chw_can_work(db, chw_user)
    credential_statuses = await _load_credential_statuses(db, chw_user.id)

    profile_result = await db.execute(
        select(CHWProfile).where(CHWProfile.user_id == chw_user.id)
    )
    profile: CHWProfile | None = profile_result.scalar_one_or_none()
    background_status = profile.background_check_status if profile else "not_started"

    return ChwComplianceStatus(
        can_work=can_work,
        missing=missing,
        credentials=credential_statuses,
        background_check_status=background_status,
    )


async def notify_chw_if_newly_approved(
    db: AsyncSession, chw_user: User, *, was_compliant_before: bool
) -> None:
    """Fire the "you're approved" email + push on a false -> true can_work
    transition (Epic D3).

    Callers (PATCH /credentials/{id}/review and PATCH
    /admin/chws/{id}/background-check) are each responsible for capturing
    ``was_compliant_before`` via ``chw_can_work()`` BEFORE applying their
    mutation, then calling this AFTER the mutation is committed. Re-checks
    the CURRENT can_work state itself (rather than trusting a caller-passed
    "after" value) so the two call sites can never drift out of sync with
    the single source of truth.

    No-op (does nothing, raises nothing) when:
      - the CHW was already compliant before the mutation (no transition), or
      - the CHW is still not compliant after the mutation (no transition).

    Best-effort: the email/push helpers already never raise on their own,
    and this function adds no additional exception surface — a delivery
    failure must never unwind the caller's already-committed admin mutation.
    """
    if was_compliant_before:
        return

    is_compliant_now, _ = await chw_can_work(db, chw_user)
    if not is_compliant_now:
        return

    import logging

    logger = logging.getLogger("compass.chw_compliance")

    if chw_user.email:
        try:
            from app.services.email import send_chw_approved_email

            first_name = (chw_user.name or "there").split(" ")[0]
            await send_chw_approved_email(to=chw_user.email, chw_first_name=first_name)
        except Exception as e:  # noqa: BLE001
            logger.warning("CHW-approved email failed for chw=%s: %s", chw_user.id, e)

    try:
        from app.services.notifications import NotificationPayload, notify_user

        await notify_user(
            db,
            chw_user.id,
            NotificationPayload(
                user_id=chw_user.id,
                title="You're approved!",
                body="Your CompassCHW account is approved — you're ready to start working.",
                deeplink="compasschw://chw/dashboard",
                category="chw.approved",
                data={},
            ),
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("CHW-approved push failed for chw=%s: %s", chw_user.id, e)
