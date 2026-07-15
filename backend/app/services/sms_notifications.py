"""Wave-2 Agent B3 — always-on SMS notifications (session reminders + CHW event alerts).

Four best-effort SMS notification types, each with its own public function
below. None of these ever raise — every call site (a scheduler job, a
request-creation endpoint, a message-send endpoint, or the payout trigger)
must be able to fire-and-forget without risking the triggering request/job.
Every internal failure (missing user, ineligible recipient, Vonage error, DB
error) is caught and logged; callers only need to await the coroutine.

  1. ``send_session_reminder_sms``  — 24h/1h-before reminder to the CHW AND
     the member (member gated by ``check_sms_eligibility``; CHW gated only by
     having a phone on file — there is no CHW phone-verification flow today).
     Called by the new ``app.services.scheduler`` job, which owns the DB-
     column dedupe (``Session.reminder_24h_sent_at`` / ``reminder_1h_sent_at``)
     so a send is attempted, and the column stamped, at most once per session
     per window.
  2. ``send_new_request_sms``       — alerts a CHW that a member has directed
     a service request at them (Schedule-with-X targeted flow only — an
     un-targeted request has no single CHW to alert; see
     ``app.routers.requests.create_request``).
  3. ``send_new_message_sms``       — alerts a CHW that a member sent an
     in-app message, throttled to at most 1 SMS per conversation per 30
     minutes via ``Conversation.member_message_sms_alert_last_sent_at``
     (smallest-footprint design — see that column's docstring / migration
     smsnotif0714 for why a single timestamp suffices over a dedicated
     throttle table).
  4. ``send_payout_initiated_sms``  — alerts a CHW that a Stripe transfer for
     their earnings has been initiated. Called from
     ``app.routers.payments.trigger_chw_payout`` immediately after a
     successful ``provider.transfer(...)`` call.

Message copy: no PHI. Names only (first name), no health information, no
vertical/service-category strings anywhere in a message body — every
function here is covered by a no-PHI regression assertion in
``tests/test_sms_notifications.py``.

CHW phone note: unlike members (gated by ``check_sms_eligibility`` — verified
phone, not opted out, not the sentinel placeholder, not a duplicate), there is
no verification flow for CHW phone numbers today. We send whenever
``User.phone`` is a non-empty, non-sentinel value. This is intentionally
looser than the member gate; a follow-up CHW phone-verification flow should
tighten this the same way member SMS is gated.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("compass.sms_notifications")

# Throttle window for the "new message from member" CHW alert — at most one
# SMS per conversation within this rolling window.
_MESSAGE_ALERT_THROTTLE = timedelta(minutes=30)


def _first_name(full_name: str | None, fallback: str = "your contact") -> str:
    """Return the first whitespace-delimited token of a name, or a safe fallback."""
    if not full_name or not full_name.strip():
        return fallback
    return full_name.strip().split()[0]


def _format_local_time(scheduled_at: datetime | None) -> str:
    """Render ``scheduled_at`` as a clinic-local 'h:mm AM/PM' label.

    Reuses the same ``to_clinic_local`` conversion (CLINIC_TZ_NAME) as
    ``app.services.scheduler._format_local_time`` and the in-thread
    scheduling messages, so every session-time surface — push, SMS, in-app —
    renders the same wall-clock time from a single source of truth.
    """
    if scheduled_at is None:
        return "the scheduled time"
    from app.services.availability import to_clinic_local

    local = to_clinic_local(scheduled_at)
    return local.strftime("%I:%M %p").lstrip("0")


def _format_local_datetime(scheduled_at: datetime | None) -> str:
    """Render a full clinic-local 'Mon, Jul 20 at 2:00 PM' label.

    Same ``to_clinic_local`` source of truth as ``_format_local_time`` and the
    reminder/scheduling surfaces, so every session-time string renders the same
    wall-clock time. Used by the session-confirmed and rescheduled confirmation
    SMS bodies (Spec 1 §3).
    """
    if scheduled_at is None:
        return "the scheduled time"
    from app.services.availability import to_clinic_local

    local = to_clinic_local(scheduled_at)
    day = local.strftime("%a, %b %d")
    time = local.strftime("%I:%M %p").lstrip("0")
    return f"{day} at {time}"


def _format_local_date(scheduled_at: datetime | None) -> str:
    """Render a clinic-local 'Jul 20' date label for the cancelled-session SMS."""
    if scheduled_at is None:
        return "recent"
    from app.services.availability import to_clinic_local

    return to_clinic_local(scheduled_at).strftime("%b %d")


def _is_sendable_chw_phone(phone: str | None) -> str | None:
    """Return a normalized E.164 CHW phone, or None if not sendable.

    CHWs have no phone-verification flow (see module docstring), so this is
    deliberately looser than ``check_sms_eligibility``: it only normalizes
    and rejects the shared sentinel placeholder number, mirroring the
    non-verification-related checks that member eligibility also performs.
    """
    from app.services.sms_eligibility import SENTINEL_PHONE_E164, normalize_phone_e164

    normalized = normalize_phone_e164(phone)
    if not normalized or normalized == SENTINEL_PHONE_E164:
        return None
    return normalized


async def _send_best_effort(
    to_e164: str,
    body: str,
    *,
    context: str,
    db: AsyncSession | None = None,
    member_profile=None,
) -> bool:
    """Send one SMS via the shared Vonage Messages client; never raises.

    Returns True on a successful send, False on any failure (logged here).

    STOP-prompt cadence (SMS Output Spec 1 §2): for MEMBER-facing sends, the
    caller passes both ``db`` and ``member_profile`` so the branded body is
    routed through ``with_stop_prompt`` — the opt-out line is appended (and the
    member's stamp updated) on the first send per rolling 24h window. CHW-facing
    sends (new-request / new-message / payout alerts) omit both kwargs and their
    behavior is unchanged — no opt-out line, no member-profile stamp.
    """
    from app.routers.conversations import brand_outbound_sms
    from app.services.vonage_sms import get_vonage_sms_messages_client

    try:
        branded = brand_outbound_sms(body)
        if db is not None and member_profile is not None:
            from app.routers.conversations import with_stop_prompt

            branded = await with_stop_prompt(db, member_profile, branded)
        client = get_vonage_sms_messages_client()
        result = await client.send_text(to_e164, branded)
    except Exception as exc:  # noqa: BLE001
        logger.error("sms_notifications: %s send raised error=%s", context, exc)
        return False

    if not result.success:
        logger.error(
            "sms_notifications: %s send failed error=%s status=%s",
            context, result.error, result.status_code,
        )
        return False

    logger.info("sms_notifications: %s sent", context)
    return True


# ─── 1. Session reminders (24h / 1h) ────────────────────────────────────────


async def send_session_reminder_sms(
    db: AsyncSession,
    *,
    session_id: UUID,
    chw_id: UUID,
    member_id: UUID,
    scheduled_at: datetime | None,
    window: str,
) -> bool:
    """Send a 24h- or 1h-before reminder SMS to the CHW and (if eligible) the member.

    Args:
        db: Active async session — used to look up the CHW/member User rows
            and the member's MemberProfile for eligibility checking.
        session_id: The Session this reminder is for (logging only).
        chw_id: The CHW's User.id. Sent to whenever the CHW has a sendable
            phone on file (see ``_is_sendable_chw_phone``) — never blocks the
            member's reminder.
        member_id: The member's User.id. Sent to only when
            ``check_sms_eligibility`` passes.
        scheduled_at: The session's scheduled start time, used to render the
            clinic-local time in the message body.
        window: Either "24h" or "1h" — selects the message copy. Any other
            value is treated as a defensive no-op (logged, nothing sent).

    Returns:
        True when the reminder was fully handled with no *transient*
        failures (each leg either sent successfully or was legitimately
        skipped — missing phone, ineligible, opted out) — the caller (the
        scheduler job) should stamp its dedupe column in this case so we
        never resend to a leg that intentionally has no phone/eligibility.
        False when at least one leg hit a transient failure (DB error,
        Vonage error) — the caller should NOT stamp the dedupe column, so
        the next scheduler run retries.

    Never raises — every failure (missing user/profile, ineligible member,
    Vonage error) is caught and logged.
    """
    if window not in ("24h", "1h"):
        logger.error(
            "sms_notifications: send_session_reminder_sms called with invalid "
            "window=%r session=%s", window, session_id,
        )
        return False

    from app.models.user import MemberProfile, User
    from app.services.sms_eligibility import check_sms_eligibility

    local_time = _format_local_time(scheduled_at)
    transient_failure = False

    try:
        chw_user = await db.get(User, chw_id)
        member_user = await db.get(User, member_id)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "sms_notifications: reminder lookup failed session=%s error=%s",
            session_id, exc,
        )
        return False

    # CHW leg — independent of the member leg below; one failing must not
    # block the other.
    if chw_user is not None:
        chw_phone = _is_sendable_chw_phone(chw_user.phone)
        if chw_phone is not None:
            member_first = _first_name(member_user.name if member_user else None, "your member")
            if window == "24h":
                body = f"Reminder — you have a session with {member_first} tomorrow at {local_time}."
            else:
                body = f"Reminder — you have a session with {member_first} in 1 hour at {local_time}."
            chw_sent = await _send_best_effort(
                chw_phone, body, context=f"session_reminder_{window}_chw session={session_id}"
            )
            if not chw_sent:
                transient_failure = True
    else:
        logger.warning(
            "sms_notifications: CHW user not found session=%s chw=%s", session_id, chw_id
        )

    # Member leg — gated by full SMS eligibility.
    if member_user is None:
        logger.warning(
            "sms_notifications: member user not found session=%s member=%s",
            session_id, member_id,
        )
        return not transient_failure

    try:
        profile_result = await db.execute(
            select(MemberProfile).where(MemberProfile.user_id == member_id)
        )
        member_profile = profile_result.scalar_one_or_none()
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "sms_notifications: member profile lookup failed session=%s error=%s",
            session_id, exc,
        )
        return False

    if member_profile is None:
        logger.warning(
            "sms_notifications: member profile not found session=%s member=%s",
            session_id, member_id,
        )
        return not transient_failure

    try:
        eligibility = await check_sms_eligibility(
            db, member_user=member_user, member_profile=member_profile
        )
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "sms_notifications: eligibility check failed session=%s error=%s",
            session_id, exc,
        )
        return False

    if not eligibility.eligible or eligibility.normalized_phone is None:
        logger.debug(
            "sms_notifications: member not SMS-eligible for reminder session=%s reason=%s",
            session_id, eligibility.reason_code,
        )
        return not transient_failure

    # Kill switch (Spec 1 §5): the member leg is member-facing SMS, so it is
    # gated by ``sms_mirroring_enabled``. The CHW leg above is NOT — CHW alerts
    # are operational, not member messaging, and stay on regardless.
    from app.config import settings

    if not settings.sms_mirroring_enabled:
        logger.info(
            "sms_notifications: member reminder skipped (sms_mirroring_enabled off) "
            "session=%s",
            session_id,
        )
        return not transient_failure

    chw_first = _first_name(chw_user.name if chw_user else None, "your CHW")
    if window == "24h":
        body = f"Reminder — you have a session with {chw_first} tomorrow at {local_time}."
    else:
        body = f"Reminder — you have a session with {chw_first} in 1 hour at {local_time}."
    member_sent = await _send_best_effort(
        eligibility.normalized_phone,
        body,
        context=f"session_reminder_{window}_member session={session_id}",
        db=db,
        member_profile=member_profile,
    )
    if not member_sent:
        transient_failure = True

    return not transient_failure


# ─── 2. New member request ──────────────────────────────────────────────────


async def send_new_request_sms(
    db: AsyncSession,
    *,
    chw_id: UUID,
    member_id: UUID,
) -> None:
    """Alert a CHW by SMS that a member has directed a service request at them.

    Only meaningful for the Schedule-with-X targeted flow (``target_chw_id``
    set) — an un-targeted request has no single CHW to alert, since it only
    becomes visible in a CHW's "incoming" list once targeted. See
    ``app.routers.requests.create_request``.

    Never raises.
    """
    from app.models.user import User

    try:
        chw_user = await db.get(User, chw_id)
        member_user = await db.get(User, member_id)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "sms_notifications: new_request lookup failed chw=%s member=%s error=%s",
            chw_id, member_id, exc,
        )
        return

    if chw_user is None:
        logger.warning("sms_notifications: CHW user not found for new_request chw=%s", chw_id)
        return

    chw_phone = _is_sendable_chw_phone(chw_user.phone)
    if chw_phone is None:
        logger.debug(
            "sms_notifications: CHW has no sendable phone, skipping new_request alert chw=%s",
            chw_id,
        )
        return

    member_first = _first_name(member_user.name if member_user else None, "A member")
    body = f"New member request from {member_first}. Open Compass to respond."
    await _send_best_effort(chw_phone, body, context=f"new_request chw={chw_id}")


# ─── 3. New message from a member (throttled) ───────────────────────────────


async def send_new_message_sms(
    db: AsyncSession,
    *,
    conversation_id: UUID,
    chw_id: UUID,
    member_id: UUID,
    now: datetime | None = None,
) -> None:
    """Alert a CHW by SMS that a member sent them an in-app message.

    Throttled to at most one SMS per conversation per 30 minutes via
    ``Conversation.member_message_sms_alert_last_sent_at`` — see that
    column's docstring (migration smsnotif0714) for the design rationale.
    Commits the throttle stamp itself so the caller doesn't need to.

    Args:
        db: Active async session — the SAME request-scoped session used by
            the calling endpoint, per this codebase's BackgroundTask
            convention (mirrors ``_fanout_sms_for_chw_message``).
        conversation_id: The conversation the member's message was posted to.
        chw_id: The CHW's User.id (recipient of the alert).
        member_id: The member's User.id (message sender).
        now: Reference time for the throttle window; defaults to
            ``datetime.now(UTC)``. Exposed as a parameter so tests can pin
            time deterministically instead of racing the wall clock.

    Never raises.
    """
    from app.models.conversation import Conversation
    from app.models.user import User

    if now is None:
        now = datetime.now(UTC)

    try:
        conv = await db.get(Conversation, conversation_id)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "sms_notifications: new_message conversation lookup failed conversation=%s error=%s",
            conversation_id, exc,
        )
        return

    if conv is None:
        logger.warning(
            "sms_notifications: conversation not found for new_message conversation=%s",
            conversation_id,
        )
        return

    last_sent = conv.member_message_sms_alert_last_sent_at
    if last_sent is not None:
        # Defensive: DB rows may come back naive depending on driver/test
        # setup; normalize to UTC-aware before comparing.
        if last_sent.tzinfo is None:
            last_sent = last_sent.replace(tzinfo=UTC)
        if now - last_sent < _MESSAGE_ALERT_THROTTLE:
            logger.debug(
                "sms_notifications: new_message alert throttled conversation=%s "
                "last_sent=%s now=%s",
                conversation_id, last_sent, now,
            )
            return

    try:
        chw_user = await db.get(User, chw_id)
        member_user = await db.get(User, member_id)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "sms_notifications: new_message user lookup failed conversation=%s error=%s",
            conversation_id, exc,
        )
        return

    if chw_user is None:
        logger.warning(
            "sms_notifications: CHW user not found for new_message conversation=%s chw=%s",
            conversation_id, chw_id,
        )
        return

    chw_phone = _is_sendable_chw_phone(chw_user.phone)
    if chw_phone is None:
        logger.debug(
            "sms_notifications: CHW has no sendable phone, skipping new_message alert "
            "conversation=%s chw=%s",
            conversation_id, chw_id,
        )
        return

    member_first = _first_name(member_user.name if member_user else None, "A member")
    body = f"{member_first} sent you a message. Reply in the Compass app."
    sent = await _send_best_effort(
        chw_phone, body, context=f"new_message conversation={conversation_id}"
    )
    if not sent:
        return

    # Stamp the throttle only on a successful send, and only after send
    # succeeds — a failed send should not block the next attempt from
    # retrying within the window.
    try:
        conv.member_message_sms_alert_last_sent_at = now
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "sms_notifications: failed to stamp throttle conversation=%s error=%s",
            conversation_id, exc,
        )
        try:
            await db.rollback()
        except Exception as rollback_exc:  # noqa: BLE001
            logger.error(
                "sms_notifications: rollback also failed conversation=%s error=%s",
                conversation_id, rollback_exc,
            )


# ─── 4. Payout initiated ────────────────────────────────────────────────────


async def send_payout_initiated_sms(
    db: AsyncSession,
    *,
    chw_id: UUID,
    amount_cents: int,
) -> None:
    """Alert a CHW by SMS that a payout has been initiated to their bank account.

    Args:
        db: Active async session.
        chw_id: The CHW's User.id.
        amount_cents: The transfer amount in cents (matches
            ``TransferRequest.amount_cents`` in app.routers.payments) — this
            function is responsible for formatting it as a dollar amount.

    Never raises.
    """
    from app.models.user import User

    try:
        chw_user = await db.get(User, chw_id)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "sms_notifications: payout lookup failed chw=%s error=%s", chw_id, exc
        )
        return

    if chw_user is None:
        logger.warning("sms_notifications: CHW user not found for payout chw=%s", chw_id)
        return

    chw_phone = _is_sendable_chw_phone(chw_user.phone)
    if chw_phone is None:
        logger.debug(
            "sms_notifications: CHW has no sendable phone, skipping payout alert chw=%s",
            chw_id,
        )
        return

    amount = (Decimal(amount_cents) / Decimal(100)).quantize(Decimal("0.01"))
    body = f"A payout of ${amount} has been initiated to your bank account."
    await _send_best_effort(chw_phone, body, context=f"payout_initiated chw={chw_id}")


# ─── 5. Session confirmations (member-facing, Spec 1 §3) ────────────────────
#
# Three best-effort member confirmation texts, hooked beside the existing
# email/push trigger at each transition so channels can't drift:
#   - request received   (POST /requests/           — member ack)
#   - session confirmed  (accept + confirm transitions)
#   - session changed    (cancel + reschedule transitions)
#
# All follow the same discipline as the notifications above: never raise,
# gated by check_sms_eligibility AND sms_mirroring_enabled, no PHI beyond the
# CHW's first name + a session date/time. Like send_session_reminder_sms they
# write no CommunicationTouch (touches are for direct CHW<->member comms, not
# transactional notifications). The STOP-prompt line rides along via
# ``_send_best_effort``'s db/member_profile kwargs (first send per 24h window).


async def _send_member_confirmation(
    db: AsyncSession,
    *,
    member_user,
    member_profile,
    body: str,
    context: str,
) -> None:
    """Shared member-facing confirmation send: flag + eligibility gate, send,
    touch-log, commit. Never raises.

    Args:
        db: Active async session (the caller's request-scoped session).
        member_user: The recipient member's User row.
        member_profile: The recipient member's MemberProfile row.
        body: The message body (no brand prefix — added downstream; no PHI
            beyond first name + session date/time).
        context: Stable log/label tag, e.g. ``"request_received member=<id>"``.

    Follows ``send_session_reminder_sms``'s member-notification pattern: no
    ``CommunicationTouch`` is written (touches are reserved for direct
    CHW<->member comms in conversations.py; transactional notifications like
    reminders and these confirmations are not audit-logged as touches). A
    successful send does commit, solely to persist the ``last_stop_prompt_at``
    stamp that ``with_stop_prompt`` set — the endpoint already committed its
    own business change before this hook ran, so this commit only carries the
    cadence stamp.
    """
    from app.config import settings
    from app.services.sms_eligibility import check_sms_eligibility

    try:
        # Kill switch (Spec 1 §5) — member-facing SMS only; OTP is never gated.
        if not settings.sms_mirroring_enabled:
            logger.info(
                "sms_notifications: %s skipped (sms_mirroring_enabled off)", context
            )
            return

        eligibility = await check_sms_eligibility(
            db, member_user=member_user, member_profile=member_profile
        )
        if not eligibility.eligible or eligibility.normalized_phone is None:
            logger.debug(
                "sms_notifications: %s member not SMS-eligible reason=%s",
                context, eligibility.reason_code,
            )
            return

        sent = await _send_best_effort(
            eligibility.normalized_phone,
            body,
            context=context,
            db=db,
            member_profile=member_profile,
        )
        if not sent:
            return

        # Persist the STOP-prompt cadence stamp that with_stop_prompt set.
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        # Best-effort: a confirmation SMS must never fail its parent transition
        # (request create, schedule confirm/cancel/reschedule).
        logger.error("sms_notifications: %s raised error=%s", context, exc)
        try:
            await db.rollback()
        except Exception as rollback_exc:  # noqa: BLE001
            logger.error(
                "sms_notifications: %s rollback also failed error=%s",
                context, rollback_exc,
            )


async def send_request_received_sms(
    db: AsyncSession,
    *,
    member_user,
    member_profile,
    chw_first_name: str,
) -> None:
    """Text the member that their session request was received. Never raises."""
    body = (
        f"We got your session request — {chw_first_name} will confirm a time shortly."
    )
    await _send_member_confirmation(
        db,
        member_user=member_user,
        member_profile=member_profile,
        body=body,
        context=f"request_received member={member_user.id}",
    )


async def send_session_confirmed_sms(
    db: AsyncSession,
    *,
    member_user,
    member_profile,
    chw_first_name: str,
    scheduled_at: datetime | None,
) -> None:
    """Text the member that their session is confirmed for a time. Never raises."""
    body = (
        f"Your session with {chw_first_name} is confirmed for "
        f"{_format_local_datetime(scheduled_at)}."
    )
    await _send_member_confirmation(
        db,
        member_user=member_user,
        member_profile=member_profile,
        body=body,
        context=f"session_confirmed member={member_user.id}",
    )


async def send_session_changed_sms(
    db: AsyncSession,
    *,
    member_user,
    member_profile,
    old_scheduled_at: datetime | None,
    new_scheduled_at: datetime | None,
    cancelled: bool,
) -> None:
    """Text the member that their session was cancelled or rescheduled.

    ``cancelled=True`` → "Your {Jul 20} session was cancelled." (uses
    ``old_scheduled_at``). ``cancelled=False`` → "Your session moved to {Mon,
    Jul 20 at 2:00 PM}." (uses ``new_scheduled_at``). Never raises.
    """
    if cancelled:
        body = f"Your {_format_local_date(old_scheduled_at)} session was cancelled."
        context = f"session_cancelled member={member_user.id}"
    else:
        body = f"Your session moved to {_format_local_datetime(new_scheduled_at)}."
        context = f"session_rescheduled member={member_user.id}"
    await _send_member_confirmation(
        db,
        member_user=member_user,
        member_profile=member_profile,
        body=body,
        context=context,
    )
