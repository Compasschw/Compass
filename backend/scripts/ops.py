"""Operations CLI — the tools TJ uses to investigate and unstick production.

Every invocation writes an AuditLog row so we preserve the HIPAA audit trail
(raw SQL access against RDS bypasses it; this tool does not).

Usage:
    docker exec -w /code compass-api python -m scripts.ops <command> <args>

Commands:
    user <id-or-email>            Show a user's profile + activity summary.
    session <session-id>          Show a session's lifecycle + billing state.
    chw-payout <id-or-email>      Show a CHW's Stripe Connect status + earnings.
    requeue-claim <claim-id>      Re-submit a stuck claim to Pear Suite.
    retry-payout <claim-id>       Re-trigger Stripe transfer for a paid claim.

Non-mutating commands (user, session, chw-payout) run immediately.
Mutating commands (requeue-claim, retry-payout) require --yes to actually act;
otherwise they print what they would do and exit.

The "operator" identifier is taken from --operator (defaults to the
OPERATOR_EMAIL env var, then to 'cli'). This string is recorded in audit log
entries so we can tell who ran what.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models.audit import AuditLog
from app.models.billing import BillingClaim
from app.models.session import Session as SessionModel
from app.models.user import CHWProfile, User

logger = logging.getLogger("compass.ops_cli")


# ─── Output helpers ──────────────────────────────────────────────────────────


def _bold(s: str) -> str:
    return f"\033[1m{s}\033[0m"


def _dim(s: str) -> str:
    return f"\033[2m{s}\033[0m"


def _green(s: str) -> str:
    return f"\033[32m{s}\033[0m"


def _yellow(s: str) -> str:
    return f"\033[33m{s}\033[0m"


def _red(s: str) -> str:
    return f"\033[31m{s}\033[0m"


def _print_section(title: str) -> None:
    print(f"\n{_bold(title)}")
    print("─" * len(title))


def _kv(label: str, value: Any, dim_if_none: bool = True) -> None:
    """Print a single key/value line, dimming None values for readability."""
    val_str = str(value) if value is not None else "(none)"
    if value is None and dim_if_none:
        val_str = _dim(val_str)
    print(f"  {label:<24} {val_str}")


def _fatal(msg: str, code: int = 1) -> None:
    print(_red(f"ERROR: {msg}"), file=sys.stderr)
    sys.exit(code)


# ─── Audit logging ───────────────────────────────────────────────────────────


async def _audit(
    db: AsyncSession,
    *,
    operator: str,
    action: str,
    resource: str,
    resource_id: str | None,
    details: dict | None = None,
) -> None:
    """Record a CLI action in audit_log.

    We pass the operator identifier into the `details` JSONB since the audit
    schema uses a nullable user_id FK and CLI operators aren't User rows.
    """
    db.add(
        AuditLog(
            user_id=None,
            action=action,
            resource=resource,
            resource_id=resource_id,
            ip_address=None,
            user_agent=f"ops-cli/{operator}",
            details={"operator": operator, **(details or {})},
        )
    )
    await db.commit()


# ─── Lookup helpers ──────────────────────────────────────────────────────────


def _is_uuid(s: str) -> bool:
    try:
        uuid.UUID(s)
        return True
    except ValueError:
        return False


async def _find_user(db: AsyncSession, id_or_email: str) -> User | None:
    """Resolve a user by UUID or email. Case-insensitive on email."""
    if _is_uuid(id_or_email):
        return await db.get(User, uuid.UUID(id_or_email))
    result = await db.execute(
        select(User).where(func.lower(User.email) == id_or_email.lower())
    )
    return result.scalar_one_or_none()


# ─── Command: user ───────────────────────────────────────────────────────────


@dataclass
class UserSummary:
    user: User
    session_count: int
    claim_count: int
    last_login: datetime | None


async def _user_summary(db: AsyncSession, user: User) -> UserSummary:
    sessions_q = await db.execute(
        select(func.count(SessionModel.id)).where(
            (SessionModel.chw_id == user.id) | (SessionModel.member_id == user.id)
        )
    )
    claims_q = await db.execute(
        select(func.count(BillingClaim.id)).where(
            (BillingClaim.chw_id == user.id) | (BillingClaim.member_id == user.id)
        )
    )
    # Last login proxy: most recent audit log entry attributed to this user
    last_q = await db.execute(
        select(AuditLog.created_at)
        .where(AuditLog.user_id == user.id)
        .order_by(AuditLog.created_at.desc())
        .limit(1)
    )
    return UserSummary(
        user=user,
        session_count=sessions_q.scalar_one(),
        claim_count=claims_q.scalar_one(),
        last_login=last_q.scalar_one_or_none(),
    )


async def cmd_user(db: AsyncSession, id_or_email: str, operator: str) -> int:
    user = await _find_user(db, id_or_email)
    if user is None:
        _fatal(f"No user found matching {id_or_email!r}")

    summary = await _user_summary(db, user)

    _print_section(f"User — {user.email}")
    _kv("ID", user.id)
    _kv("Role", user.role)
    _kv("Name", user.name)
    _kv("Phone", user.phone)
    _kv("Active", user.is_active)
    _kv("Onboarded", user.is_onboarded)
    _kv("Created", user.created_at)
    _kv("Last audit activity", summary.last_login)

    _print_section("Activity")
    _kv("Sessions (any role)", summary.session_count)
    _kv("Billing claims (any role)", summary.claim_count)

    await _audit(
        db,
        operator=operator,
        action="ops_cli.user_view",
        resource="user",
        resource_id=str(user.id),
    )
    return 0


# ─── Command: session ────────────────────────────────────────────────────────


async def cmd_session(db: AsyncSession, session_id: str, operator: str) -> int:
    if not _is_uuid(session_id):
        _fatal(f"{session_id!r} is not a valid UUID")

    s = await db.get(SessionModel, uuid.UUID(session_id))
    if s is None:
        _fatal(f"No session with id {session_id}")

    _print_section(f"Session — {s.id}")
    _kv("Status", s.status)
    _kv("Vertical", s.vertical)
    _kv("Mode", s.mode)
    _kv("CHW", s.chw_id)
    _kv("Member", s.member_id)
    _kv("Scheduled at", s.scheduled_at)
    _kv("Started at", s.started_at)
    _kv("Ended at", s.ended_at)
    _kv("Duration (min)", s.duration_minutes)
    _kv("Suggested units", s.suggested_units)
    _kv("Units billed", s.units_billed)
    _kv("Gross amount", s.gross_amount)
    _kv("Net amount", s.net_amount)

    # Associated claim, if any
    claim_q = await db.execute(
        select(BillingClaim).where(BillingClaim.session_id == s.id)
    )
    claim = claim_q.scalar_one_or_none()

    _print_section("Billing claim")
    if claim is None:
        print(_dim("  (no claim exists for this session yet)"))
    else:
        _kv("Claim ID", claim.id)
        _kv("Status", claim.status)
        _kv("Service date", claim.service_date)
        _kv("Procedure", f"{claim.procedure_code} {claim.modifier}")
        _kv("Units", claim.units)
        _kv("Gross", claim.gross_amount)
        _kv("Platform fee", claim.platform_fee)
        _kv("Pear Suite fee", claim.pear_suite_fee)
        _kv("Net payout", claim.net_payout)
        _kv("Pear Suite claim ID", claim.pear_suite_claim_id)
        _kv("Submitted at", claim.submitted_at)
        _kv("Adjudicated at", claim.adjudicated_at)
        _kv("Paid at", claim.paid_at)
        _kv("Rejection reason", claim.rejection_reason)
        _kv("Stripe transfer ID", claim.stripe_transfer_id)
        _kv("Paid to CHW at", claim.paid_to_chw_at)

    await _audit(
        db,
        operator=operator,
        action="ops_cli.session_view",
        resource="session",
        resource_id=str(s.id),
    )
    return 0


# ─── Command: chw-payout ─────────────────────────────────────────────────────


async def cmd_chw_payout(db: AsyncSession, id_or_email: str, operator: str) -> int:
    user = await _find_user(db, id_or_email)
    if user is None:
        _fatal(f"No user found matching {id_or_email!r}")
    if user.role != "chw":
        _fatal(f"{user.email} is a {user.role}, not a CHW")

    profile_q = await db.execute(
        select(CHWProfile).where(CHWProfile.user_id == user.id)
    )
    profile = profile_q.scalar_one_or_none()
    if profile is None:
        _fatal(f"No CHWProfile for user {user.email}")

    _print_section(f"CHW payout status — {user.email}")
    _kv("CHW user ID", user.id)
    _kv("Stripe account ID", profile.stripe_connected_account_id)
    enabled_str = (
        _green("yes") if profile.stripe_payouts_enabled else _yellow("no")
    )
    _kv("Payouts enabled", enabled_str, dim_if_none=False)
    _kv("Details submitted", profile.stripe_details_submitted)

    # Lifetime earnings: sum of net_payout for paid claims to this CHW
    total_q = await db.execute(
        select(
            func.count(BillingClaim.id),
            func.coalesce(func.sum(BillingClaim.net_payout), Decimal("0")),
        ).where(
            BillingClaim.chw_id == user.id,
            BillingClaim.status == "paid",
        )
    )
    paid_count, paid_total = total_q.one()
    pending_q = await db.execute(
        select(func.count(BillingClaim.id)).where(
            BillingClaim.chw_id == user.id,
            BillingClaim.status.in_(["submitted", "accepted"]),
        )
    )

    _print_section("Earnings")
    _kv("Paid claims", paid_count)
    _kv("Lifetime paid ($)", paid_total)
    _kv("Pending claims", pending_q.scalar_one())

    # Recent Stripe transfers
    recent_q = await db.execute(
        select(BillingClaim)
        .where(
            BillingClaim.chw_id == user.id,
            BillingClaim.stripe_transfer_id.isnot(None),
        )
        .order_by(BillingClaim.paid_to_chw_at.desc().nullslast())
        .limit(5)
    )
    recent = recent_q.scalars().all()

    _print_section("Last 5 payouts")
    if not recent:
        print(_dim("  (no payouts yet)"))
    else:
        for c in recent:
            print(
                f"  · {c.paid_to_chw_at}  "
                f"${c.net_payout}  "
                f"claim={c.id}  "
                f"transfer={c.stripe_transfer_id}"
            )

    await _audit(
        db,
        operator=operator,
        action="ops_cli.chw_payout_view",
        resource="chw_profile",
        resource_id=str(profile.id),
    )
    return 0


# ─── Command: requeue-claim ──────────────────────────────────────────────────


async def cmd_requeue_claim(
    db: AsyncSession, claim_id: str, operator: str, confirmed: bool
) -> int:
    if not _is_uuid(claim_id):
        _fatal(f"{claim_id!r} is not a valid UUID")

    claim = await db.get(BillingClaim, uuid.UUID(claim_id))
    if claim is None:
        _fatal(f"No billing claim with id {claim_id}")

    _print_section(f"Re-queue claim — {claim.id}")
    _kv("Current status", claim.status)
    _kv("Pear Suite claim ID", claim.pear_suite_claim_id)
    _kv("Submitted at", claim.submitted_at)
    _kv("Rejection reason", claim.rejection_reason)

    if claim.status == "paid":
        _fatal("Claim is already paid — refusing to re-submit.", code=1)

    if not confirmed:
        print(
            _yellow(
                "\n  DRY-RUN. Re-add --yes to actually submit this claim through "
                "the billing provider."
            )
        )
        await _audit(
            db,
            operator=operator,
            action="ops_cli.requeue_claim_dryrun",
            resource="billing_claim",
            resource_id=str(claim.id),
        )
        return 0

    # Live submission path
    from app.services.billing import ClaimSubmission, get_billing_provider

    provider = get_billing_provider()
    submission = ClaimSubmission(
        session_id=claim.session_id,
        chw_id=claim.chw_id,
        member_id=claim.member_id,
        service_date=claim.service_date or datetime.now(UTC).date(),
        procedure_code=claim.procedure_code,
        modifier=claim.modifier,
        diagnosis_codes=list(claim.diagnosis_codes or []),
        units=claim.units,
        gross_amount=claim.gross_amount,
        chw_npi=None,
        notes=f"Re-queued by ops CLI ({operator}) at {datetime.now(UTC).isoformat()}.",
    )

    print(_dim("\n  Submitting to billing provider..."))
    result = await provider.submit_claim(submission)
    print(f"  result.success = {result.success}")
    print(f"  result.provider_claim_id = {result.provider_claim_id}")
    print(f"  result.status = {result.status}")
    print(f"  result.message = {result.message}")

    if result.success and result.provider_claim_id:
        claim.pear_suite_claim_id = result.provider_claim_id
        claim.status = "submitted"
        claim.submitted_at = datetime.now(UTC)
        claim.rejection_reason = None
        await db.commit()
        print(_green("\n  Claim state updated locally."))

    await _audit(
        db,
        operator=operator,
        action="ops_cli.requeue_claim",
        resource="billing_claim",
        resource_id=str(claim.id),
        details={
            "success": result.success,
            "provider_claim_id": result.provider_claim_id,
            "status": result.status,
        },
    )
    return 0 if result.success else 1


# ─── Command: retry-payout ───────────────────────────────────────────────────


async def cmd_retry_payout(
    db: AsyncSession, claim_id: str, operator: str, confirmed: bool
) -> int:
    if not _is_uuid(claim_id):
        _fatal(f"{claim_id!r} is not a valid UUID")

    claim = await db.get(BillingClaim, uuid.UUID(claim_id))
    if claim is None:
        _fatal(f"No billing claim with id {claim_id}")

    _print_section(f"Retry Stripe payout — {claim.id}")
    _kv("Claim status", claim.status)
    _kv("Net payout", claim.net_payout)
    _kv("Existing transfer ID", claim.stripe_transfer_id)

    if claim.status != "paid":
        _fatal(
            f"Claim status is {claim.status!r} (must be 'paid' before we can "
            "transfer to the CHW).",
            code=1,
        )

    if claim.stripe_transfer_id:
        _fatal(
            f"Claim already has a Stripe transfer ({claim.stripe_transfer_id}). "
            "Refusing to create a duplicate.",
            code=1,
        )

    if not confirmed:
        print(
            _yellow(
                "\n  DRY-RUN. Re-add --yes to actually initiate the Stripe "
                "transfer to the CHW's connected account."
            )
        )
        await _audit(
            db,
            operator=operator,
            action="ops_cli.retry_payout_dryrun",
            resource="billing_claim",
            resource_id=str(claim.id),
        )
        return 0

    from app.routers.payments import trigger_chw_payout

    print(_dim("\n  Calling trigger_chw_payout()..."))
    ok = await trigger_chw_payout(db, claim.id)
    print(f"  trigger_chw_payout returned: {ok}")

    await _audit(
        db,
        operator=operator,
        action="ops_cli.retry_payout",
        resource="billing_claim",
        resource_id=str(claim.id),
        details={"success": ok},
    )
    return 0 if ok else 1


# ─── CLI wiring ──────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ops",
        description="CompassCHW operations CLI.",
    )
    parser.add_argument(
        "--operator",
        default=os.environ.get("OPERATOR_EMAIL", "cli"),
        help="Identifier recorded in audit log (defaults to OPERATOR_EMAIL env var).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_user = sub.add_parser("user", help="Show a user's profile + activity.")
    p_user.add_argument("id_or_email")

    p_session = sub.add_parser("session", help="Show a session's lifecycle + billing state.")
    p_session.add_argument("session_id")

    p_chw = sub.add_parser("chw-payout", help="Show a CHW's Stripe Connect status + earnings.")
    p_chw.add_argument("id_or_email")

    p_requeue = sub.add_parser("requeue-claim", help="Re-submit a stuck claim to Pear Suite.")
    p_requeue.add_argument("claim_id")
    p_requeue.add_argument(
        "--yes", action="store_true", help="Actually perform the submission (default is dry-run)."
    )

    p_retry = sub.add_parser("retry-payout", help="Re-trigger Stripe transfer for a paid claim.")
    p_retry.add_argument("claim_id")
    p_retry.add_argument(
        "--yes", action="store_true", help="Actually initiate the transfer (default is dry-run)."
    )

    return parser


async def _dispatch(args: argparse.Namespace) -> int:
    async with async_session() as db:
        try:
            if args.command == "user":
                return await cmd_user(db, args.id_or_email, args.operator)
            if args.command == "session":
                return await cmd_session(db, args.session_id, args.operator)
            if args.command == "chw-payout":
                return await cmd_chw_payout(db, args.id_or_email, args.operator)
            if args.command == "requeue-claim":
                return await cmd_requeue_claim(db, args.claim_id, args.operator, args.yes)
            if args.command == "retry-payout":
                return await cmd_retry_payout(db, args.claim_id, args.operator, args.yes)
            _fatal(f"Unknown command: {args.command}", code=2)
            return 2  # pragma: no cover
        except SystemExit:
            raise
        except Exception as e:  # noqa: BLE001
            await db.rollback()
            logger.exception("Command %s failed", args.command)
            _fatal(f"Unhandled error: {type(e).__name__}: {e}")
            return 1


def main() -> int:
    args = _build_parser().parse_args()
    return asyncio.run(_dispatch(args))


if __name__ == "__main__":
    sys.exit(main())
