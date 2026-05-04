"""Vonage Voice API smoke test.

Isolates the Vonage SDK + private-key + webhook reachability path from the
rest of the stack. No DB rows or auth required. Useful as the very first
sanity check after configuring the Vonage Application + linking a number.

Subcommands:
    preflight              Verify env + private key are loaded correctly.
    ring <e164>            Place an outbound call to the given E.164 number
                           (e.g. +13105551234). When the recipient answers,
                           our /voice/answer webhook fires and the recipient
                           hears the configured NCCO.
    bridge <e164> <e164>   Place a masked-bridge test call. First number is
                           the "CHW" leg (rings first), second is the
                           "member" leg (bridged on consent).

Usage (from EC2):
    docker exec -w /code compass-api python -m scripts.test_vonage preflight
    docker exec -w /code compass-api python -m scripts.test_vonage ring +13105551234
    docker exec -w /code compass-api python -m scripts.test_vonage bridge \\
      +13105551234 +13105559999

Required env (already in production .env):
    VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_APPLICATION_ID,
    VONAGE_PRIVATE_KEY_PATH, VONAGE_FROM_NUMBER.

Exit codes:
    0  success
    1  call placement failed (see output for the SDK error)
    2  preflight failed (missing env, missing key file, etc.)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# ─── Output helpers (mirrors test_pear_suite.py style) ───────────────────────


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


def _print_info(label: str, value: str) -> None:
    print(f"  · {label}: {value}")


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _strip_e164(number: str) -> str:
    """Vonage wants digits only — strip +, spaces, dashes."""
    return "".join(ch for ch in (number or "") if ch.isdigit())


def _public_base_url() -> str:
    """Mirror VonageProvider's webhook base URL derivation so we can verify
    the URLs the call will actually use."""
    base_env = (
        os.environ.get("MAGIC_LINK_BASE_URL")
        or os.environ.get("magic_link_base_url")
        or "https://api.joincompasschw.com/auth/magic"
    ).rstrip("/")
    if base_env.endswith("/auth/magic"):
        base_env = base_env[: -len("/auth/magic")]
    base_env = base_env.replace("https://joincompasschw.com", "https://api.joincompasschw.com")
    if not base_env.endswith("/api/v1/communication"):
        base_env = f"{base_env}/api/v1/communication"
    return base_env


# ─── Preflight ───────────────────────────────────────────────────────────────


def _preflight(verbose: bool = True) -> dict[str, str]:
    """Validate Vonage env + private key. Exits 2 on failure."""
    if verbose:
        print(_bold("Vonage smoke test — preflight"))
        print("─" * 72)

    cfg = {
        "api_key": os.environ.get("VONAGE_API_KEY", ""),
        "api_secret": os.environ.get("VONAGE_API_SECRET", ""),
        "application_id": os.environ.get("VONAGE_APPLICATION_ID", ""),
        "private_key_path": os.environ.get("VONAGE_PRIVATE_KEY_PATH", ""),
        "from_number": os.environ.get("VONAGE_FROM_NUMBER", ""),
    }

    missing = [k for k, v in cfg.items() if not v]
    if missing:
        _print_fail(f"Missing env vars: {', '.join(missing)}")
        sys.exit(2)

    if verbose:
        _print_ok(f"VONAGE_API_KEY={cfg['api_key']}")
        _print_ok(f"VONAGE_APPLICATION_ID={cfg['application_id']}")
        _print_ok(f"VONAGE_FROM_NUMBER={cfg['from_number']}")
        _print_info("VONAGE_PRIVATE_KEY_PATH", cfg["private_key_path"])
        _print_info("Webhook base URL", _public_base_url())

    key_path = Path(cfg["private_key_path"])
    if not key_path.exists():
        _print_fail(f"Private key not found at {key_path}")
        sys.exit(2)
    if not key_path.is_file():
        _print_fail(f"Private key path is not a file: {key_path}")
        sys.exit(2)
    if verbose:
        size = key_path.stat().st_size
        _print_ok(f"Private key file present ({size} bytes)")

    try:
        from vonage import Auth, Vonage  # noqa: F401
    except ImportError:
        _print_fail("vonage SDK not installed. Add `vonage` to requirements.")
        sys.exit(2)
    if verbose:
        _print_ok("vonage SDK import succeeded")

    return cfg


def _client(cfg: dict[str, str]):
    """Build a Vonage SDK client from preflight cfg."""
    from vonage import Auth, Vonage

    auth = Auth(
        api_key=cfg["api_key"],
        api_secret=cfg["api_secret"],
        application_id=cfg["application_id"],
        private_key=cfg["private_key_path"],
    )
    return Vonage(auth)


def _create_call(
    *,
    cfg: dict[str, str],
    to_digits: str,
    from_digits: str,
    answer_url: str,
    event_url: str,
):
    """Place an outbound voice call.

    The Vonage Python SDK v4+ uses pydantic CreateCallRequest models with
    `from_` (Python keyword collision: `from` is reserved). We try the
    typed API first, then fall back to the legacy dict shape for older SDK
    versions. Either way the wire payload is the same.
    """
    client = _client(cfg)

    try:
        from vonage_voice.models import CreateCallRequest, Phone, ToPhone

        req = CreateCallRequest(
            to=[ToPhone(number=to_digits)],
            from_=Phone(number=from_digits),
            answer_url=[answer_url],
            event_url=[event_url],
        )
        return client.voice.create_call(req)
    except ImportError:
        pass  # Older SDK — fall through to dict form.

    return client.voice.create_call(
        {
            "to": [{"type": "phone", "number": to_digits}],
            "from_": {"type": "phone", "number": from_digits},
            "answer_url": [answer_url],
            "event_url": [event_url],
        }
    )


# ─── Subcommands ─────────────────────────────────────────────────────────────


def cmd_preflight() -> int:
    _preflight(verbose=True)
    print()
    print(_green(_bold("  RESULT: PASS — Vonage env + key + SDK look healthy.")))
    return 0


def cmd_ring(recipient_e164: str) -> int:
    """Place a single outbound call. When the recipient answers, our existing
    /voice/answer endpoint fires. Without a `member` query param it returns a
    'call not configured' NCCO — but that's still useful: it proves the call
    placed, the webhook reached our backend, and an NCCO was returned.
    """
    cfg = _preflight(verbose=True)
    recipient_digits = _strip_e164(recipient_e164)
    from_digits = _strip_e164(cfg["from_number"])

    answer_url = f"{_public_base_url()}/voice/answer?session=smoke-test"
    event_url = f"{_public_base_url()}/voice/events?session=smoke-test"

    _print_step(1, 1, f"voice.create_call → {recipient_e164}")
    _print_info("from", f"+{from_digits}")
    _print_info("to", f"+{recipient_digits}")
    _print_info("answer_url", answer_url)
    _print_info("event_url", event_url)

    try:
        response = _create_call(
            cfg=cfg,
            to_digits=recipient_digits,
            from_digits=from_digits,
            answer_url=answer_url,
            event_url=event_url,
        )
    except Exception as e:  # noqa: BLE001
        _print_fail(f"create_call raised: {type(e).__name__}: {e}")
        return 1

    payload = response if isinstance(response, dict) else getattr(response, "__dict__", {"_repr": repr(response)})
    print(f"  {_bold('Vonage response:')}")
    for line in json.dumps(payload, default=str, indent=4).splitlines():
        print(f"    {line}")

    call_uuid = (
        getattr(response, "uuid", None)
        or (response.get("uuid") if isinstance(response, dict) else None)
    )
    status = (
        getattr(response, "status", None)
        or (response.get("status") if isinstance(response, dict) else None)
    )

    if not call_uuid:
        _print_fail("No call UUID returned. Inspect the response above.")
        return 1

    _print_ok(f"Call placed — uuid={call_uuid} status={status or 'unknown'}")
    print()
    print(
        f"  {_bold('Next:')} your phone should ring within ~5s. When you answer\n"
        f"  Vonage will hit our /voice/answer webhook. Without a `member` query\n"
        f"  param the NCCO returns a 'call not configured' announcement — that's\n"
        f"  expected for this isolated test. To run a real bridge, use:\n"
        f"    test_vonage bridge <chw_e164> <member_e164>\n"
    )
    return 0


def cmd_bridge(chw_e164: str, member_e164: str) -> int:
    """Place a real masked-bridge test. CHW leg rings first; on answer, our
    /voice/answer NCCO bridges to the member leg, runs the consent IVR, and
    records on consent.
    """
    cfg = _preflight(verbose=True)
    chw_digits = _strip_e164(chw_e164)
    member_digits = _strip_e164(member_e164)
    from_digits = _strip_e164(cfg["from_number"])

    answer_url = (
        f"{_public_base_url()}/voice/answer"
        f"?session=smoke-test&member={member_digits}"
    )
    event_url = f"{_public_base_url()}/voice/events?session=smoke-test"

    _print_step(1, 1, f"voice.create_call → CHW {chw_e164} → bridge → member {member_e164}")
    _print_info("from", f"+{from_digits}")
    _print_info("CHW (leg 1)", f"+{chw_digits}")
    _print_info("member (leg 2)", f"+{member_digits}")
    _print_info("answer_url", answer_url)
    _print_info("event_url", event_url)

    try:
        response = _create_call(
            cfg=cfg,
            to_digits=chw_digits,
            from_digits=from_digits,
            answer_url=answer_url,
            event_url=event_url,
        )
    except Exception as e:  # noqa: BLE001
        _print_fail(f"create_call raised: {type(e).__name__}: {e}")
        return 1

    payload = response if isinstance(response, dict) else getattr(response, "__dict__", {"_repr": repr(response)})
    print(f"  {_bold('Vonage response:')}")
    for line in json.dumps(payload, default=str, indent=4).splitlines():
        print(f"    {line}")

    call_uuid = (
        getattr(response, "uuid", None)
        or (response.get("uuid") if isinstance(response, dict) else None)
    )
    if not call_uuid:
        _print_fail("No call UUID returned. Inspect the response above.")
        return 1

    _print_ok(f"Bridge call placed — uuid={call_uuid}")
    print()
    print(
        f"  {_bold('Expected flow:')}\n"
        f"   1. CHW phone (+{chw_digits}) rings.\n"
        f"   2. CHW answers → 'Hold while we connect you to your member.'\n"
        f"   3. Member phone (+{member_digits}) rings.\n"
        f"   4. Member answers → consent IVR plays disclosure.\n"
        f"   5. Member presses 1 → 'You are now connected.' + recording starts.\n"
        f"   6. Member presses 2 (or no input) → polite hangup.\n"
    )
    return 0


def cmd_diagnose(recipient_e164: str) -> int:
    """Try every plausible create_call shape and print the full traceback for
    each so we can see exactly which shape the installed SDK accepts.

    Useful when `ring` returns the cryptic 'Either `from_` or `random_from_number`
    must be set' but our model_dump shows from_ correctly populated.

    Each attempt is wrapped in try/except — we never short-circuit, so every
    shape gets exercised. The first one that succeeds also actually places a
    call, so make sure the recipient phone is available before running.
    """
    import traceback

    cfg = _preflight(verbose=True)
    recipient_digits = _strip_e164(recipient_e164)
    from_digits = _strip_e164(cfg["from_number"])
    answer_url = f"{_public_base_url()}/voice/answer?session=diag"
    event_url = f"{_public_base_url()}/voice/events?session=diag"

    print()
    print(_bold("Trying every plausible create_call shape…"))
    print("─" * 72)

    client = _client(cfg)
    attempts: list[tuple[str, callable]] = []

    # Attempt 1 — typed Pydantic model (vonage SDK v4+ canonical form).
    def attempt_typed_model():
        from vonage_voice.models import CreateCallRequest, Phone, ToPhone
        req = CreateCallRequest(
            to=[ToPhone(number=recipient_digits)],
            from_=Phone(number=from_digits),
            answer_url=[answer_url],
            event_url=[event_url],
        )
        return client.voice.create_call(req)
    attempts.append(("typed CreateCallRequest + Phone/ToPhone", attempt_typed_model))

    # Attempt 2 — typed model dumped to dict via model_dump(by_alias=True).
    def attempt_dict_by_alias():
        from vonage_voice.models import CreateCallRequest, Phone, ToPhone
        req = CreateCallRequest(
            to=[ToPhone(number=recipient_digits)],
            from_=Phone(number=from_digits),
            answer_url=[answer_url],
            event_url=[event_url],
        )
        return client.voice.create_call(req.model_dump(by_alias=True, exclude_none=True))
    attempts.append(("dict from model_dump(by_alias=True)", attempt_dict_by_alias))

    # Attempt 3 — raw dict with `from_` key (snake_case).
    def attempt_dict_from_underscore():
        return client.voice.create_call({
            "to": [{"type": "phone", "number": recipient_digits}],
            "from_": {"type": "phone", "number": from_digits},
            "answer_url": [answer_url],
            "event_url": [event_url],
        })
    attempts.append(("dict with key `from_` (underscore)", attempt_dict_from_underscore))

    # Attempt 4 — raw dict with `from` key (HTTP-API spelling).
    def attempt_dict_from_plain():
        return client.voice.create_call({
            "to": [{"type": "phone", "number": recipient_digits}],
            "from": {"type": "phone", "number": from_digits},
            "answer_url": [answer_url],
            "event_url": [event_url],
        })
    attempts.append(("dict with key `from` (HTTP spelling)", attempt_dict_from_plain))

    # Attempt 5 — typed model with random_from_number=False explicitly set.
    def attempt_typed_model_no_random():
        from vonage_voice.models import CreateCallRequest, Phone, ToPhone
        req = CreateCallRequest(
            to=[ToPhone(number=recipient_digits)],
            from_=Phone(number=from_digits),
            random_from_number=False,
            answer_url=[answer_url],
            event_url=[event_url],
        )
        return client.voice.create_call(req)
    attempts.append(("typed model + random_from_number=False", attempt_typed_model_no_random))

    succeeded: str | None = None
    for label, fn in attempts:
        print(f"\n  {_bold(label)}")
        try:
            result = fn()
            _print_ok(f"SUCCESS — {type(result).__name__}: {result!r}")
            succeeded = label
            break
        except Exception as e:  # noqa: BLE001
            print(f"  {_red('[FAIL]')} {type(e).__name__}: {e}")
            tb_lines = traceback.format_exc().splitlines()
            for line in tb_lines[-6:]:
                print(f"    {line}")

    print()
    if succeeded:
        _print_ok(f"Working shape: {succeeded}")
        print(
            "  Patch _create_call() in this file (and "
            "vonage_provider.create_proxy_session) to use this shape."
        )
        return 0
    _print_fail("No shape succeeded. Check Vonage dashboard config + SDK version.")
    return 1


# ─── CLI wiring ──────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="test_vonage",
        description="Vonage Voice API smoke test (env + key + outbound call).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("preflight", help="Verify env + private key are loaded correctly.")

    p_ring = sub.add_parser("ring", help="Place a single outbound test call.")
    p_ring.add_argument("number", help="E.164 phone number to ring (e.g. +13105551234).")

    p_bridge = sub.add_parser("bridge", help="Place a masked CHW→member bridge test.")
    p_bridge.add_argument("chw_number", help="E.164 phone number for the CHW leg.")
    p_bridge.add_argument("member_number", help="E.164 phone number for the member leg.")

    p_diag = sub.add_parser(
        "diagnose",
        help="Try every plausible create_call shape; print which one works.",
    )
    p_diag.add_argument(
        "number",
        help="E.164 phone number — first successful shape will actually ring it.",
    )

    return parser


def main() -> int:
    args = _build_parser().parse_args()
    if args.command == "preflight":
        return cmd_preflight()
    if args.command == "ring":
        return cmd_ring(args.number)
    if args.command == "diagnose":
        return cmd_diagnose(args.number)
    if args.command == "bridge":
        return cmd_bridge(args.chw_number, args.member_number)
    print(f"Unknown command: {args.command}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
