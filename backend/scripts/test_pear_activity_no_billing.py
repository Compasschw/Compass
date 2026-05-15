"""End-to-end test: schedule activity -> complete WITHOUT billing.

Validates that we can run an activity through Pear's lifecycle up to (but
excluding) the billing step. Stops short of `billingDetails` because Pear
requires a ``costId`` we don't yet know how to obtain — that's the open
question for Friday's PearSuite meeting.

Reuses an EXISTING "Jemal Test" Pear member (default: the one most recently
created). Override the id via env::

    sudo docker compose exec -T \
        -e PYTHONPATH=/code \
        -e PEAR_TEST_MEMBER_ID=<uuid> \
        api python /tmp/a.py

Run::

    sudo docker compose cp scripts/test_pear_activity_no_billing.py api:/tmp/a.py
    sudo docker compose exec -T -e PYTHONPATH=/code api python /tmp/a.py
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timedelta, timezone

import httpx

from app.config import settings


# ─── Existing Pear member id (Jemal Test, fully populated profile) ──────────
#
# Override via PEAR_TEST_MEMBER_ID env if you've manually deleted this one
# in Pear's dashboard and have a fresher id you want to use instead.

DEFAULT_MEMBER_ID = "0d5a0a26-b5a1-44a7-a7ec-17cd9dd85190"
MEMBER_ID = os.environ.get("PEAR_TEST_MEMBER_ID") or DEFAULT_MEMBER_ID


# ─── Activity inputs (Jemal as CHW + the 98960 CHW template) ──────────────────
#
# These are the values we've previously proven work against Pear's prod API.
# Stored in env via PEAR_SUITE_DEMO_CHW_USER_ID + PEAR_SUITE_DEMO_TEMPLATE_ID
# (config.py); fall back to the hardcoded values from the memory tracker if
# unset so this script Just Works without env tweaks.

JEMAL_PEAR_USER_ID = (
    settings.pear_suite_demo_chw_user_id
    or "3f205159-f1b3-43c0-a875-dec3ecc97025"
)
ACTIVITY_TEMPLATE_ID = (
    settings.pear_suite_demo_template_id
    or "cb5875f0-444d-448f-9700-996c2ab65817"
)


async def _verify_member(client: httpx.AsyncClient, member_id: str) -> None:
    """Sanity-check the member still exists in Pear before scheduling."""
    print(f"=== GET /api/beta/members/{member_id} (sanity check) ===")
    response = await client.get(f"/api/beta/members/{member_id}")
    print("HTTP", response.status_code)
    if response.status_code != 200:
        print(response.text)
        raise SystemExit(
            "Member not found in Pear. Delete the wrong id, override via "
            "PEAR_TEST_MEMBER_ID, or re-create with test_pear_create_jemal.py."
        )
    body = response.json()
    member = body.get("data", {})
    print(
        "OK —", member.get("firstName"), member.get("lastName"),
        "(dob", member.get("dob"), "sex", member.get("sex") + ")",
    )


async def _schedule_activity(
    client: httpx.AsyncClient,
    member_id: str,
) -> str:
    now = datetime.now(timezone.utc)
    end = now + timedelta(minutes=15)
    payload = {
        "userId": JEMAL_PEAR_USER_ID,
        "memberIds": [member_id],
        "activityTemplateId": ACTIVITY_TEMPLATE_ID,
        "date": now.date().isoformat(),
        "scheduledStartAt": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "scheduledEndAt": end.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }
    print("\n=== POST /api/beta/activities ===")
    print("payload =", json.dumps(payload, indent=2))
    response = await client.post("/api/beta/activities", json=payload)
    print("HTTP", response.status_code)
    body = response.json()
    print(json.dumps(body, indent=2))
    nested = body.get("data") if isinstance(body, dict) else None
    activity_id = (
        (nested or {}).get("activityId")
        or (nested or {}).get("_id")
        or (nested or {}).get("id")
        or body.get("activityId")
        or body.get("_id")
        or body.get("id")
    )
    if not activity_id:
        raise SystemExit("Could not extract activity id — aborting.")
    return activity_id


async def _complete_activity_no_billing(
    client: httpx.AsyncClient,
    activity_id: str,
) -> None:
    payload = {"status": "Complete", "billable": False}
    print(f"\n=== PUT /api/beta/activities/{activity_id} (no-billing complete) ===")
    print("payload =", json.dumps(payload, indent=2))
    response = await client.put(
        f"/api/beta/activities/{activity_id}", json=payload
    )
    print("HTTP", response.status_code)
    try:
        print(json.dumps(response.json(), indent=2))
    except ValueError:
        print(response.text)


async def _fetch_activity(
    client: httpx.AsyncClient,
    activity_id: str,
) -> None:
    print(f"\n=== GET /api/beta/activities/{activity_id} (final state) ===")
    response = await client.get(f"/api/beta/activities/{activity_id}")
    print("HTTP", response.status_code)
    try:
        print(json.dumps(response.json(), indent=2))
    except ValueError:
        print(response.text)


async def main() -> None:
    async with httpx.AsyncClient(
        base_url=settings.pear_suite_base_url,
        headers={
            "api-key": settings.pear_suite_api_key,
            "Content-Type": "application/json",
        },
        timeout=30.0,
    ) as client:
        await _verify_member(client, MEMBER_ID)
        activity_id = await _schedule_activity(client, MEMBER_ID)
        await _complete_activity_no_billing(client, activity_id)
        await _fetch_activity(client, activity_id)


if __name__ == "__main__":
    asyncio.run(main())
