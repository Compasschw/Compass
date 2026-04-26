"""Production smoke test suite for CompassCHW API.

Runs against https://api.joincompasschw.com after every deploy to verify
the API is healthy and all Phase 2 routes are reachable.

Usage:
    python -m scripts.smoke_test_prod

Exit code 0 on full pass; non-zero on any failure.

Environment variables:
    ADMIN_KEY   -- required: admin API key (16-char minimum)
    BASE_URL    -- optional override (default: https://api.joincompasschw.com)

HIPAA: tests use no real PHI. Credential tests use known-bad values or
known-fake UUIDs. Admin-stats response is aggregate counts only.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine

import httpx

BASE_URL: str = os.environ.get("BASE_URL", "https://api.joincompasschw.com").rstrip("/")
ADMIN_KEY: str = os.environ.get("ADMIN_KEY", "")
REQUEST_TIMEOUT: float = 10.0  # seconds per test


# ---------------------------------------------------------------------------
# Result model
# ---------------------------------------------------------------------------


@dataclass
class TestResult:
    name: str
    passed: bool
    elapsed_ms: float
    detail: str = ""


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def _green(s: str) -> str:
    return f"\033[32m{s}\033[0m"


def _red(s: str) -> str:
    return f"\033[31m{s}\033[0m"


def _yellow(s: str) -> str:
    return f"\033[33m{s}\033[0m"


async def _run_test(
    client: httpx.AsyncClient,
    name: str,
    coro_fn: Callable[[], Coroutine[Any, Any, None]],
) -> TestResult:
    """Run a single test coroutine, capturing timing and any assertion errors."""
    start = time.monotonic()
    try:
        await asyncio.wait_for(coro_fn(), timeout=REQUEST_TIMEOUT)
        elapsed_ms = (time.monotonic() - start) * 1000
        return TestResult(name=name, passed=True, elapsed_ms=elapsed_ms)
    except asyncio.TimeoutError:
        elapsed_ms = (time.monotonic() - start) * 1000
        return TestResult(
            name=name,
            passed=False,
            elapsed_ms=elapsed_ms,
            detail=f"TIMEOUT after {REQUEST_TIMEOUT}s",
        )
    except AssertionError as exc:
        elapsed_ms = (time.monotonic() - start) * 1000
        return TestResult(
            name=name,
            passed=False,
            elapsed_ms=elapsed_ms,
            detail=str(exc) or "AssertionError (no message)",
        )
    except Exception as exc:  # noqa: BLE001
        elapsed_ms = (time.monotonic() - start) * 1000
        return TestResult(
            name=name,
            passed=False,
            elapsed_ms=elapsed_ms,
            detail=f"{type(exc).__name__}: {exc}",
        )


# ---------------------------------------------------------------------------
# Individual test functions
# ---------------------------------------------------------------------------


async def test_health(client: httpx.AsyncClient) -> None:
    """GET /health returns 200 with {status: "ok"} shape."""
    # The health router registers at /api/v1/health in the router file,
    # but the legacy /health path may also be present. We target the routed path.
    resp = await client.get(f"{BASE_URL}/api/v1/health")
    assert resp.status_code == 200, (
        f"Expected 200, got {resp.status_code}: {resp.text[:200]}"
    )
    body = resp.json()
    assert "status" in body, f"Response missing 'status' key: {body}"
    assert body["status"] == "ok", f"Expected status 'ok', got {body['status']!r}"


async def test_waitlist_count(client: httpx.AsyncClient) -> None:
    """GET /api/v1/waitlist/count returns 200 with count: int."""
    resp = await client.get(f"{BASE_URL}/api/v1/waitlist/count")
    assert resp.status_code == 200, (
        f"Expected 200, got {resp.status_code}: {resp.text[:200]}"
    )
    body = resp.json()
    assert "count" in body, f"Response missing 'count' key: {body}"
    assert isinstance(body["count"], int), (
        f"Expected 'count' to be int, got {type(body['count']).__name__}: {body['count']}"
    )


async def test_login_bad_creds_returns_401(client: httpx.AsyncClient) -> None:
    """POST /api/v1/auth/login with bad credentials returns 401, not 5xx."""
    resp = await client.post(
        f"{BASE_URL}/api/v1/auth/login",
        json={"email": "nobody@example.invalid", "password": "wrong-password-smoke-test"},
    )
    assert resp.status_code == 401, (
        f"Expected 401 for bad credentials, got {resp.status_code}. "
        f"A 5xx here means an unhandled exception in the auth route. Body: {resp.text[:200]}"
    )


async def test_admin_stats_no_key_returns_401(client: httpx.AsyncClient) -> None:
    """GET /api/v1/admin/stats without admin key returns 401."""
    resp = await client.get(f"{BASE_URL}/api/v1/admin/stats")
    assert resp.status_code == 401, (
        f"Expected 401 (no auth), got {resp.status_code}: {resp.text[:200]}"
    )


async def test_admin_stats_with_key_returns_200(client: httpx.AsyncClient) -> None:
    """GET /api/v1/admin/stats with valid admin key returns 200 with expected schema."""
    if not ADMIN_KEY:
        raise AssertionError(
            "ADMIN_KEY environment variable is not set — cannot verify admin/stats endpoint"
        )
    resp = await client.get(
        f"{BASE_URL}/api/v1/admin/stats",
        headers={"Authorization": f"Bearer {ADMIN_KEY}"},
    )
    assert resp.status_code == 200, (
        f"Expected 200, got {resp.status_code}: {resp.text[:200]}"
    )
    body = resp.json()
    required_fields = {
        "total_chws",
        "total_members",
        "open_requests",
        "sessions_this_week",
        "claims_pending",
        "claims_paid_this_month",
        "total_earnings_this_month",
        "total_sessions_all_time",
    }
    missing = required_fields - set(body.keys())
    assert not missing, f"AdminStats response missing fields: {sorted(missing)}"
    for field_name in required_fields:
        val = body[field_name]
        assert isinstance(val, (int, float)), (
            f"AdminStats.{field_name} should be numeric, got {type(val).__name__}: {val}"
        )


async def test_session_transcript_no_auth_returns_401(client: httpx.AsyncClient) -> None:
    """GET /api/v1/sessions/<nil-uuid>/transcript without auth returns 401.

    This proves the transcript router is live. The nil UUID will never match a
    real session, but the auth check fires before the DB lookup.

    Note: the transcript route is a WebSocket endpoint. We hit it via HTTP to
    confirm the auth rejection fires at the HTTP upgrade layer (HTTP 401 or
    HTTP 403 depending on FastAPI's WS handling) rather than a 404.
    A 404 here means the router is not mounted — which is a deploy failure.
    """
    nil_uuid = "00000000-0000-0000-0000-000000000000"
    # WebSocket endpoints return 403 on missing auth (FastAPI default for WS
    # routes that reject the upgrade). We accept 401 or 403 — either proves
    # the route exists and auth is enforced. A 404 or 5xx is a failure.
    resp = await client.get(
        f"{BASE_URL}/api/v1/sessions/{nil_uuid}/transcript/stream",
        headers={"Connection": "Upgrade", "Upgrade": "websocket"},
    )
    assert resp.status_code in {401, 403}, (
        f"Expected 401/403 for unauthenticated transcript WS route, "
        f"got {resp.status_code}. "
        f"404 means the transcript router is not mounted. Body: {resp.text[:200]}"
    )


async def test_member_roadmap_no_auth_returns_401(client: httpx.AsyncClient) -> None:
    """GET /api/v1/member/roadmap without auth returns 401.

    Proves the roadmap endpoint is live and auth-gated.
    """
    resp = await client.get(f"{BASE_URL}/api/v1/member/roadmap")
    assert resp.status_code == 401, (
        f"Expected 401 (no auth), got {resp.status_code}. "
        f"404 means the roadmap route is not mounted. Body: {resp.text[:200]}"
    )


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


@dataclass
class SmokeTestSuite:
    """Collects and runs all smoke tests, reports results."""

    _results: list[TestResult] = field(default_factory=list)

    async def run_all(self, client: httpx.AsyncClient) -> None:
        tests: list[tuple[str, Callable[[], Coroutine[Any, Any, None]]]] = [
            ("health endpoint", lambda: test_health(client)),
            ("waitlist count", lambda: test_waitlist_count(client)),
            ("login bad creds → 401", lambda: test_login_bad_creds_returns_401(client)),
            ("admin/stats no key → 401", lambda: test_admin_stats_no_key_returns_401(client)),
            ("admin/stats with key → 200", lambda: test_admin_stats_with_key_returns_200(client)),
            ("transcript WS no auth → 401/403", lambda: test_session_transcript_no_auth_returns_401(client)),
            ("member/roadmap no auth → 401", lambda: test_member_roadmap_no_auth_returns_401(client)),
        ]

        # Run tests sequentially so output is readable; each has its own timeout.
        for name, coro_fn in tests:
            result = await _run_test(client, name, coro_fn)
            self._results.append(result)
            status_icon = _green("PASS") if result.passed else _red("FAIL")
            detail_str = f"  {_yellow(result.detail)}" if result.detail else ""
            print(f"  [{status_icon}] {name:<50} {result.elapsed_ms:>7.1f} ms{detail_str}")

    def print_summary(self) -> None:
        total = len(self._results)
        passed = sum(1 for r in self._results if r.passed)
        failed = total - passed
        total_ms = sum(r.elapsed_ms for r in self._results)

        print()
        print("─" * 70)
        if failed == 0:
            print(_green(f"  All {total} smoke tests passed  ({total_ms:.0f} ms total)"))
        else:
            print(_red(f"  {failed}/{total} smoke tests FAILED  ({total_ms:.0f} ms total)"))
            print()
            print("  Failures:")
            for r in self._results:
                if not r.passed:
                    print(f"    • {r.name}: {r.detail}")
        print("─" * 70)

    @property
    def all_passed(self) -> bool:
        return all(r.passed for r in self._results)


async def main() -> int:
    """Entry point. Returns exit code (0 = all passed, 1 = any failed)."""
    print()
    print(f"CompassCHW smoke test suite")
    print(f"Target: {BASE_URL}")
    print(f"Admin key: {'set' if ADMIN_KEY else _red('NOT SET — admin/stats test will fail')}")
    print()

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(REQUEST_TIMEOUT + 2.0),
        follow_redirects=False,
    ) as client:
        suite = SmokeTestSuite()
        await suite.run_all(client)
        suite.print_summary()
        return 0 if suite.all_passed else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
