"""End-to-end Pear claim chain against the pre-configured "Test Tester" member.

Test Tester (memberId d25bcbc0-...) was set up manually in the Pear dashboard
with Blue Shield of California - Promise Plan as primaryInsuranceCompany and
12345678A as primaryCIN. Because those two fields are already populated, we
can drive the full chain to a real claim row tonight without solving the
insurance / CIN write-path question (still open for Friday).

Steps::

    1. GET  /api/beta/members/:id          (sanity check)
    2. POST /api/beta/activities           (schedule Jemal as CHW for Test Tester)
    3. PUT  /api/beta/activities/:id       (Complete + billable=true + costId)
    4. POST /api/beta/claims               (generate claim; should land in dashboard)

Run::

    sudo docker compose cp scripts/test_pear_full_claim_chain.py api:/tmp/full.py
    sudo docker compose exec -T -e PYTHONPATH=/code api python /tmp/full.py
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx

from app.config import settings


# ─── Hard-coded test inputs (matches what's already set in Pear's UI) ────────

# Test Tester member — Blue Shield Promise + CIN 12345678A pre-configured.
MEMBER_ID = "d25bcbc0-6d66-4d71-9bc7-8f3a58ccb169"

# Jemal as CHW + the 98960 template (already proven).
USER_ID = settings.pear_suite_demo_chw_user_id or "3f205159-f1b3-43c0-a875-dec3ecc97025"
ACTIVITY_TEMPLATE_ID = (
    settings.pear_suite_demo_template_id or "cb5875f0-444d-448f-9700-996c2ab65817"
)

# Blue Shield of California - Promise Plan costId for "CHW Service 1 Person".
COST_ID = "a553f4ed-d5a4-43fa-82e9-c6b22045fa40"

# Telehealth + a generic CHW counseling diagnosis.
PLACE_OF_SERVICE = 2
DIAGNOSIS_CODES = ["Z71.89"]


def _print_section(title: str) -> None:
    print(f"\n{'=' * 8} {title} {'=' * 8}")


async def main() -> None:
    async with httpx.AsyncClient(
        base_url=settings.pear_suite_base_url,
        headers={
            "api-key": settings.pear_suite_api_key,
            "Content-Type": "application/json",
        },
        timeout=30.0,
    ) as client:
        # ── 1. Sanity check Test Tester still has the insurance + CIN we expect.
        _print_section("GET member (sanity)")
        r = await client.get(f"/api/beta/members/{MEMBER_ID}")
        if r.status_code != 200:
            print("HTTP", r.status_code, r.text)
            raise SystemExit("Test Tester not found.")
        member = r.json().get("data", {})
        print(json.dumps({
            "name": f'{member.get("firstName")} {member.get("lastName")}',
            "primaryHealthPlanId": member.get("primaryHealthPlanId"),
            "primaryInsuranceType": member.get("primaryInsuranceType"),
            "primaryCIN": member.get("primaryCIN"),
        }, indent=2))
        if not member.get("primaryCIN"):
            print(
                "\n⚠️  Test Tester is missing primaryCIN — claim will likely "
                "fail. Continuing anyway so we capture the error.",
            )

        # ── 2. Schedule a billable activity for today.
        start = datetime.now(timezone.utc)
        end = start + timedelta(minutes=15)
        post_payload = {
            "userId": USER_ID,
            "memberIds": [MEMBER_ID],
            "activityTemplateId": ACTIVITY_TEMPLATE_ID,
            "date": start.date().isoformat(),
            "scheduledStartAt": start.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "scheduledEndAt": end.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        }
        _print_section("POST /activities")
        print("payload =", json.dumps(post_payload, indent=2))
        r = await client.post("/api/beta/activities", json=post_payload)
        print("HTTP", r.status_code)
        body = r.json()
        activity_id = (body.get("data") or {}).get("_id")
        if not activity_id:
            print(json.dumps(body, indent=2))
            raise SystemExit("Activity create failed.")
        print(f"activity_id = {activity_id}")

        # ── 3. Complete the activity with full billingDetails (Blue Shield Promise).
        put_payload = {
            "status": "Complete",
            "billable": True,
            "billingDetails": [
                {
                    "memberId": MEMBER_ID,
                    "costId": COST_ID,
                    "placeOfService": PLACE_OF_SERVICE,
                    "diagnosisCodes": DIAGNOSIS_CODES,
                },
            ],
        }
        _print_section(f"PUT /activities/{activity_id} (Complete)")
        print("payload =", json.dumps(put_payload, indent=2))
        r = await client.put(f"/api/beta/activities/{activity_id}", json=put_payload)
        print("HTTP", r.status_code)
        if r.status_code >= 400:
            print(json.dumps(r.json(), indent=2))
            raise SystemExit("Activity completion failed — cannot proceed to claim.")
        print("activity completed ✅")

        # ── 4. Generate claim.
        _print_section("POST /claims (memberId only)")
        r = await client.post("/api/beta/claims", json={"memberId": MEMBER_ID})
        print("HTTP", r.status_code)
        try:
            print(json.dumps(r.json(), indent=2))
        except ValueError:
            print(r.text)

        if r.status_code >= 400:
            _print_section("POST /claims (memberId + billId=activityId)")
            r2 = await client.post(
                "/api/beta/claims",
                json={"memberId": MEMBER_ID, "billId": activity_id},
            )
            print("HTTP", r2.status_code)
            try:
                print(json.dumps(r2.json(), indent=2))
            except ValueError:
                print(r2.text)


if __name__ == "__main__":
    asyncio.run(main())
