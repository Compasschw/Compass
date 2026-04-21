"""Pear Suite billing integration test harness.

Runnable against Pear Suite's API the moment their API key arrives. Exercises
every call path (eligibility, claim submission, status poll, void) without
requiring any DB rows to exist — uses synthetic fixtures so it can run as the
very first smoke test after key issuance.

Usage (from the EC2 host):
    docker exec -w /code compass-api python -m scripts.test_pear_suite golden-path

Subcommands:
    eligibility <medi_cal_id>    Verify a member's Medi-Cal eligibility.
    submit-claim                 Submit a synthetic CHW service claim.
    status <claim_id>            Poll a previously submitted claim.
    void <claim_id>              Void an un-adjudicated claim.
    golden-path                  Run eligibility → submit → status end-to-end.

Environment variables (already in .env for production):
    PEAR_SUITE_API_KEY       Required. The API key issued by Pear Suite.
    PEAR_SUITE_BASE_URL      Optional. Override the base URL (e.g., sandbox).

Exit codes:
    0  every step succeeded
    1  at least one step failed (see output for details)
    2  CLI misuse (bad args, missing env vars)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import uuid
from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from app.services.billing import (
    BillingProvider,
    ClaimSubmission,
    EligibilityResult,
    get_billing_provider,
)

# ─── Output helpers ──────────────────────────────────────────────────────────


def _bold(s: str) -> str:
    return f"\033[1m{s}\033[0m"


def _green(s: str) -> str:
    return f"\033[32m{s}\033[0m"


def _red(s: str) -> str:
    return f"\033[31m{s}\033[0m"


def _yellow(s: str) -> str:
    return f"\033[33m{s}\033[0m"


def _print_step(n: int, total: int, title: str) -> None:
    print(f"\n{_bold(f'[{n}/{total}]')} {title}")
    print("─" * 72)


def _print_ok(msg: str) -> None:
    print(f"  {_green('[OK]')}   {msg}")


def _print_fail(msg: str) -> None:
    print(f"  {_red('[FAIL]')} {msg}")


def _print_warn(msg: str) -> None:
    print(f"  {_yellow('[WARN]')} {msg}")


def _print_info(label: str, value: Any) -> None:
    print(f"  · {label}: {value}")


def _dump_dataclass(label: str, obj: Any) -> None:
    """Pretty-print a dataclass or dict for debugging."""
    if is_dataclass(obj):
        payload = asdict(obj)
    elif isinstance(obj, dict):
        payload = obj
    else:
        payload = {"value": repr(obj)}
    print(f"  {_bold(label)}:")
    for line in json.dumps(payload, default=str, indent=4).splitlines():
        print(f"    {line}")


# ─── Preflight ───────────────────────────────────────────────────────────────


def _preflight() -> BillingProvider:
    """Validate env + return an initialized BillingProvider singleton.

    Exits with code 2 if critical env config is missing.
    """
    api_key = os.environ.get("PEAR_SUITE_API_KEY", "")
    base_url = os.environ.get("PEAR_SUITE_BASE_URL", "https://api.pearsuite.com")

    print(_bold("Pear Suite test harness — preflight"))
    print("─" * 72)
    if not api_key:
        _print_fail("PEAR_SUITE_API_KEY is not set.")
        print(
            "\n  Set it via your .env file or pass it inline, e.g.:\n"
            "    docker exec -e PEAR_SUITE_API_KEY=... -w /code compass-api \\\n"
            "      python -m scripts.test_pear_suite golden-path\n"
        )
        sys.exit(2)

    _print_ok(f"API key present ({len(api_key)} chars, first 4: {api_key[:4]}…)")
    _print_info("Base URL", base_url)

    provider = get_billing_provider()
    _print_ok(f"Provider initialized: {type(provider).__name__}")
    return provider


# ─── Synthetic fixture ───────────────────────────────────────────────────────


def _synthetic_claim() -> ClaimSubmission:
    """A self-contained claim fixture — does not touch the DB.

    Values match real Medi-Cal CHW billing shape: CPT 98960 + U2 modifier,
    1 unit at $26.66 gross, SDOH Z-codes for food insecurity + housing.
    """
    return ClaimSubmission(
        session_id=uuid.uuid4(),
        chw_id=uuid.uuid4(),
        member_id=uuid.uuid4(),
        service_date=date.today(),
        procedure_code="98960",
        modifier="U2",
        diagnosis_codes=["Z59.41", "Z59.0"],
        units=1,
        gross_amount=Decimal("26.66"),
        chw_npi=None,
        notes="TEST HARNESS — synthetic claim, do not adjudicate.",
        extra={"_test": True, "_generated_at": datetime.utcnow().isoformat()},
    )


# ─── Subcommand implementations ──────────────────────────────────────────────


async def cmd_eligibility(
    provider: BillingProvider,
    medi_cal_id: str,
) -> bool:
    """Run a single eligibility check. Returns True on success."""
    _print_step(1, 1, f"verify_eligibility('{medi_cal_id}')")
    try:
        result = await provider.verify_eligibility(medi_cal_id)
    except Exception as e:  # noqa: BLE001
        _print_fail(f"Raised: {type(e).__name__}: {e}")
        return False

    _dump_dataclass("EligibilityResult", result)
    if not isinstance(result, EligibilityResult):
        _print_fail("Response is not an EligibilityResult — provider bug?")
        return False

    if result.is_eligible:
        _print_ok(f"Member is eligible (plan: {result.plan_name})")
    else:
        _print_warn(f"Member not eligible: {result.message or '(no message)'}")
    return True


async def cmd_submit(provider: BillingProvider) -> tuple[bool, str | None]:
    """Submit a synthetic claim. Returns (success, provider_claim_id)."""
    claim = _synthetic_claim()
    _print_step(1, 1, "submit_claim(<synthetic fixture>)")
    _dump_dataclass("ClaimSubmission (request)", claim)

    try:
        result = await provider.submit_claim(claim)
    except Exception as e:  # noqa: BLE001
        _print_fail(f"Raised: {type(e).__name__}: {e}")
        return False, None

    _dump_dataclass("ClaimResult (response)", result)
    if not result.success:
        _print_fail(f"Submission failed: {result.message}")
        return False, None

    _print_ok(f"Submitted — provider_claim_id={result.provider_claim_id} status={result.status}")
    return True, result.provider_claim_id


async def cmd_status(provider: BillingProvider, claim_id: str) -> bool:
    """Poll the status of a previously submitted claim."""
    _print_step(1, 1, f"get_claim_status('{claim_id}')")
    try:
        result = await provider.get_claim_status(claim_id)
    except Exception as e:  # noqa: BLE001
        _print_fail(f"Raised: {type(e).__name__}: {e}")
        return False

    _dump_dataclass("ClaimResult", result)
    if result.success:
        _print_ok(f"Status: {result.status}")
        return True
    _print_warn(f"Could not fetch status: {result.message}")
    return False


async def cmd_void(provider: BillingProvider, claim_id: str) -> bool:
    """Void an un-adjudicated claim."""
    _print_step(1, 1, f"void_claim('{claim_id}')")
    try:
        result = await provider.void_claim(claim_id)
    except Exception as e:  # noqa: BLE001
        _print_fail(f"Raised: {type(e).__name__}: {e}")
        return False

    _dump_dataclass("ClaimResult", result)
    if result.success:
        _print_ok(f"Voided (status={result.status})")
        return True
    _print_fail(f"Void failed: {result.message}")
    return False


async def cmd_golden_path(
    provider: BillingProvider,
    eligibility_id: str | None,
) -> bool:
    """End-to-end smoke test: eligibility → submit → status."""
    steps_ok = True

    # Step 1 — eligibility (optional)
    _print_step(1, 3, "verify_eligibility")
    if eligibility_id:
        try:
            elig = await provider.verify_eligibility(eligibility_id)
            _dump_dataclass("EligibilityResult", elig)
            if elig.is_eligible:
                _print_ok(f"Member eligible (plan: {elig.plan_name})")
            else:
                _print_warn(f"Not eligible — continuing anyway: {elig.message}")
        except Exception as e:  # noqa: BLE001
            _print_fail(f"Eligibility raised: {type(e).__name__}: {e}")
            steps_ok = False
    else:
        _print_warn("Skipped — no --medi-cal-id provided")

    # Step 2 — submit
    _print_step(2, 3, "submit_claim")
    claim = _synthetic_claim()
    _dump_dataclass("ClaimSubmission (request)", claim)
    try:
        submit_result = await provider.submit_claim(claim)
    except Exception as e:  # noqa: BLE001
        _print_fail(f"Submit raised: {type(e).__name__}: {e}")
        return False

    _dump_dataclass("ClaimResult (response)", submit_result)
    if not submit_result.success or not submit_result.provider_claim_id:
        _print_fail(f"Submit failed: {submit_result.message}")
        return False
    _print_ok(f"Submitted — {submit_result.provider_claim_id}")
    claim_id = submit_result.provider_claim_id

    # Step 3 — status
    _print_step(3, 3, f"get_claim_status('{claim_id}')")
    try:
        status_result = await provider.get_claim_status(claim_id)
    except Exception as e:  # noqa: BLE001
        _print_fail(f"Status raised: {type(e).__name__}: {e}")
        return False

    _dump_dataclass("ClaimResult", status_result)
    if status_result.success:
        _print_ok(f"Status: {status_result.status}")
    else:
        _print_warn(f"Status fetch returned failure: {status_result.message}")
        steps_ok = False

    return steps_ok


# ─── CLI wiring ──────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="test_pear_suite",
        description="Pear Suite billing integration test harness.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_elig = sub.add_parser("eligibility", help="Verify a member's Medi-Cal eligibility.")
    p_elig.add_argument("medi_cal_id", help="Medi-Cal Client Index Number (CIN).")

    sub.add_parser("submit-claim", help="Submit a synthetic CHW service claim.")

    p_status = sub.add_parser("status", help="Poll a previously submitted claim.")
    p_status.add_argument("claim_id", help="provider_claim_id returned by submit-claim.")

    p_void = sub.add_parser("void", help="Void an un-adjudicated claim.")
    p_void.add_argument("claim_id", help="provider_claim_id to void.")

    p_golden = sub.add_parser("golden-path", help="Full smoke test: eligibility → submit → status.")
    p_golden.add_argument(
        "--medi-cal-id",
        default=None,
        help="If provided, runs eligibility check first; otherwise skipped.",
    )

    return parser


def _print_summary(success: bool) -> None:
    print("\n" + "=" * 72)
    if success:
        print(_green(_bold("  RESULT: PASS — all steps completed successfully.")))
    else:
        print(_red(_bold("  RESULT: FAIL — at least one step did not succeed.")))
    print("=" * 72 + "\n")


async def _main() -> int:
    args = _build_parser().parse_args()

    provider = _preflight()

    if args.command == "eligibility":
        ok = await cmd_eligibility(provider, args.medi_cal_id)
    elif args.command == "submit-claim":
        ok, _ = await cmd_submit(provider)
    elif args.command == "status":
        ok = await cmd_status(provider, args.claim_id)
    elif args.command == "void":
        ok = await cmd_void(provider, args.claim_id)
    elif args.command == "golden-path":
        ok = await cmd_golden_path(provider, args.medi_cal_id)
    else:  # pragma: no cover — argparse enforces required subcommand
        print(f"Unknown command: {args.command}", file=sys.stderr)
        return 2

    _print_summary(ok)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(_main()))
