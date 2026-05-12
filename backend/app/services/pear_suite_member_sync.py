"""Member synchronization service for Pear Suite.

Ensures a Compass member exists in Pear Suite's system before any billing
activity can be submitted. The sync is idempotent — if the member already
has a pear_suite_member_id stored on their MemberProfile, the function
returns immediately without calling the API.

HIPAA note: mediCalId is PHI. It is passed to Pear Suite only when the
member explicitly lacks a pear_suite_member_id (i.e., first sync). It is
never logged — only the returned Pear Suite member ID is logged.

Usage:
    pear_member_id = await ensure_member_synced(db, member_profile, user)
"""

import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import MemberProfile, User
from app.services.billing.pear_suite_provider import PearSuiteProvider

logger = logging.getLogger("compass.billing.member_sync")


def get_pear_suite_provider() -> PearSuiteProvider:
    """Return the configured PearSuiteProvider singleton.

    Uses the billing provider factory to ensure we always get the same
    instance (same API key, same base URL) as the rest of the billing stack.
    """
    from app.services.billing import get_billing_provider
    provider = get_billing_provider()
    if not isinstance(provider, PearSuiteProvider):
        raise TypeError(
            f"Billing provider is {type(provider).__name__}, not PearSuiteProvider. "
            "Member sync requires Pear Suite to be the configured billing provider."
        )
    return provider


def _build_member_payload(
    profile: MemberProfile,
    user: User,
) -> dict[str, Any]:
    """Construct the Pear Suite CreateMember payload from Compass models.

    Only non-None fields are included to avoid sending null values that
    Pear Suite may reject. mediCalId is included when present — it is the
    primary identifier Pear Suite uses to link our member to Medi-Cal records.

    Args:
        profile: The member's MemberProfile row.
        user: The corresponding User row (name, email, phone).

    Returns:
        Dict matching Pear Suite's POST /api/beta/members body schema.
    """
    name_parts = (user.name or "").strip().split(" ", maxsplit=1)
    first_name = name_parts[0] if name_parts else ""
    last_name = name_parts[1] if len(name_parts) > 1 else ""

    payload: dict[str, Any] = {
        "firstName": first_name,
        "lastName": last_name,
    }

    if user.email:
        payload["email"] = user.email

    if user.phone:
        payload["phone"] = user.phone

    if profile.primary_language:
        payload["language"] = profile.primary_language

    # mediCalId is PHI — included but never logged. Pear Suite uses this
    # to link to Medi-Cal eligibility records server-side.
    if profile.medi_cal_id:
        payload["mediCalId"] = profile.medi_cal_id

    # Address: Pear Suite accepts street/city/state/zip. We use zip_code only
    # since Compass does not store full member address (by design — minimal PHI).
    # This may cause Pear to reject the address block; omit it if zip_code is None
    # so we don't send a partial address object that fails validation.
    if profile.zip_code:
        payload["address"] = {
            "zip": profile.zip_code,
        }

    return payload


async def ensure_member_synced(
    db: AsyncSession,
    profile: MemberProfile,
    user: User,
) -> str:
    """Return the Pear Suite member ID for a member, syncing to Pear if absent.

    This function is idempotent. If profile.pear_suite_member_id is already
    set, it returns immediately. Otherwise it calls POST /api/beta/members,
    persists the returned ID on the profile, and commits the session.

    Args:
        db: Async SQLAlchemy session. The function commits after syncing.
        profile: MemberProfile ORM object. May be mutated (pear_suite_member_id set).
        user: User ORM object for name/email/phone.

    Returns:
        The Pear Suite member ID string.

    Raises:
        ValueError: if Pear Suite does not return an ID in its response.
        httpx.HTTPStatusError: if the Pear Suite API call fails.
        TypeError: if the billing provider is not PearSuiteProvider.
    """
    if profile.pear_suite_member_id:
        logger.info(
            "pear_suite.member_sync.skip: member_user_id=%s already_synced=true pear_member_id=%s",
            user.id,
            profile.pear_suite_member_id,
        )
        return profile.pear_suite_member_id

    logger.info(
        "pear_suite.member_sync.start: member_user_id=%s",
        user.id,
    )

    provider = get_pear_suite_provider()
    member_payload = _build_member_payload(profile, user)

    # PHI guard: log field names only, never values for mediCalId / email / phone
    logger.info(
        "pear_suite.member_sync.payload_shape: fields=%s member_user_id=%s",
        [k for k in member_payload.keys() if k != "mediCalId"],
        user.id,
    )

    pear_response = await provider.create_member(member_payload)

    pear_member_id = pear_response.get("id") or pear_response.get("memberId")
    if not pear_member_id:
        logger.error(
            "pear_suite.member_sync.no_id: member_user_id=%s response_keys=%s",
            user.id,
            list(pear_response.keys()),
        )
        raise ValueError(
            f"Pear Suite did not return a member ID for member_user_id={user.id}. "
            f"Response keys: {list(pear_response.keys())}. "
            "Check Pear Suite dashboard — member may have been created but ID not returned."
        )

    profile.pear_suite_member_id = pear_member_id
    await db.commit()

    logger.info(
        "pear_suite.member_sync.success: member_user_id=%s pear_member_id=%s",
        user.id,
        pear_member_id,
    )
    return pear_member_id
