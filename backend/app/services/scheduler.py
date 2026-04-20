"""Background task scheduler for CompassCHW.

Runs inside the FastAPI process (single-instance deploy). Uses APScheduler
with the AsyncIO executor — no external Redis/Celery required for MVP scale.

Scheduled jobs:
  - session_reminder — every 2 minutes, sends push notifications to members
    whose session starts in 14-16 minutes.
  - claim_retry      — every 10 minutes, retries failed Pear Suite claims.

For horizontal scaling (multi-instance), replace with APScheduler's
SQLAlchemyJobStore or migrate to Celery Beat with a shared Redis broker.
For now, a single-instance deploy with advisory locks is sufficient.
"""

import logging
from datetime import UTC, datetime, timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import and_, select

logger = logging.getLogger("compass.scheduler")

_scheduler: AsyncIOScheduler | None = None


async def send_session_reminders() -> None:
    """Notify members about sessions starting in ~15 minutes.

    Windows the scan to [14, 16] minutes-from-now to catch sessions the
    2-minute scheduler cadence would otherwise miss. Tracks which sessions
    have been reminded via a simple in-memory set (lost on process restart;
    acceptable because the overlap window is small).
    """
    from app.database import async_session
    from app.models.session import Session
    from app.services.notifications import NotificationPayload, notify_user

    now = datetime.now(UTC)
    window_start = now + timedelta(minutes=14)
    window_end = now + timedelta(minutes=16)

    async with async_session() as db:
        result = await db.execute(
            select(Session)
            .where(
                and_(
                    Session.status == "scheduled",
                    Session.scheduled_at >= window_start,
                    Session.scheduled_at <= window_end,
                )
            )
        )
        upcoming = list(result.scalars().all())

        for session in upcoming:
            key = f"reminded:{session.id}"
            if key in _reminded_sessions:
                continue

            # Notify both parties — each gets a different message
            try:
                await notify_user(
                    db,
                    session.member_id,
                    NotificationPayload(
                        user_id=session.member_id,
                        title="Your session starts soon",
                        body="Your session with your CHW begins in 15 minutes.",
                        deeplink=f"compasschw://sessions/{session.id}",
                        category="session.reminder",
                        data={"session_id": str(session.id)},
                    ),
                )
                await notify_user(
                    db,
                    session.chw_id,
                    NotificationPayload(
                        user_id=session.chw_id,
                        title="Upcoming session",
                        body="Your session starts in 15 minutes. Don't forget to tap Start when you begin.",
                        deeplink=f"compasschw://sessions/{session.id}",
                        category="session.reminder",
                        data={"session_id": str(session.id)},
                    ),
                )
                _reminded_sessions.add(key)
            except Exception as e:  # noqa: BLE001
                logger.warning("Failed to send session reminder for %s: %s", session.id, e)


async def retry_pending_claims() -> None:
    """Retry Pear Suite claim submissions that failed at session-completion time.

    We look for BillingClaim rows with status='pending' and no pear_suite_claim_id,
    where created_at is within the last 7 days (stale claims likely need manual review).
    """
    from decimal import Decimal

    from app.database import async_session
    from app.models.billing import BillingClaim
    from app.services.billing import ClaimSubmission, get_billing_provider

    cutoff = datetime.now(UTC) - timedelta(days=7)
    async with async_session() as db:
        result = await db.execute(
            select(BillingClaim)
            .where(BillingClaim.status == "pending")
            .where(BillingClaim.pear_suite_claim_id.is_(None))
            .where(BillingClaim.created_at >= cutoff)
            .limit(25)  # Batch cap per run
        )
        claims = list(result.scalars().all())

        if not claims:
            return

        provider = get_billing_provider()
        for claim in claims:
            try:
                result = await provider.submit_claim(ClaimSubmission(
                    session_id=claim.session_id,
                    chw_id=claim.chw_id,
                    member_id=claim.member_id,
                    service_date=claim.service_date or claim.created_at.date(),
                    procedure_code=claim.procedure_code,
                    modifier=claim.modifier or "U2",
                    diagnosis_codes=claim.diagnosis_codes or [],
                    units=claim.units,
                    gross_amount=Decimal(str(claim.gross_amount)),
                ))
                if result.success and result.provider_claim_id:
                    claim.pear_suite_claim_id = result.provider_claim_id
                    claim.status = result.status
                    claim.submitted_at = datetime.now(UTC)
                    await db.commit()
                    logger.info("Claim retry succeeded: %s → %s", claim.id, result.provider_claim_id)
            except Exception as e:  # noqa: BLE001
                logger.warning("Claim retry failed for %s: %s", claim.id, e)


async def trigger_pending_payouts() -> None:
    """Transfer net payouts to CHWs for claims that have been adjudicated + paid.

    Called every 10 minutes. Looks for BillingClaim rows where:
      - status == 'paid' (Pear Suite has confirmed Medi-Cal payment)
      - stripe_transfer_id IS NULL (we haven't paid the CHW yet)
      - paid_at is within the last 30 days (older claims likely need manual review)

    Idempotent — trigger_chw_payout uses Stripe's idempotency key based on
    the billing_claim_id, so duplicate scheduler runs can't double-pay.
    """
    from app.database import async_session
    from app.models.billing import BillingClaim
    from app.routers.payments import trigger_chw_payout

    cutoff = datetime.now(UTC) - timedelta(days=30)
    async with async_session() as db:
        result = await db.execute(
            select(BillingClaim)
            .where(BillingClaim.status == "paid")
            .where(BillingClaim.stripe_transfer_id.is_(None))
            .where(BillingClaim.paid_at >= cutoff)
            .limit(25)
        )
        claims = list(result.scalars().all())
        if not claims:
            return

        for claim in claims:
            try:
                ok = await trigger_chw_payout(db, claim.id)
                if ok:
                    logger.info("CHW payout triggered for claim %s", claim.id)
                else:
                    logger.info(
                        "CHW payout deferred for claim %s (CHW not onboarded or zero amount)",
                        claim.id,
                    )
            except Exception as e:  # noqa: BLE001
                logger.warning("Payout trigger failed for claim %s: %s", claim.id, e)


# Module-level cache of reminded sessions — reset on process restart
_reminded_sessions: set[str] = set()


def start_scheduler() -> None:
    """Install and start the background scheduler.

    Called from the FastAPI lifespan startup event. Idempotent — safe to call
    multiple times; subsequent calls are no-ops.
    """
    global _scheduler
    if _scheduler is not None:
        return

    _scheduler = AsyncIOScheduler(timezone="UTC")

    _scheduler.add_job(
        send_session_reminders,
        "interval",
        minutes=2,
        id="session_reminders",
        max_instances=1,  # Prevent overlapping runs
        coalesce=True,    # If the scheduler fell behind, run once not N times
    )

    _scheduler.add_job(
        retry_pending_claims,
        "interval",
        minutes=10,
        id="claim_retry",
        max_instances=1,
        coalesce=True,
    )

    _scheduler.add_job(
        trigger_pending_payouts,
        "interval",
        minutes=10,
        id="payout_trigger",
        max_instances=1,
        coalesce=True,
    )

    _scheduler.start()
    logger.info("Scheduler started with %d jobs", len(_scheduler.get_jobs()))


def stop_scheduler() -> None:
    """Shut down the scheduler cleanly on app shutdown."""
    global _scheduler
    if _scheduler is None:
        return
    _scheduler.shutdown(wait=False)
    _scheduler = None
    logger.info("Scheduler stopped")
