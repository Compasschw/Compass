"""Best-effort post-signup confirmations (Epic A): "thanks for signing up"
email + SMS.

Not to be confused with ``app.services.notifications`` / ``app.services.
notification_service``, which are the Expo PUSH-notification stack used for
in-app business events (session scheduled, request accepted, etc.). This
module is specifically the one-time email (+ SMS, if eligible) sent at
account-creation time, covering AWS SES (BAA-covered transactional email)
and the Vonage masked-SMS Messages API.

Shared by every account-creation surface — self-service signup (``POST
/auth/register``), social sign-up (``POST /auth/oauth/google`` /
``/oauth/apple``), and CHW-initiated member onboarding (``POST
/chw/members``) — so all three send the exact same "thanks for signing up"
confirmation email, and SMS-eligible members additionally get a brief
confirmation text, without duplicating the try/except/log boilerplate at
each call site.

Design mirrors the codebase's existing best-effort background-task
convention (see ``auth_service.append_new_member_to_csv`` and
``routers.auth._sync_new_member_to_pear``):

  - Callers schedule ``send_signup_confirmations`` via
    ``BackgroundTasks.add_task(...)`` AFTER their own ``db.commit()``
    succeeds, so a notification is only ever attempted for a
    durably-persisted account.
  - This module opens its own DB session (the request-scoped session is
    closed by the time a background task runs) and NEVER raises — any
    failure (SES down/sandboxed, Vonage unconfigured/erroring, unexpected
    exception) is caught and logged, never propagated. There is no request
    left to fail by the time this runs.
"""

from __future__ import annotations

import logging
from uuid import UUID

logger = logging.getLogger("compass.signup_confirmations")


async def send_signup_confirmations(user_id: UUID, *, created_by_chw: bool = False) -> None:
    """Best-effort: send the post-signup confirmation email, and — for
    SMS-eligible members — a brief confirmation SMS.

    Intended to be scheduled via ``BackgroundTasks.add_task`` from every
    register flow (self-signup, OAuth signup, CHW-created member) AFTER the
    account is durably committed. Opens its own DB session; never raises.

    Args:
        user_id: The just-created account's id.
        created_by_chw: True only when this call originates from the
            CHW-initiated member-onboarding path (``POST /chw/members``) —
            selects the "your CHW created this account for you" email copy
            variant (Epic A v2) instead of the plain self-signup welcome.
            Self-signup and OAuth-signup call sites leave this at the
            default False. Ignored for non-member roles (the CHW-created
            variant only exists for members — see
            ``render_signup_confirmation_email``).

    Email is sent for every role (member, chw, admin); the copy varies by
    role/creation-path (Epic A v2) but the send is unconditional. SMS is
    attempted only for members, and only when ``check_sms_eligibility`` says
    the member's phone is verified, non-sentinel, non-duplicate, and not
    opted out — which in practice means it usually no-ops at signup time
    (phone verification happens via a separate OTP flow, after account
    creation), but the guard is here so already-eligible members (e.g.
    re-registration edge cases, or future flows that verify phone before
    this fires) still get texted.
    """
    from sqlalchemy import select

    from app.database import async_session
    from app.models.user import MemberProfile, User

    try:
        async with async_session() as db:
            user = await db.get(User, user_id)
            if user is None:
                logger.warning("signup_confirmations: user not found user_id=%s", user_id)
                return

            await _send_confirmation_email(user, created_by_chw=created_by_chw)

            if user.role == "member":
                profile_result = await db.execute(
                    select(MemberProfile).where(MemberProfile.user_id == user_id)
                )
                member_profile = profile_result.scalar_one_or_none()
                if member_profile is not None:
                    await _send_confirmation_sms(db, member_user=user, member_profile=member_profile)
    except Exception:  # noqa: BLE001
        # Belt-and-suspenders — _send_confirmation_email/_send_confirmation_sms
        # already swallow their own errors, but this background task must
        # NEVER raise regardless of what else could go wrong above (e.g.
        # acquiring the session itself, or the initial db.get / select).
        logger.exception(
            "signup_confirmations: send_signup_confirmations failed unexpectedly user_id=%s",
            user_id,
        )


async def _send_confirmation_email(user, *, created_by_chw: bool = False) -> None:
    """Send the signup confirmation email (variant chosen by role /
    created_by_chw — see ``render_signup_confirmation_email``). Logs and
    swallows failure."""
    from app.services.email import send_signup_confirmation_email

    try:
        result = await send_signup_confirmation_email(
            to=user.email, name=user.name,
            created_by_chw=created_by_chw, role=user.role,
        )
        if not result.success:
            logger.warning(
                "signup_confirmations: confirmation email failed user=%s error=%s",
                user.id, result.error,
            )
        else:
            logger.info("signup_confirmations: confirmation email sent user=%s", user.id)
    except Exception:  # noqa: BLE001
        logger.exception(
            "signup_confirmations: confirmation email raised unexpectedly user=%s",
            user.id,
        )


async def _send_confirmation_sms(db, *, member_user, member_profile) -> None:
    """Send a brief branded confirmation SMS if the member is SMS-eligible.

    Reuses the masked-SMS eligibility gate (``check_sms_eligibility``) and
    brand-prefix helper (``brand_outbound_sms``) from the existing
    CHW<->member messaging feature rather than re-implementing either.
    Logs and swallows every failure mode (ineligible, unconfigured Vonage,
    network error, unexpected exception) — never raises.
    """
    from app.config import settings
    from app.routers.conversations import brand_outbound_sms, with_stop_prompt
    from app.services.sms_eligibility import check_sms_eligibility
    from app.services.vonage_sms import get_vonage_sms_messages_client

    try:
        # Kill switch (SMS Output Spec 1 §5): member-facing SMS only. OTP
        # verification is never gated by this flag.
        if not settings.sms_mirroring_enabled:
            logger.info(
                "signup_confirmations: confirmation sms skipped "
                "(sms_mirroring_enabled off) user=%s",
                member_user.id,
            )
            return

        eligibility = await check_sms_eligibility(
            db, member_user=member_user, member_profile=member_profile
        )
        if not eligibility.eligible or eligibility.normalized_phone is None:
            logger.debug(
                "signup_confirmations: member not SMS-eligible, skipping "
                "confirmation sms user=%s reason=%s",
                member_user.id, eligibility.reason_code,
            )
            return

        client = get_vonage_sms_messages_client()
        body = await with_stop_prompt(
            db,
            member_profile,
            brand_outbound_sms("Welcome to CompassCHW! Your account is ready to go."),
        )
        send_result = await client.send_text(eligibility.normalized_phone, body)
        if not send_result.success:
            logger.warning(
                "signup_confirmations: confirmation sms failed user=%s error=%s status=%s",
                member_user.id, send_result.error, send_result.status_code,
            )
        else:
            logger.info(
                "signup_confirmations: confirmation sms sent user=%s", member_user.id
            )
    except Exception:  # noqa: BLE001
        logger.exception(
            "signup_confirmations: confirmation sms raised unexpectedly user=%s",
            member_user.id,
        )


__all__ = ["send_signup_confirmations"]
