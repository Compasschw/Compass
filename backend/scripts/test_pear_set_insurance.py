"""Probe: try to set the member's insurance so claim generation can resolve it.

Pear's claim-generation rejected with "Could not resolve an insurance for the
claim". The member's GET response shows ``primaryHealthPlanId``,
``insuranceDetails[]``, and ``primaryInsuranceType`` all null.

We don't know which endpoint accepts insurance writes, so this probe tries
the most likely paths in order and prints what each one returns.

Run::

    sudo docker compose cp scripts/test_pear_set_insurance.py api:/tmp/i.py
    sudo docker compose exec -T -e PYTHONPATH=/code api python /tmp/i.py
"""
from __future__ import annotations

import asyncio
import json
import os

import httpx

from app.config import settings


DEFAULT_MEMBER_ID = "0d5a0a26-b5a1-44a7-a7ec-17cd9dd85190"
MEMBER_ID = os.environ.get("PEAR_TEST_MEMBER_ID") or DEFAULT_MEMBER_ID

# Health Net insuranceConfigurationId — extracted from the activity response
# we just got back, where Pear nested its full insurance config object.
HEALTH_NET_CONFIG_ID = "423697cd-3bec-45e2-b0c2-dc731901ad9d"
HEALTH_NET_FAMILY_ID = "b35b8b7d-fced-4be0-bdeb-1658d4ebf712"


async def _try(client: httpx.AsyncClient, method: str, path: str, body: dict, label: str) -> None:
    print(f"\n=== {method} {path} ({label}) ===")
    print("body =", json.dumps(body, indent=2))
    response = await client.request(method, path, json=body)
    print("HTTP", response.status_code)
    try:
        print(json.dumps(response.json(), indent=2))
    except ValueError:
        print(response.text[:500])


async def main() -> None:
    async with httpx.AsyncClient(
        base_url=settings.pear_suite_base_url,
        headers={
            "api-key": settings.pear_suite_api_key,
            "Content-Type": "application/json",
        },
        timeout=30.0,
    ) as client:
        # Try 1 — top-level primaryHealthPlanId via PUT /members/:id
        await _try(
            client,
            "PUT",
            f"/api/beta/members/{MEMBER_ID}",
            {"primaryHealthPlanId": HEALTH_NET_CONFIG_ID},
            "PUT primaryHealthPlanId top-level",
        )

        # Try 2 — same but PATCH
        await _try(
            client,
            "PATCH",
            f"/api/beta/members/{MEMBER_ID}",
            {"primaryHealthPlanId": HEALTH_NET_CONFIG_ID},
            "PATCH primaryHealthPlanId top-level",
        )

        # Try 3 — primaryInsuranceCompany inside insuranceDetails on PUT
        await _try(
            client,
            "PUT",
            f"/api/beta/members/{MEMBER_ID}",
            {
                "insuranceDetails": [
                    {"primaryInsuranceCompany": HEALTH_NET_CONFIG_ID}
                ]
            },
            "PUT insuranceDetails[].primaryInsuranceCompany",
        )

        # Try 4 — dedicated sub-resource POST
        await _try(
            client,
            "POST",
            f"/api/beta/members/{MEMBER_ID}/insurance",
            {
                "primaryInsuranceCompany": HEALTH_NET_CONFIG_ID,
                "primaryInsuranceType": "Medicaid",
            },
            "POST /members/:id/insurance",
        )

        # Try 5 — primaryHealthPlanFamilyId rather than config
        await _try(
            client,
            "PUT",
            f"/api/beta/members/{MEMBER_ID}",
            {"primaryHealthPlanFamilyId": HEALTH_NET_FAMILY_ID},
            "PUT primaryHealthPlanFamilyId",
        )

        # Sanity: GET to see which (if any) attempt actually stuck.
        print(f"\n=== GET /api/beta/members/{MEMBER_ID} (final state) ===")
        get_response = await client.get(f"/api/beta/members/{MEMBER_ID}")
        body = get_response.json().get("data", {})
        print(json.dumps({
            "primaryHealthPlanId": body.get("primaryHealthPlanId"),
            "primaryInsuranceType": body.get("primaryInsuranceType"),
            "insuranceDetails": body.get("insuranceDetails"),
            "primaryCIN": body.get("primaryCIN"),
        }, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
