"""High-level notification helpers for CompassCHW business events.

Each function is a thin, PHI-safe wrapper around ``notify_user`` that:
  - Accepts typed arguments rather than raw ``NotificationPayload`` so callers
    don't need to know Expo/push concepts.
  - Never raises — push delivery failures must not break the triggering API call.
  - Never includes clinical content, Medi-Cal IDs, diagnoses, or any PHI in
    the notification title or body (HIPAA 45 CFR §164.514).

Usage (inside a router using BackgroundTasks)::

    background_tasks.add_task(
        notification_service.notify_session_scheduled,
        db, chw_id, member_name, session.id, scheduled_at,
    )

Scheduler usage (no BackgroundTasks — just await directly)::

    await notification_service.notify_credential_expiring(
        db, chw_id, "CHW Certificate", expires_on
    )
"""

import logging
from datetime import date, datetime
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.notifications import NotificationPayload, notify_user

logger = logging.getLogger("compass.notifications")


async def notify_request_accepted(
    db: AsyncSession,
    member_id: UUID,
    chw_first_name: str,
    request_id: UUID,
    session_id: UUID,
) -> None:
    """Notify a member that a CHW has accepted their service request.

    Fired from ``accept_request`` after the DB commit. Runs in a
    BackgroundTask so it never delays the HTTP response.

    Args:
        db: Active async DB session (passed through from the request scope).
        member_id: UUID of the member who submitted the request.
        chw_first_name: First name of the accepting CHW — used in the body
            only (no clinical context, HIPAA-safe).
        request_id: UUID of the accepted ``ServiceRequest``.
        session_id: UUID of the auto-created ``Session``.
    """
    try:
        await notify_user(
            db,
            member_id,
            NotificationPayload(
                user_id=member_id,
                title="Your request was accepted",
                body=f"{chw_first_name} will reach out soon to schedule your session.",
                deeplink=f"compasschw://sessions/{session_id}",
                category="request.accepted",
                data={
                    "type": "request_accepted",
                    "request_id": str(request_id),
                    "session_id": str(session_id),
                },
            ),
        )
        logger.info(
            "notify_request_accepted sent | member=%s request=%s session=%s",
            member_id,
            request_id,
            session_id,
        )
    except Exception:  # noqa: BLE001
        logger.warning(
            "notify_request_accepted failed | member=%s request=%s",
            member_id,
            request_id,
            exc_info=True,
        )


async def notify_session_scheduled(
    db: AsyncSession,
    recipient_user_id: UUID,
    other_party_name: str,
    session_id: UUID,
    scheduled_at: datetime | None,
) -> None:
    """Notify one party that a session has been scheduled.

    Call this twice from ``create_session`` — once for the CHW and once for
    the member — with the appropriate ``recipient_user_id`` and
    ``other_party_name`` each time.

    Args:
        db: Active async DB session.
        recipient_user_id: UUID of the user receiving the notification.
        other_party_name: First name of the other participant — used in the
            body only (no PHI).
        session_id: UUID of the scheduled ``Session``.
        scheduled_at: Scheduled start time (UTC). Omitted from the body if
            None to avoid leaking a bare ISO string to a non-technical user.
    """
    if scheduled_at is not None:
        # e.g. "Apr 22 at 3:00 PM" — no clinical detail
        time_str = scheduled_at.strftime("%-d %b at %-I:%M %p")
        body = f"A session with {other_party_name} has been scheduled for {time_str}."
    else:
        body = f"A session with {other_party_name} has been scheduled."

    try:
        await notify_user(
            db,
            recipient_user_id,
            NotificationPayload(
                user_id=recipient_user_id,
                title="Session scheduled",
                body=body,
                deeplink=f"compasschw://sessions/{session_id}",
                category="session.scheduled",
                data={
                    "type": "session_scheduled",
                    "session_id": str(session_id),
                },
            ),
        )
        logger.info(
            "notify_session_scheduled sent | recipient=%s session=%s",
            recipient_user_id,
            session_id,
        )
    except Exception:  # noqa: BLE001
        logger.warning(
            "notify_session_scheduled failed | recipient=%s session=%s",
            recipient_user_id,
            session_id,
            exc_info=True,
        )


async def notify_match_proposed(
    db: AsyncSession,
    chw_id: UUID,
    request_id: UUID,
    vertical: str,
) -> None:
    """Notify a CHW that a new request matching their profile is available.

    Currently not wired to any router — the matching flow is member-initiated
    (GET /matching/chws) with no push-to-CHW endpoint. This function is
    callable by a future matching engine or admin action.

    Args:
        db: Active async DB session.
        chw_id: UUID of the CHW to notify.
        request_id: UUID of the relevant ``ServiceRequest``.
        vertical: Service vertical string (e.g. "housing") — generic enough
            to include in the body without exposing PHI.
    """
    # Map raw vertical slugs to human-friendly labels
    vertical_label_map: dict[str, str] = {
        "housing": "housing",
        "rehab": "recovery support",
        "food": "food access",
        "mental_health": "mental health",
        "healthcare": "healthcare navigation",
    }
    label = vertical_label_map.get(vertical.lower(), vertical.replace("_", " "))

    try:
        await notify_user(
            db,
            chw_id,
            NotificationPayload(
                user_id=chw_id,
                title="New request available",
                body=f"A member in your area needs {label} support. Tap to review.",
                deeplink=f"compasschw://requests/{request_id}",
                category="match.proposed",
                data={
                    "type": "match_proposed",
                    "request_id": str(request_id),
                    "vertical": vertical,
                },
            ),
        )
        logger.info(
            "notify_match_proposed sent | chw=%s request=%s vertical=%s",
            chw_id,
            request_id,
            vertical,
        )
    except Exception:  # noqa: BLE001
        logger.warning(
            "notify_match_proposed failed | chw=%s request=%s",
            chw_id,
            request_id,
            exc_info=True,
        )


async def notify_credential_expiring(
    db: AsyncSession,
    chw_id: UUID,
    credential_type: str,
    expires_on: date,
) -> None:
    """Warn a CHW that a credential is approaching its expiry date.

    Called by the daily ``check_expiring_credentials`` scheduler job for each
    ``CHWCredentialValidation`` row whose ``expiry_date`` falls within the
    next 30 days and whose ``validation_status`` is ``"verified"``.

    The notification body is intentionally generic — no PHI, no clinical
    detail — per HIPAA 45 CFR §164.514.

    Args:
        db: Active async DB session.
        chw_id: UUID of the CHW whose credential is expiring.
        credential_type: Human-readable credential name (e.g. "CHW Certificate").
            Must not include clinical or patient data.
        expires_on: Expiry date (calendar date, not datetime).
    """
    logger.info(
        "notify_credential_expiring | chw=%s credential_type=%s expires_on=%s",
        chw_id,
        credential_type,
        expires_on.isoformat(),
    )

    days_remaining = (expires_on - date.today()).days
    expire_str = expires_on.strftime("%-d %b %Y")
    # Generic copy — no PHI, no clinical context (HIPAA §164.514)
    body = (
        f"Your {credential_type} expires in {days_remaining} day(s) ({expire_str}). "
        "Tap to renew."
    )

    try:
        await notify_user(
            db,
            chw_id,
            NotificationPayload(
                user_id=chw_id,
                title="Credential expiring soon",
                body=body,
                deeplink="compasschw://profile/credentials",
                category="credential.expiring",
                data={
                    "type": "credential_expiring",
                    "credential_type": credential_type,
                    "expires_on": expires_on.isoformat(),
                },
            ),
        )
        logger.info(
            "notify_credential_expiring sent | chw=%s credential_type=%s days_remaining=%d",
            chw_id,
            credential_type,
            days_remaining,
        )
    except Exception:  # noqa: BLE001
        logger.warning(
            "notify_credential_expiring failed | chw=%s credential_type=%s",
            chw_id,
            credential_type,
            exc_info=True,
        )
