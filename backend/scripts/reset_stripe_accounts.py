"""Reset CHW Stripe Connect account fields.

PURPOSE
-------
Null out the cached Stripe Connect fields on `chw_profiles` so that the next
call to POST /payments/connect-onboarding creates a fresh connected account.

This is needed in two situations:

  1. PLACEHOLDER CLEANUP — while Stripe was unconfigured (blank
     STRIPE_SECRET_KEY), the provider handed back placeholder account ids
     (`acct_placeholder_...`). Those are not real Stripe accounts. Once a real
     key is set they must be cleared so real `acct_` accounts get created.

  2. TEST → LIVE (or live → test) CUTOVER — a connected account created under a
     `sk_test_` key does not exist under a `sk_live_` key (and vice-versa).
     Switching modes requires nulling the stored account so onboarding restarts
     against the new mode.

WHAT IT CHANGES
---------------
For each matched CHW profile it sets:
    stripe_connected_account_id -> NULL
    stripe_payouts_enabled      -> False
    stripe_details_submitted    -> False

Nothing else is touched. No rows are deleted. Earnings, billing claims, and
completed transfers are unaffected — this only resets the payout-onboarding
pointer so the CHW re-onboards.

SCOPES (exactly one required)
-----------------------------
    --only-placeholder   Reset only rows whose connected account id starts with
                         `acct_placeholder` (safe cleanup; the default choice
                         after first configuring a real key).
    --all                Reset every CHW that has a connected account id set
                         (use for a test<->live cutover).
    --email ADDR         Reset a single CHW by login email. Repeatable.

MODE (exactly one required)
---------------------------
    --dry-run   Print what would change; commit nothing. Safe to repeat.
    --apply     Execute inside a single transaction; rolls back on any error.

USAGE (prod, inside the API container)
--------------------------------------
    docker exec -it <api_container> python -m scripts.reset_stripe_accounts \
        --only-placeholder --dry-run
    docker exec -it <api_container> python -m scripts.reset_stripe_accounts \
        --only-placeholder --apply
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from dataclasses import dataclass, field
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models.user import CHWProfile, User

logger = logging.getLogger("compass.reset_stripe")

PLACEHOLDER_PREFIX = "acct_placeholder"


@dataclass
class ResetRow:
    """One CHW profile that would be / was reset."""

    email: str
    old_account_id: str
    payouts_enabled: bool
    details_submitted: bool


@dataclass
class ResetSummary:
    """Outcome of a reset run."""

    rows: list[ResetRow] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.rows)

    def print_report(self, *, dry_run: bool) -> None:
        verb = "Would reset" if dry_run else "Reset"
        print("\n" + "-" * 64)
        if not self.rows:
            print("  No matching CHW profiles found — nothing to reset.")
            print("-" * 64)
            return
        print(f"  {verb} {self.total} CHW payout account(s):")
        print("-" * 64)
        for row in self.rows:
            flags = []
            if row.payouts_enabled:
                flags.append("payouts_enabled")
            if row.details_submitted:
                flags.append("details_submitted")
            flag_str = f" [{', '.join(flags)}]" if flags else ""
            print(f"  {row.email:<40} {row.old_account_id}{flag_str}")
        print("-" * 64)


def _matches_scope(
    profile: CHWProfile,
    email: str,
    *,
    only_placeholder: bool,
    emails: set[str],
) -> bool:
    """Return True if this profile is in scope for the requested reset."""
    account_id = profile.stripe_connected_account_id
    if not account_id:
        return False
    if only_placeholder:
        return account_id.startswith(PLACEHOLDER_PREFIX)
    if emails:
        return email.lower() in emails
    # --all
    return True


async def run_reset(
    *,
    dry_run: bool,
    only_placeholder: bool,
    emails: set[str],
) -> ResetSummary:
    """Reset in-scope CHW Stripe fields. Commits only when dry_run is False."""
    summary = ResetSummary()
    session: AsyncSession
    async with async_session() as session:
        result = await session.execute(
            select(CHWProfile, User.email)
            .join(User, User.id == CHWProfile.user_id)
        )
        for profile, email in result.all():
            if not _matches_scope(
                profile, email,
                only_placeholder=only_placeholder,
                emails=emails,
            ):
                continue

            summary.rows.append(ResetRow(
                email=email,
                old_account_id=profile.stripe_connected_account_id or "",
                payouts_enabled=profile.stripe_payouts_enabled,
                details_submitted=profile.stripe_details_submitted,
            ))

            if not dry_run:
                profile.stripe_connected_account_id = None
                profile.stripe_payouts_enabled = False
                profile.stripe_details_submitted = False

        if emails:
            # Surface any requested emails that didn't match, so a typo doesn't
            # silently do nothing.
            matched = {row.email.lower() for row in summary.rows}
            missing = emails - matched
            for addr in sorted(missing):
                logger.warning("No CHW with a Stripe account found for email: %s", addr)

        if dry_run:
            await session.rollback()
        else:
            await session.commit()

    return summary


def _print_db_host() -> None:
    """Print the DB host derived from the DATABASE_URL, with password redacted."""
    from app.config import settings

    try:
        parsed = urlparse(settings.database_url)
        host = parsed.hostname or "unknown"
        port = f":{parsed.port}" if parsed.port else ""
        db_name = parsed.path.lstrip("/") or "unknown"
        print(f"  DB host:     {host}{port}")
        print(f"  DB name:     {db_name}")
    except Exception:  # noqa: BLE001
        print("  DB host:     (could not parse DATABASE_URL)")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="reset_stripe_accounts",
        description=(
            "Reset CHW Stripe Connect account fields so onboarding restarts. "
            "Nulls stripe_connected_account_id and clears the payout flags. "
            "Deletes nothing else. Exactly one mode and one scope are required."
        ),
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change without committing. Safe to repeat.",
    )
    mode.add_argument(
        "--apply",
        action="store_true",
        help="Execute the reset inside a single transaction (rolls back on error).",
    )

    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument(
        "--only-placeholder",
        action="store_true",
        help=(
            f"Reset only accounts whose id starts with '{PLACEHOLDER_PREFIX}' "
            "(placeholder cleanup after first setting a real key)."
        ),
    )
    scope.add_argument(
        "--all",
        action="store_true",
        help="Reset every CHW with a connected account (test<->live cutover).",
    )
    scope.add_argument(
        "--email",
        action="append",
        metavar="ADDR",
        help="Reset a single CHW by login email. Repeatable.",
    )
    return parser


async def _main(
    *,
    dry_run: bool,
    only_placeholder: bool,
    emails: set[str],
) -> int:
    print("\n" + "=" * 64)
    print("  Compass — Reset CHW Stripe Connect Accounts")
    print("  " + (
        "DRY-RUN MODE — no changes will be committed"
        if dry_run else
        "APPLY MODE — changes WILL be committed"
    ))
    print("=" * 64)
    _print_db_host()
    if only_placeholder:
        scope_desc = f"placeholder accounts ('{PLACEHOLDER_PREFIX}*')"
    elif emails:
        scope_desc = f"emails: {sorted(emails)}"
    else:
        scope_desc = "ALL CHWs with a connected account"
    print(f"  Scope:       {scope_desc}")
    print("=" * 64 + "\n")

    if not dry_run:
        print(
            "WARNING: --apply will clear the stored Stripe account pointer for the\n"
            "         CHWs above. They will need to re-run payout onboarding.\n"
            "         Press Ctrl-C within 5 seconds to abort...\n"
        )
        import time
        time.sleep(5)

    try:
        summary = await run_reset(
            dry_run=dry_run,
            only_placeholder=only_placeholder,
            emails=emails,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"\nERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        logger.exception("Unhandled error during Stripe reset")
        return 1

    summary.print_report(dry_run=dry_run)
    print(
        f"\n{'[DRY-RUN] Would reset' if dry_run else 'Reset'} "
        f"{summary.total} CHW payout account(s).\n"
    )
    return 0


def main() -> int:
    """Synchronous entry point for `python -m scripts.reset_stripe_accounts`."""
    args = _build_parser().parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="[%(levelname)s] %(name)s — %(message)s",
    )
    emails = {addr.strip().lower() for addr in (args.email or []) if addr.strip()}
    return asyncio.run(_main(
        dry_run=args.dry_run,
        only_placeholder=args.only_placeholder,
        emails=emails,
    ))


if __name__ == "__main__":
    raise SystemExit(main())
