"""POST schedule -> PUT update: follow Pear's documented activity flow.

Two-step run on the existing Jemal Test member:

1. ``POST /api/beta/activities`` — schedule an activity (template inherits
   billable=true).
2. ``PUT /api/beta/activities/:id`` — transition to ``Complete`` with
   ``billable: true``. Deliberately omits ``billingDetails`` so we observe
   Pear's exact error if it demands ``costId``. If Pear accepts without
   billingDetails, the activity is fully completed and shows up in the
   profile's billing-activities section.

Run::

    sudo docker compose cp scripts/test_pear_schedule_billing_activity.py api:/tmp/b.py
    sudo docker compose exec -T -e PYTHONPATH=/code api python /tmp/b.py
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime, timedelta, timezone

import httpx

from app.config import settings


DEFAULT_MEMBER_ID = "0d5a0a26-b5a1-44a7-a7ec-17cd9dd85190"
MEMBER_ID = os.environ.get("PEAR_TEST_MEMBER_ID") or DEFAULT_MEMBER_ID

JEMAL_PEAR_USER_ID = (
    settings.pear_suite_demo_chw_user_id
    or "3f205159-f1b3-43c0-a875-dec3ecc97025"
)
ACTIVITY_TEMPLATE_ID = (
    settings.pear_suite_demo_template_id
    or "cb5875f0-444d-448f-9700-996c2ab65817"
)


async def main() -> None:
    async with httpx.AsyncClient(
        base_url=settings.pear_suite_base_url,
        headers={
            "api-key": settings.pear_suite_api_key,
            "Content-Type": "application/json",
        },
        timeout=30.0,
    ) as client:
        # ── Step 1: schedule the activity (Scheduled, billable=true by default)
        start = datetime.now(timezone.utc)
        end = start + timedelta(minutes=15)
        post_payload = {
            "userId": JEMAL_PEAR_USER_ID,
            "memberIds": [MEMBER_ID],
            "activityTemplateId": ACTIVITY_TEMPLATE_ID,
            "date": start.date().isoformat(),
            "scheduledStartAt": start.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "scheduledEndAt": end.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        }
        print("=== POST /api/beta/activities ===")
        print("payload =", json.dumps(post_payload, indent=2))
        post_response = await client.post(
            "/api/beta/activities", json=post_payload
        )
        print("HTTP", post_response.status_code)
        post_body = post_response.json()
        print(json.dumps(post_body, indent=2))

        post_data = post_body.get("data") if isinstance(post_body, dict) else {}
        activity_id = post_data.get("_id") if post_data else None
        if not activity_id:
            raise SystemExit("Could not extract activity id from POST response.")

        # ── Step 2: PUT the activity to Complete with billable=true. We
        # deliberately omit billingDetails so we observe what Pear says when
        # asked to complete a billable activity without the cost-side data.
        put_payload = {
            "status": "Complete",
            "billable": True,
        }
        print(
            f"\n=== PUT /api/beta/activities/{activity_id} "
            "(Complete, billable=true, no billingDetails) ==="
        )
        print("payload =", json.dumps(put_payload, indent=2))
        put_response = await client.put(
            f"/api/beta/activities/{activity_id}", json=put_payload
        )
        print("HTTP", put_response.status_code)
        try:
            print(json.dumps(put_response.json(), indent=2))
        except ValueError:
            print(put_response.text)

        print(
            "\nRefresh Jemal Test's profile in the Pear dashboard — the "
            "activity should appear under the billing-activities section.",
        )


if __name__ == "__main__":
    asyncio.run(main())
