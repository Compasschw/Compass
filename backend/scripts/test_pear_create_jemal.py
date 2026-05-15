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
    "firstName": "Jemal",
    "lastName": "Test",
    "dateOfBirth": "1993-01-05",
    "phone": "+13101234567",
    "language": ["English"],
    "mediCalId": "12345678A",
    "address": {
        "line1": "1234 Veteran Ave",
        "city": "Los Angeles",
        "state": "CA",
        "zip": "90210",
    },
}


async def main() -> None:
    async with httpx.AsyncClient(
        base_url=settings.pear_suite_base_url,
        headers={
            "Authorization": "Bearer " + settings.pear_suite_api_key,
            "Content-Type": "application/json",
        },
        timeout=30.0,
    ) as client:
        response = await client.post("/api/beta/members", json=PAYLOAD)

    print("HTTP", response.status_code)
    try:
        body = response.json()
    except ValueError:
        print("(non-json body)")
        print(response.text)
        return
    print(json.dumps(body, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
