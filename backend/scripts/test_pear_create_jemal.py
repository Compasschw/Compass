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
    # Contact info goes inside the contactInfo wrapper. Phone field is
    # ``primaryPhoneNumberDigits`` and Pear wants raw digits, no + or formatting.
    # phoneNumbers is an array of objects with explicit type.
    "contactInfo": {
        "primaryPhoneNumberDigits": "3102103402",
        "phoneNumbers": [
            {"digits": "3102103402", "type": "Mobile", "doNotCall": False},
        ],
        "email": "jemal+test@joincompasschw.com",
    },
    # Address sub-fields use the *Name suffix Pear's schema requires.
    # Pear rejects null on optional fields — omit address2 entirely.
    "address": {
        "address": "1234 Veteran Ave",
        "cityName": "Los Angeles",
        "stateName": "CA",
        "countryName": "US",
        "zip": "90210",
    },
    # Medi-Cal ID — Pear's read-shape exposes primaryCIN at top level. Try
    # there; if still null on GET, the field may need PATCH on a sub-resource.
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
