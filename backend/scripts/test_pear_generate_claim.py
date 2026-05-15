"""Generate a claim from the most recent Complete billable activity.

Goal: get a claim row to appear in the Pear dashboard's Claims view.

Strategy mirrors PearSuiteProvider.generate_claim:
  1. POST /api/beta/claims with { memberId } only.
  2. If that returns 4xx, retry with { memberId, billId: <activityId> }.
  3. Print whatever Pear returns so we know which path worked.

Run::

    sudo docker compose cp scripts/test_pear_generate_claim.py api:/tmp/c.py
    sudo docker compose exec -T -e PYTHONPATH=/code api python /tmp/c.py
"""
from __future__ import annotations

import asyncio
import json
import os

import httpx

from app.config import settings


# Member with a Complete billable activity attached (Health Net costId).
DEFAULT_MEMBER_ID = "0d5a0a26-b5a1-44a7-a7ec-17cd9dd85190"
MEMBER_ID = os.environ.get("PEAR_TEST_MEMBER_ID") or DEFAULT_MEMBER_ID

# Last activity we completed in the Health Net billing run. Used as fallback
# billId if the bare memberId POST is rejected.
DEFAULT_ACTIVITY_ID = "201e1cf1-01f3-4aa2-90a0-1a3bcaeacfa3"
ACTIVITY_ID = os.environ.get("PEAR_TEST_ACTIVITY_ID") or DEFAULT_ACTIVITY_ID


async def _try_claim(client: httpx.AsyncClient, payload: dict, label: str) -> int:
    print(f"\n=== POST /api/beta/claims ({label}) ===")
    print("payload =", json.dumps(payload, indent=2))
    response = await client.post("/api/beta/claims", json=payload)
    print("HTTP", response.status_code)
    try:
        print(json.dumps(response.json(), indent=2))
    except ValueError:
        print(response.text)
    return response.status_code


async def main() -> None:
    async with httpx.AsyncClient(
        base_url=settings.pear_suite_base_url,
        headers={
            "api-key": settings.pear_suite_api_key,
            "Content-Type": "application/json",
        },
        timeout=30.0,
    ) as client:
        # First try: bare memberId — Pear may auto-resolve from the most
        # recent Complete bills.
        status = await _try_claim(
            client,
            {"memberId": MEMBER_ID},
            "memberId only",
        )

        if status >= 400:
            # Retry with explicit billId pointing at the activity.
            await _try_claim(
                client,
                {"memberId": MEMBER_ID, "billId": ACTIVITY_ID},
                "memberId + billId=activityId",
            )

        print(
            "\nRefresh the Pear dashboard's Claims view (not Members) — a new "
            "claim row should appear if either attempt succeeded.",
        )


if __name__ == "__main__":
    asyncio.run(main())
