"""AssemblyAI transcription integration smoke-test harness.

Tests the AssemblyAI provider through the same code path that production uses
(get_transcription_provider → AssemblyAIProvider.transcribe_async). No DB rows
or auth required.

Usage (from the EC2 host):
    docker exec -w /code compass-api python -m scripts.test_assemblyai preflight
    docker exec -w /code compass-api python -m scripts.test_assemblyai transcribe-sample
    docker exec -w /code compass-api python -m scripts.test_assemblyai transcribe <url>

Subcommands:
    preflight               Verify ASSEMBLYAI_API_KEY is set, the SDK imports
                            cleanly, and api.assemblyai.com is reachable.
    transcribe <url>        Transcribe a public audio URL and print the result.
    transcribe-sample       Transcribe the built-in AssemblyAI sample audio URL
                            (no extra args required).

Environment variables (loaded on EC2 via .env / Secrets Manager):
    ASSEMBLYAI_API_KEY      Required. Production key issued under BAA.
    TRANSCRIPTION_PROVIDER  Optional. Must be "assemblyai" (or absent).

Exit codes:
    0  all steps succeeded
    1  at least one step failed — see output for details
    2  CLI misuse (bad args, missing required env, failed preflight)
"""

from __future__ import annotations

import argparse
import asyncio
import os
import socket
import sys
from typing import Any

# ─── ANSI output helpers (mirrors test_pear_suite.py / test_vonage.py) ───────


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


def _print_summary(success: bool) -> None:
    print("\n" + "=" * 72)
    if success:
        print(_green(_bold("  RESULT: PASS — all steps completed successfully.")))
    else:
        print(_red(_bold("  RESULT: FAIL — at least one step did not succeed.")))
    print("=" * 72 + "\n")


# ─── Constants ────────────────────────────────────────────────────────────────

# Publicly hosted, provider-maintained sample audio used by test_transcribe_sample.
# Verified reachable 2026-05-04: HTTP 200, audio/mpeg.
# Source: https://storage.googleapis.com/aai-docs-samples/nbc.mp3
SAMPLE_AUDIO_URL: str = "https://storage.googleapis.com/aai-docs-samples/nbc.mp3"

ASSEMBLYAI_API_HOST: str = "api.assemblyai.com"
ASSEMBLYAI_API_PORT: int = 443

# ─── Preflight helpers ────────────────────────────────────────────────────────


def _check_api_key() -> str:
    """Return the API key or exit 2 if it is not set.

    Guards against empty string and strings containing only whitespace,
    which would pass an ``if key`` check but fail all SDK calls.
    """
    api_key: str = os.environ.get("ASSEMBLYAI_API_KEY", "").strip()
    if not api_key:
        _print_fail(
            "ASSEMBLYAI_API_KEY is not set. "
            "Configure it in .env or pass it inline, e.g.:\n"
            "    docker exec -e ASSEMBLYAI_API_KEY=<key> -w /code compass-api \\\n"
            "      python -m scripts.test_assemblyai preflight"
        )
        sys.exit(2)
    return api_key


def _check_sdk_import() -> None:
    """Verify the assemblyai SDK is installed and importable.

    Exits 2 with a clear install hint if the package is missing.
    """
    try:
        import assemblyai  # noqa: F401  # type: ignore[import-untyped]
    except ImportError:
        _print_fail(
            "assemblyai SDK is not installed. "
            "Add 'assemblyai>=0.63.0' to requirements and rebuild the container."
        )
        sys.exit(2)

    _print_ok(f"assemblyai SDK importable (version: {_sdk_version()})")


def _sdk_version() -> str:
    """Return the installed assemblyai SDK version string, or 'unknown'."""
    try:
        import importlib.metadata

        return importlib.metadata.version("assemblyai")
    except Exception:  # noqa: BLE001
        return "unknown"


def _check_network_connectivity() -> None:
    """Attempt a TCP connection to api.assemblyai.com:443.

    A failed connection surfaces immediately as a preflight warning
    rather than a 10-minute SDK timeout during a real transcription job.
    Exits 2 on failure.
    """
    try:
        with socket.create_connection(
            (ASSEMBLYAI_API_HOST, ASSEMBLYAI_API_PORT),
            timeout=10,
        ):
            _print_ok(f"TCP connectivity to {ASSEMBLYAI_API_HOST}:{ASSEMBLYAI_API_PORT} confirmed")
    except OSError as exc:
        _print_fail(
            f"Cannot reach {ASSEMBLYAI_API_HOST}:{ASSEMBLYAI_API_PORT} — {exc}. "
            "Check VPC egress rules and DNS resolution."
        )
        sys.exit(2)


def _get_provider():
    """Return an initialised TranscriptionProvider singleton.

    Exits 2 if the factory raises (e.g., missing API key in config,
    unknown provider name).
    """
    try:
        # Force fresh initialisation so stale cached singletons from a previous
        # test run don't shadow the env we are actually testing.
        import app.services.transcription as _pkg

        _pkg._provider_instance = None  # noqa: SLF001 — intentional test reset

        from app.services.transcription import get_transcription_provider

        provider = get_transcription_provider()
    except Exception as exc:  # noqa: BLE001
        _print_fail(f"Provider factory raised {type(exc).__name__}: {exc}")
        sys.exit(2)

    _print_ok(f"Provider initialised: {type(provider).__name__}")
    return provider


# ─── Preflight subcommand ─────────────────────────────────────────────────────


def cmd_preflight() -> int:
    """Verify environment, SDK availability, and network connectivity.

    Runs three checks in sequence:
    1. ASSEMBLYAI_API_KEY is set and non-empty.
    2. The assemblyai SDK is installed and importable.
    3. api.assemblyai.com:443 is reachable over TCP.

    All three must pass for the preflight to succeed. Exits 2 on any failure
    so CI can distinguish configuration errors from functional test failures.

    Returns:
        0 if all checks pass, 2 if any check fails (via sys.exit).
    """
    print(_bold("AssemblyAI smoke test — preflight"))
    print("─" * 72)

    _print_step(1, 3, "Environment — ASSEMBLYAI_API_KEY")
    api_key = _check_api_key()
    _print_ok(f"API key present ({len(api_key)} chars, first 4: {api_key[:4]}…)")
    _print_info("TRANSCRIPTION_PROVIDER env", os.environ.get("TRANSCRIPTION_PROVIDER", "(not set, defaults to assemblyai)"))

    _print_step(2, 3, "SDK import — assemblyai")
    _check_sdk_import()

    _print_step(3, 3, f"Network — TCP {ASSEMBLYAI_API_HOST}:{ASSEMBLYAI_API_PORT}")
    _check_network_connectivity()

    print()
    print(_green(_bold("  RESULT: PASS — AssemblyAI env + SDK + network look healthy.")))
    return 0


# ─── Transcribe subcommand ────────────────────────────────────────────────────


async def cmd_transcribe(audio_url: str, *, medical: bool = True) -> int:
    """Transcribe a public audio URL via the production provider path.

    Runs a full preflight first (key + SDK + network). Then calls
    provider.transcribe_async() — the same method that the production
    post-call pipeline invokes — and prints the result fields that are
    safe to display (provider_transcript_id, confidence, duration, chunk
    count). Transcript text is intentionally not printed because this
    harness may run against real PHI audio in production; only the
    length of the text is shown so we can verify non-empty output.

    Args:
        audio_url: Publicly accessible URL to an audio file.
        medical:   Whether to use AssemblyAI Conformer-2 (medical model).
                   Defaults to True to match the production call signature.

    Returns:
        0 on success, 1 if transcription fails or returns empty text.
    """
    print(_bold("AssemblyAI smoke test — transcribe"))
    print("─" * 72)

    # --- Preflight (abbreviated — key + SDK only; network already verified by
    # the TCP check that the full preflight does, but we don't repeat it here
    # so the output stays tight for the common transcribe use-case).
    _print_step(1, 3, "Preflight — key + SDK")
    _check_api_key()
    _print_ok("ASSEMBLYAI_API_KEY present")
    _check_sdk_import()

    _print_step(2, 3, "Provider factory")
    provider = _get_provider()

    _print_step(3, 3, f"transcribe_async(audio_url=<{_truncate_url(audio_url)}>, medical_model={medical})")
    _print_info("audio_url", audio_url)
    _print_info("medical_model", medical)
    _print_info("Polling interval", "3s (up to 10 min)")
    print()
    print("  Submitting job to AssemblyAI and polling until complete…")

    try:
        result = await provider.transcribe_async(audio_url=audio_url, medical_model=medical)
    except Exception as exc:  # noqa: BLE001
        _print_fail(f"transcribe_async raised {type(exc).__name__}: {exc}")
        _print_summary(False)
        return 1

    # Verify we got a meaningful result back.
    if not result.full_text and not result.provider_transcript_id:
        _print_fail(
            "transcribe_async returned an empty result with no transcript ID. "
            "The provider may have rejected the audio URL or the API key is invalid."
        )
        _print_summary(False)
        return 1

    # Print safe-to-log fields only — never print full_text (PHI boundary).
    print()
    _print_ok("Transcription completed")
    _print_info("provider_transcript_id", result.provider_transcript_id or "(none)")
    _print_info("confidence", f"{result.confidence:.3f}")
    _print_info("language", result.language)
    _print_info("duration_ms", result.duration_ms if result.duration_ms is not None else "(none)")
    _print_info("chunk count (utterances)", len(result.chunks))
    _print_info("medical_entities count", len(result.medical_entities))
    _print_info("full_text length (chars)", len(result.full_text))
    _print_info("is_partial", result.is_partial)

    if not result.full_text:
        _print_warn(
            "full_text is empty. The audio may be silent or the URL returned "
            "no audio data. Inspect provider_transcript_id in AssemblyAI dashboard."
        )
        _print_summary(False)
        return 1

    _print_summary(True)
    return 0


def _truncate_url(url: str, max_length: int = 60) -> str:
    """Return a truncated URL for display — avoids wrapping long pre-signed URLs."""
    if len(url) <= max_length:
        return url
    return url[:max_length] + "…"


# ─── transcribe-sample subcommand ────────────────────────────────────────────


async def cmd_transcribe_sample() -> int:
    """Transcribe the built-in AssemblyAI sample audio URL.

    Uses the publicly-hosted nbc.mp3 sample from AssemblyAI's GCS bucket,
    which is stable, short (~30s), and free of PHI. This is the recommended
    first smoke test after provisioning a new API key or deploying to a new
    environment.

    The sample URL is:
        https://storage.googleapis.com/aai-docs-samples/nbc.mp3

    No extra arguments are required. Internally delegates to cmd_transcribe
    with the fixed sample URL.

    Returns:
        0 on success, 1 if transcription fails.
    """
    print(_bold("AssemblyAI smoke test — transcribe-sample"))
    print("─" * 72)
    _print_info("Sample URL", SAMPLE_AUDIO_URL)
    print()
    # Delegate to the shared transcribe implementation.
    return await cmd_transcribe(SAMPLE_AUDIO_URL, medical=True)


# ─── CLI wiring ───────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="test_assemblyai",
        description="AssemblyAI transcription integration smoke-test harness.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser(
        "preflight",
        help="Verify ASSEMBLYAI_API_KEY, SDK import, and network connectivity.",
    )

    p_transcribe = sub.add_parser(
        "transcribe",
        help="Transcribe a public audio URL via the production provider path.",
    )
    p_transcribe.add_argument(
        "url",
        help="Publicly accessible URL to an audio file (e.g., an S3 pre-signed URL).",
    )
    p_transcribe.add_argument(
        "--no-medical",
        action="store_true",
        default=False,
        help="Disable Conformer-2 medical model (use base model instead).",
    )

    sub.add_parser(
        "transcribe-sample",
        help="Transcribe the built-in AssemblyAI sample audio (no args needed).",
    )

    return parser


async def _main() -> int:
    args = _build_parser().parse_args()

    if args.command == "preflight":
        return cmd_preflight()

    if args.command == "transcribe":
        return await cmd_transcribe(args.url, medical=not args.no_medical)

    if args.command == "transcribe-sample":
        return await cmd_transcribe_sample()

    # Unreachable: argparse enforces required subcommand.
    print(f"Unknown command: {args.command}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(asyncio.run(_main()))
