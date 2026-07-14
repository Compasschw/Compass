"""Regression tests for Epic G1 (assigned-CHW endpoint), G3 (first-login-gated
member status), and H1 (Members-page created-date + full CIN columns).

Coverage:
  G3 — User.first_login_at
    1. Self-service /auth/register stamps first_login_at immediately
       (auto-login) — the user never has to separately call /login.
    2. A CHW-created member (POST /chw/members) does NOT get first_login_at
       stamped — the CHW acting on the member's behalf is not the member
       signing in.
    3. /auth/login stamps first_login_at the first time a user with it NULL
       (e.g. a CHW-created member) logs in.
    4. /auth/login is idempotent — a second login does not move an
       already-set first_login_at.

  G3 — CHW Members roster status derivation (chw.py list_chw_members)
    5. A CHW-created member with real activity (a scheduled session) but who
       has never logged in is 'inactive'. FAILS on the pre-fix code (which
       only looked at session/request activity and would have called this
       member 'active').
    6. The SAME member flips to 'active' once they log in (with the
       activity still present).
    7. A signed-in member with no recent session/open request is 'inactive'
       (existing activity-based behavior preserved for signed-in members).

  G1 — GET /api/v1/member/chw
    8. CHW-role caller is rejected (403).
    9. A member with no matched CHW gets 200 + null.
   10. A CHW-created member (zero sessions) still resolves to their matched
       CHW — this is the crux of the G1 fix: the endpoint reads
       ServiceRequest.matched_chw_id directly, not session history.

  H1 — MembersRosterItem new fields
   11. created_at is present and matches User.created_at.
   12. medi_cal_id is the FULL (unmasked) CIN, distinct from masked_id.
   13. medi_cal_id is null when the member has no medi_cal_id on file.
"""
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header, complete_member_signup_payload
from tests.conftest import test_session as _session_factory

pytestmark = pytest.mark.asyncio


# ─── Helpers ───────────────────────────────────────────────────────────────────


def _decode_jwt_sub(access_token: str) -> str:
    import base64
    import json

    payload_segment = access_token.split(".")[1]
    padded = payload_segment + "=" * (4 - len(payload_segment) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded))
    return payload["sub"]


async def _get_user_first_login_at(user_id: UUID | str):
    from app.models.user import User

    async with _session_factory() as db:
        user = await db.get(User, UUID(str(user_id)))
        return user.first_login_at if user else None


_NEW_MEMBER_PAYLOAD = {
    "email": "g1g3.newmember@example.com",
    "temp_password": "Temp-pass-1234!",
    "name": "Grace Newmember",
    "phone": "+13105550142",
    "date_of_birth": "1990-04-12",
    "gender": "Female",
    "insurance_company": "Health Net",
    "medi_cal_id": "91234567A",
    "address_line1": "742 Evergreen Ter",
    "address_line2": "Apt 3",
    "city": "Los Angeles",
    "state": "CA",
    "zip_code": "90001",
    "terms_accepted": True,
    "communications_consent": True,
}


async def _create_chw_member(client: AsyncClient, chw_tokens: dict) -> str:
    res = await client.post(
        "/api/v1/chw/members",
        json=_NEW_MEMBER_PAYLOAD,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    return res.json()["id"]


async def _schedule_session_for_member(
    client: AsyncClient, chw_tokens: dict, member_id: str
) -> None:
    """Schedule a near-future session for a CHW-created member, relying on the
    matched ServiceRequest create_chw_member already wrote (no prior request
    needed — mirrors test_relationship_lets_chw_schedule_with_member)."""
    scheduled_at = (datetime.now(UTC) + timedelta(hours=2)).isoformat()
    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": member_id,
            "scheduled_at": scheduled_at,
            "mode": "in_person",
            "scheduling_status": "confirmed",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text


# ─── G3: first_login_at write sites ────────────────────────────────────────────


async def test_self_register_stamps_first_login_at(client: AsyncClient):
    """Self-service registration auto-logs the user in — this counts as their
    first login (no separate /auth/login call is required)."""
    payload = complete_member_signup_payload(email="selfreg.firstlogin@example.com")
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    user_id = _decode_jwt_sub(res.json()["access_token"])

    first_login_at = await _get_user_first_login_at(user_id)
    assert first_login_at is not None


async def test_chw_created_member_has_no_first_login_at(
    client: AsyncClient, chw_tokens: dict
):
    """A CHW provisioning a member's account is NOT the member signing in —
    first_login_at must stay NULL until the member logs in themselves."""
    member_id = await _create_chw_member(client, chw_tokens)

    first_login_at = await _get_user_first_login_at(member_id)
    assert first_login_at is None


async def test_login_stamps_first_login_at_when_null(
    client: AsyncClient, chw_tokens: dict
):
    """The member's FIRST /auth/login call (using the CHW-supplied temp
    password) is what stamps first_login_at."""
    member_id = await _create_chw_member(client, chw_tokens)
    assert await _get_user_first_login_at(member_id) is None

    login = await client.post(
        "/api/v1/auth/login",
        json={
            "email": _NEW_MEMBER_PAYLOAD["email"],
            "password": _NEW_MEMBER_PAYLOAD["temp_password"],
        },
    )
    assert login.status_code == 200, login.text

    first_login_at = await _get_user_first_login_at(member_id)
    assert first_login_at is not None


async def test_login_does_not_move_an_already_set_first_login_at(
    client: AsyncClient, chw_tokens: dict
):
    """A second (and later) login must not overwrite the recorded first-login
    timestamp — it is a one-time signal, not a presence heartbeat."""
    member_id = await _create_chw_member(client, chw_tokens)
    login_body = {
        "email": _NEW_MEMBER_PAYLOAD["email"],
        "password": _NEW_MEMBER_PAYLOAD["temp_password"],
    }

    first = await client.post("/api/v1/auth/login", json=login_body)
    assert first.status_code == 200, first.text
    first_stamp = await _get_user_first_login_at(member_id)
    assert first_stamp is not None

    second = await client.post("/api/v1/auth/login", json=login_body)
    assert second.status_code == 200, second.text
    second_stamp = await _get_user_first_login_at(member_id)
    assert second_stamp == first_stamp


# ─── QA-batch #13: CHW Members roster status = recent ACCESS ──────────────────
#
# Status no longer derives from session/request activity (the old Epic G3
# rule below) — it now derives purely from User.last_active_at recency:
#   - first_login_at IS NULL -> always 'inactive' (never signed in).
#   - else 'active' iff last_active_at is within the last 30 days, else
#     'inactive' (including when last_active_at is NULL despite having
#     first_login_at set — a defensive fallback, not an expected steady
#     state since mark_first_login now stamps both together).


async def test_chw_created_member_with_activity_but_no_login_is_inactive(
    client: AsyncClient, chw_tokens: dict
):
    """A CHW-created member has a matched request AND a scheduled session
    (real activity a CHW would see), but has never logged in themselves.
    Status must be 'inactive' regardless of that activity — access, not
    caseload activity, drives status.
    """
    member_id = await _create_chw_member(client, chw_tokens)
    await _schedule_session_for_member(client, chw_tokens, member_id)

    # Never logged in.
    assert await _get_user_first_login_at(member_id) is None

    roster = await client.get("/api/v1/chw/members", headers=auth_header(chw_tokens))
    assert roster.status_code == 200, roster.text
    item = next((i for i in roster.json() if i["id"] == member_id), None)
    assert item is not None
    assert item["status"] == "inactive"


async def test_member_flips_active_after_first_login_with_activity(
    client: AsyncClient, chw_tokens: dict
):
    """The SAME member as above flips to 'active' once they log in themselves
    — the login itself stamps last_active_at (mark_first_login), so status
    flips immediately, with the underlying session/request activity
    unchanged (proving activity was never the driver)."""
    member_id = await _create_chw_member(client, chw_tokens)
    await _schedule_session_for_member(client, chw_tokens, member_id)

    login = await client.post(
        "/api/v1/auth/login",
        json={
            "email": _NEW_MEMBER_PAYLOAD["email"],
            "password": _NEW_MEMBER_PAYLOAD["temp_password"],
        },
    )
    assert login.status_code == 200, login.text

    roster = await client.get("/api/v1/chw/members", headers=auth_header(chw_tokens))
    assert roster.status_code == 200, roster.text
    item = next((i for i in roster.json() if i["id"] == member_id), None)
    assert item is not None
    assert item["status"] == "active"


async def test_member_signs_in_with_zero_sessions_or_requests_shows_active(
    client: AsyncClient, chw_tokens: dict
):
    """QA-batch #13's core new case: a member with NO sessions and NO
    open/accepted request signs in — status must be 'active' purely from
    the login-driven last_active_at bump. FAILS on the old
    (session-in-30d OR open/accepted-request) rule, which would have called
    this member 'inactive' despite them having just signed in.
    """
    member_id = await _create_chw_member(client, chw_tokens)
    # Deliberately do NOT schedule any session — this member has zero
    # sessions and only the initial "matched" (not open/accepted) request
    # create_chw_member wrote, so the OLD activity-based rule would fail
    # this member as inactive.

    login = await client.post(
        "/api/v1/auth/login",
        json={
            "email": _NEW_MEMBER_PAYLOAD["email"],
            "password": _NEW_MEMBER_PAYLOAD["temp_password"],
        },
    )
    assert login.status_code == 200, login.text

    roster = await client.get("/api/v1/chw/members", headers=auth_header(chw_tokens))
    assert roster.status_code == 200, roster.text
    item = next((i for i in roster.json() if i["id"] == member_id), None)
    assert item is not None
    assert item["status"] == "active"


async def test_signed_in_member_with_stale_last_active_at_is_inactive(
    client: AsyncClient, chw_tokens: dict
):
    """A member who HAS signed in (first_login_at set) but whose
    last_active_at is more than 30 days stale is 'inactive' — recency, not
    the mere fact of having ever logged in, drives status. Seeded directly
    via the DB (mirrors a member who logged in over a month ago and hasn't
    touched the app since — no throttled get_current_user bump to refresh
    it in this test)."""
    import uuid as _uuid

    from app.models.request import ServiceRequest
    from app.models.user import MemberProfile, User

    chw_id = UUID(_decode_jwt_sub(chw_tokens["access_token"]))
    member_id = _uuid.uuid4()
    signed_in_at = datetime.now(UTC) - timedelta(days=45)
    stale_last_active_at = datetime.now(UTC) - timedelta(days=45)

    async with _session_factory() as db:
        db.add(User(
            id=member_id,
            email=f"stale_lastactive_{member_id.hex[:8]}@example.com",
            password_hash="x",
            name="Stale LastActive",
            role="member",
            is_active=True,
            first_login_at=signed_in_at,
            last_active_at=stale_last_active_at,
        ))
        await db.flush()
        db.add(MemberProfile(
            id=_uuid.uuid4(),
            user_id=member_id,
            primary_language="English",
            zip_code="90001",
        ))
        # Matched, but status "matched" (not open/accepted) and no session —
        # mirrors create_chw_member's initial relationship shape. Included to
        # prove status no longer keys off this at all.
        db.add(ServiceRequest(
            id=_uuid.uuid4(),
            member_id=member_id,
            matched_chw_id=chw_id,
            vertical="other",
            verticals=["other"],
            status="matched",
            urgency="routine",
            description="Signed-in member with stale last_active_at — seeded directly",
            preferred_mode="in_person",
            estimated_units=1,
        ))
        await db.commit()

    roster = await client.get("/api/v1/chw/members", headers=auth_header(chw_tokens))
    assert roster.status_code == 200, roster.text
    item = next((i for i in roster.json() if i["id"] == str(member_id)), None)
    assert item is not None
    assert item["status"] == "inactive"


async def test_signed_in_member_with_null_last_active_at_is_inactive(
    client: AsyncClient, chw_tokens: dict
):
    """Defensive fallback: first_login_at set but last_active_at somehow
    still NULL (legacy data predating this column, or any other edge case)
    must not crash on a None comparison and must resolve to 'inactive'."""
    import uuid as _uuid

    from app.models.user import MemberProfile, User

    member_id = _uuid.uuid4()
    signed_in_at = datetime.now(UTC) - timedelta(days=5)

    async with _session_factory() as db:
        db.add(User(
            id=member_id,
            email=f"null_lastactive_{member_id.hex[:8]}@example.com",
            password_hash="x",
            name="Null LastActive",
            role="member",
            is_active=True,
            first_login_at=signed_in_at,
            last_active_at=None,
        ))
        await db.flush()
        db.add(MemberProfile(
            id=_uuid.uuid4(),
            user_id=member_id,
            primary_language="English",
            zip_code="90001",
        ))
        await db.commit()

    chw_id = UUID(_decode_jwt_sub(chw_tokens["access_token"]))
    async with _session_factory() as db:
        from app.models.request import ServiceRequest

        db.add(ServiceRequest(
            id=_uuid.uuid4(),
            member_id=member_id,
            matched_chw_id=chw_id,
            vertical="other",
            verticals=["other"],
            status="matched",
            urgency="routine",
            description="Signed-in member with NULL last_active_at — seeded directly",
            preferred_mode="in_person",
            estimated_units=1,
        ))
        await db.commit()

    roster = await client.get("/api/v1/chw/members", headers=auth_header(chw_tokens))
    assert roster.status_code == 200, roster.text
    item = next((i for i in roster.json() if i["id"] == str(member_id)), None)
    assert item is not None
    assert item["status"] == "inactive"


# ─── G1: GET /api/v1/member/chw ────────────────────────────────────────────────


async def test_assigned_chw_rejects_chw_caller(client: AsyncClient, chw_tokens: dict):
    res = await client.get("/api/v1/member/chw", headers=auth_header(chw_tokens))
    assert res.status_code == 403, res.text


async def test_assigned_chw_null_when_unmatched(
    client: AsyncClient, member_tokens: dict
):
    """A member with no matched CHW gets 200 + null (not 404)."""
    res = await client.get("/api/v1/member/chw", headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
    assert res.json() is None


async def test_assigned_chw_resolves_for_chw_created_member_with_zero_sessions(
    client: AsyncClient, chw_tokens: dict
):
    """Epic G1: a CHW-created member has zero sessions, but IS matched via
    ServiceRequest.matched_chw_id — the endpoint must resolve the match from
    that column, not from session history."""
    await _create_chw_member(client, chw_tokens)

    login = await client.post(
        "/api/v1/auth/login",
        json={
            "email": _NEW_MEMBER_PAYLOAD["email"],
            "password": _NEW_MEMBER_PAYLOAD["temp_password"],
        },
    )
    assert login.status_code == 200, login.text
    member_tokens = login.json()

    res = await client.get("/api/v1/member/chw", headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body is not None
    assert body["id"] == _decode_jwt_sub(chw_tokens["access_token"])
    assert body["name"] == "Test CHW"

    # Sanity: this member really has zero sessions — proves the match did NOT
    # come from session history.
    sessions_res = await client.get("/api/v1/sessions/", headers=auth_header(member_tokens))
    assert sessions_res.status_code == 200, sessions_res.text
    assert sessions_res.json() == []


# ─── H1: created_at + full medi_cal_id on the roster ───────────────────────────


async def test_roster_includes_created_at_matching_user_row(
    client: AsyncClient, chw_tokens: dict
):
    from app.models.user import User

    member_id = await _create_chw_member(client, chw_tokens)

    async with _session_factory() as db:
        user = await db.get(User, UUID(member_id))
        expected_created_at = user.created_at

    roster = await client.get("/api/v1/chw/members", headers=auth_header(chw_tokens))
    assert roster.status_code == 200, roster.text
    item = next((i for i in roster.json() if i["id"] == member_id), None)
    assert item is not None
    assert item["created_at"] is not None
    # Compare with second precision — Postgres/JSON round-tripping can drop
    # sub-microsecond precision.
    returned = datetime.fromisoformat(item["created_at"].replace("Z", "+00:00"))
    assert abs((returned - expected_created_at).total_seconds()) < 1


async def test_roster_includes_full_unmasked_cin(client: AsyncClient, chw_tokens: dict):
    member_id = await _create_chw_member(client, chw_tokens)

    roster = await client.get("/api/v1/chw/members", headers=auth_header(chw_tokens))
    assert roster.status_code == 200, roster.text
    item = next((i for i in roster.json() if i["id"] == member_id), None)
    assert item is not None
    assert item["medi_cal_id"] == _NEW_MEMBER_PAYLOAD["medi_cal_id"]
    # Full CIN must be distinct from (and not equal to) the masked column.
    assert item["masked_id"] != item["medi_cal_id"]
    assert item["masked_id"] == f"...{_NEW_MEMBER_PAYLOAD['medi_cal_id'][-4:]}"


async def test_roster_medi_cal_id_null_when_absent(
    client: AsyncClient, chw_tokens: dict
):
    """Mirrors the existing masked_id em-dash test: a legacy member with no
    medi_cal_id on file gets medi_cal_id: null (not an empty string / error)."""
    import uuid as _uuid

    from app.models.request import ServiceRequest
    from app.models.user import MemberProfile, User

    chw_id = UUID(_decode_jwt_sub(chw_tokens["access_token"]))
    member_id = _uuid.uuid4()

    async with _session_factory() as db:
        db.add(User(
            id=member_id,
            email=f"member_nocin_h1_{member_id.hex[:8]}@example.com",
            password_hash="x",
            name="Legacy NoCin H1",
            role="member",
            is_active=True,
        ))
        await db.flush()
        db.add(MemberProfile(
            id=_uuid.uuid4(),
            user_id=member_id,
            primary_language="English",
            zip_code="90001",
        ))
        db.add(ServiceRequest(
            id=_uuid.uuid4(),
            member_id=member_id,
            matched_chw_id=chw_id,
            vertical="housing",
            verticals=["housing"],
            status="accepted",
            urgency="routine",
            description="Legacy member without CIN — seeded directly",
            preferred_mode="in_person",
            estimated_units=1,
        ))
        await db.commit()

    roster = await client.get("/api/v1/chw/members", headers=auth_header(chw_tokens))
    assert roster.status_code == 200, roster.text
    item = next((i for i in roster.json() if i["id"] == str(member_id)), None)
    assert item is not None
    assert item["medi_cal_id"] is None
