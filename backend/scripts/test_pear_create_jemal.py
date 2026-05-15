"""One-off test: create "Jemal Test" member directly on PearSuite.

Hits POST /api/beta/members against the production Pear API using the
configured ``PEAR_SUITE_API_KEY``. Does not touch Compass DB — purely a
contract test to confirm the payload shape Pear accepts before we wire up
the Compass-side member-profile wizard.

Run from inside the api container::

    sudo docker compose cp scripts/test_pear_create_jemal.py api:/tmp/t.py
    sudo docker compose exec -T api python /tmp/t.py

Fields intentionally omitted (open questions for Friday's Pear meeting):
    * ``gender`` — Pear has rejected every enum value tested
    * ``insuranceCompanyId`` — no public list endpoint we've found
"""
from __future__ import annotations

import asyncio
import json

import httpx

from app.config import settings


PAYLOAD: dict = {
    # Identity
    "firstName": "Jemal",
    "lastName": "Test",
    "dob": "1993-01-05",
    "sex": "Male",
    "spokenLanguages": ["English"],
    # Contact — verified from prior GET: phoneNumbers + primaryPhoneNumber are
    # top-level; contactInfo wrapper was wrong.
    "primaryPhoneNumber": "+13101234567",
    "phoneNumbers": ["+13101234567"],
    "email": "jemal+test@joincompasschw.com",
    # Address — POST wants an OBJECT (GET serialises flat). Sub-keys mirror
    # the GET shape: address (line 1) / address2 (line 2) / city / state /
    # country / zip.
    # Pear rejects nulls in optional sub-fields — omit unset keys entirely.
    "address": {
        "address": "1234 Veteran Ave",
        "city": "Los Angeles",
        "state": "CA",
        "country": "US",
        "zip": "90210",
    },
    # Medi-Cal ID — Pear's field is primaryCIN (uppercase CIN).
    "primaryCIN": "12345678A",
}


async def main() -> None:
    async with httpx.AsyncClient(
        base_url=settings.pear_suite_base_url,
        headers={
            "api-key": settings.pear_suite_api_key,
            "Content-Type": "application/json",
        },
        timeout=30.0,
    ) as client:
        # 1. Create the member.
        post_response = await client.post("/api/beta/members", json=PAYLOAD)
        print("=== POST /api/beta/members ===")
        print("HTTP", post_response.status_code)
        try:
            post_body = post_response.json()
        except ValueError:
            print("(non-json body)")
            print(post_response.text)
            return
        print(json.dumps(post_body, indent=2))

        # 2. Pull the member back so we can see what Pear actually stored.
        # The id may be at top level or nested under "data".
        nested = post_body.get("data") if isinstance(post_body, dict) else None
        member_id = (
            (nested or {}).get("memberId")
            or (nested or {}).get("_id")
            or (nested or {}).get("id")
            or post_body.get("memberId")
            or post_body.get("_id")
            or post_body.get("id")
        )
        if not member_id:
            print("\n(could not find member id in POST response — skipping GET)")
            return

        print(f"\n=== GET /api/beta/members/{member_id} ===")
        get_response = await client.get(f"/api/beta/members/{member_id}")
        print("HTTP", get_response.status_code)
        try:
            print(json.dumps(get_response.json(), indent=2))
        except ValueError:
            print("(non-json body)")
            print(get_response.text)


if __name__ == "__main__":
    asyncio.run(main())
