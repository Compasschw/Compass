"""Tests for the health + readiness endpoints (audit 2026-06-12 #17).

Pins the contract that:
- default /health is presence-only and makes NO outbound vendor calls
- /health?deep=true runs the real per-vendor pings and surfaces their results
- a failing dependency ping flips overall status to "degraded" (still HTTP 200)
- /ready is DB-only
"""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_default_is_presence_only_no_outbound_calls(client: AsyncClient):
    """Default /health must not invoke the deep vendor pings."""
    with (
        patch("app.routers.health._ping_vonage", new_callable=AsyncMock) as v,
        patch("app.routers.health._ping_assemblyai", new_callable=AsyncMock) as a,
        patch("app.routers.health._ping_stripe", new_callable=AsyncMock) as s,
    ):
        resp = await client.get("/api/v1/health")

    assert resp.status_code == 200
    body = resp.json()
    assert body["checks"]["database"] == "ok"
    # Crucially: no deep pings fired on the default path.
    v.assert_not_awaited()
    a.assert_not_awaited()
    s.assert_not_awaited()


@pytest.mark.asyncio
async def test_health_deep_runs_vendor_pings(client: AsyncClient):
    """/health?deep=true must surface the per-vendor ping results."""
    with (
        patch("app.routers.health._ping_vonage", new_callable=AsyncMock, return_value="ok") as v,
        patch("app.routers.health._ping_assemblyai", new_callable=AsyncMock, return_value="ok") as a,
        patch("app.routers.health._ping_stripe", new_callable=AsyncMock, return_value="ok") as s,
    ):
        resp = await client.get("/api/v1/health?deep=true")

    assert resp.status_code == 200
    body = resp.json()
    # Overall status also folds in the scheduler check, which is stopped under
    # pytest — so assert the vendor checks specifically rather than the aggregate.
    assert body["checks"]["vonage"] == "ok"
    assert body["checks"]["assemblyai"] == "ok"
    assert body["checks"]["stripe"] == "ok"
    v.assert_awaited_once()
    a.assert_awaited_once()
    s.assert_awaited_once()


@pytest.mark.asyncio
async def test_health_deep_degraded_when_a_vendor_ping_fails(client: AsyncClient):
    """A failing dependency ping → status 'degraded', still HTTP 200."""
    with (
        patch("app.routers.health._ping_vonage", new_callable=AsyncMock, return_value="ok"),
        patch("app.routers.health._ping_assemblyai", new_callable=AsyncMock, return_value="ok"),
        patch(
            "app.routers.health._ping_stripe",
            new_callable=AsyncMock,
            return_value="error: AuthenticationError",
        ),
    ):
        resp = await client.get("/api/v1/health?deep=true")

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "degraded"
    assert body["checks"]["stripe"].startswith("error:")


@pytest.mark.asyncio
async def test_ping_helpers_skip_outbound_when_key_missing():
    """Each ping returns a 'missing'/'skipped' status without an outbound call
    when its credential is absent."""
    from app.routers import health

    with patch.object(health.settings, "stripe_secret_key", ""):
        assert (await health._ping_stripe()).startswith("missing")
    with (
        patch.object(health.settings, "vonage_api_key", ""),
        patch.object(health.settings, "vonage_api_secret", ""),
    ):
        assert (await health._ping_vonage()).startswith("missing")
    with patch.object(health.settings, "transcription_provider", "deepgram"):
        assert (await health._ping_assemblyai()).startswith("skipped")


@pytest.mark.asyncio
async def test_ready_returns_ready(client: AsyncClient):
    resp = await client.get("/api/v1/ready")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ready"}
