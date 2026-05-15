"""End-to-end test: create member -> schedule activity -> complete WITHOUT billing.

Validates that we can run an activity through Pear's lifecycle up to (but
excluding) the billing step. Stops short of `billingDetails` because Pear
requires a ``costId`` we don't yet know how to obtain — that's the open
question for Friday's PearSuite meeting.

Run from inside the api container::

    sudo docker compose cp scripts/test_pear_activity_no_billing.py api:/tmp/a.py
    sudo docker compose exec -T -e PYTHONPATH=/code api python /tmp/a.py

Expected result: HTTP 201 on member, HTTP 201 on activity, HTTP 200 on the
PUT-to-Complete. The final GET prints the activity in its Complete state.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx

from app.config import settings


# ─── Member payload (mirrors test_pear_create_jemal.py — full working shape) ─

MEMBER_PAYLOAD: dict = {
    "firstName": "Jemal",
    "lastName": "Test",
    "dob": "1993-01-05",
    "sex": "Male",
    "spokenLanguages": ["English"],
    "contactInfo": {
        "primaryPhoneNumberDigits": "3102103402",
        "phoneNumbers": [
            {"digits": "3102103402", "type": "Mobile", "doNotCall": False},
        ],
        "email": "jemal+test@joincompasschw.com",
    },
    "address": {
        "address": "1234 Veteran Ave",
        "cityName": "Los Angeles",
        "stateName": "CA",
        "countryName": "US",
        "zip": "90210",
    },
}


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


async def _create_member(client: httpx.AsyncClient) -> str:
    print("=== POST /api/beta/members ===")
    response = await client.post("/api/beta/members", json=MEMBER_PAYLOAD)
    print("HTTP", response.status_code)
    body = response.json()
    print(json.dumps(body, indent=2))
    member_id = (body.get("data") or {}).get("memberId")
    if not member_id:
        raise SystemExit("Could not create member — aborting.")
    return member_id


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
        member_id = await _create_member(client)
        activity_id = await _schedule_activity(client, member_id)
        await _complete_activity_no_billing(client, activity_id)
        await _fetch_activity(client, activity_id)


if __name__ == "__main__":
    asyncio.run(main())
