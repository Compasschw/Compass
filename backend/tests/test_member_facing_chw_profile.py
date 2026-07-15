"""Tests for GET /api/v1/member/chws/{chw_id}.

Coverage (5 tests + 1 extra):
1. Authenticated member can fetch any CHW profile.
2. Unauthenticated request returns 401.
3. Non-existent chw_id returns 404.
4. last_name_initial is exactly one character + "." (privacy check).
5. shared_session_count reflects only the calling member's own sessions.
6. A non-CHW user_id (a member user) returns 404 (role gate).
"""

import base64
import json
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy import update

from tests.conftest import auth_header
from tests.conftest import test_session as _test_session_factory

# ─── Helpers ──────────────────────────────────────────────────────────────────


async def _register(client: AsyncClient, email: str, role: str, name: str) -> dict:
    """Register a user and return the full token payload dict.

    Members must supply every Pear-required signup field (#14); the CIN is
    derived from the email so concurrent registrations stay distinct.
    """
    payload: dict = {
        "email": email,
        "password": "Testpass123!",
        "name": name,
        "role": role,
    }
    if role == "member":
        payload.update({
            "date_of_birth": "1990-01-01",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
            "zip_code": "90001",
            "terms_accepted": True,
            "communications_consent": True,
        })
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


def _user_id_from_tokens(tokens: dict) -> str:
    """Decode the user UUID from the JWT access token's 'sub' claim.

    JWT format: header.payload.signature — we base64url-decode the payload
    segment and extract the 'sub' field. No library required.
    """
    payload_segment = tokens["access_token"].split(".")[1]
    padded = payload_segment + "=" * (4 - len(payload_segment) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded))
    return payload["sub"]


async def _make_session(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> str:
    """Create a service request + accept it + open a session. Returns session_id."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Need help",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-05-20T10:00:00Z",
            "mode": "in_person",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    return res.json()["id"]


async def _set_session_status(session_id: str, status: str) -> None:
    """Directly update a Session row's status (and ended_at when completed).

    Bypasses the full documentation-submission flow — these tests only care
    about the terminal `status` value that ``shared_session_count`` filters
    on (QA batch 2026-07-14, Part 17), not the billing/claim side effects.
    """
    from app.models.session import Session as SessionModel

    async with _test_session_factory() as db:
        values: dict = {"status": status}
        if status == "completed":
            values["ended_at"] = datetime.now(UTC)
        await db.execute(
            update(SessionModel).where(SessionModel.id == session_id).values(**values)
        )
        await db.commit()


# ─── Tests ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_member_can_fetch_any_chw_profile(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> None:
    """An authenticated member can retrieve a CHW's public profile with no
    prior relationship required — the endpoint is public-within-platform."""
    chw_id = _user_id_from_tokens(chw_tokens)

    res = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text

    data = res.json()

    # Core identity fields
    assert data["id"] == chw_id
    assert data["first_name"] == "Test"   # conftest registers "Test CHW"
    assert isinstance(data["last_name_initial"], str)

    # Language defaults
    assert isinstance(data["primary_language"], str)
    assert isinstance(data["additional_languages"], list)

    # Specialization — may be None for a fresh CHW with no intake
    assert "primary_specialization" in data

    # Years experience — None for brand-new CHW with empty profile
    assert "years_experience" in data

    # Cert defaults false
    assert data["ca_chw_certified"] is False

    # Shared session count is zero (no sessions together yet)
    assert data["shared_session_count"] == 0

    # List fields are lists
    assert isinstance(data["service_area_zips"], list)
    assert isinstance(data["available_days"], list)


@pytest.mark.asyncio
async def test_unauthenticated_request_returns_401(
    client: AsyncClient,
    chw_tokens: dict,
) -> None:
    """No bearer token → 401 Unauthorized."""
    chw_id = _user_id_from_tokens(chw_tokens)
    res = await client.get(f"/api/v1/member/chws/{chw_id}")
    assert res.status_code == 401, res.text


@pytest.mark.asyncio
async def test_nonexistent_chw_id_returns_404(
    client: AsyncClient,
    member_tokens: dict,
) -> None:
    """A UUID that doesn't correspond to any CHW returns 404."""
    fake_id = "00000000-0000-0000-0000-000000000001"
    res = await client.get(
        f"/api/v1/member/chws/{fake_id}",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 404, res.text


@pytest.mark.asyncio
async def test_last_name_initial_is_one_char_plus_period(
    client: AsyncClient,
    member_tokens: dict,
) -> None:
    """last_name_initial must be exactly one uppercase character followed by '.'.

    Privacy gate: we must never return the full last name to members.
    The conftest registers the CHW as "Test CHW" so last_name_initial
    should be "C." (first character of "CHW").
    """
    # Register a fresh CHW whose name makes the assertion unambiguous.
    chw_long = await _register(
        client, "chw_privacy@example.com", "chw", "Alice Smithson"
    )
    chw_id = _user_id_from_tokens(chw_long)

    res = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    initial = res.json()["last_name_initial"]

    # Must be exactly 2 characters: one uppercase letter + period.
    assert len(initial) == 2, f"Expected len 2, got '{initial}'"
    assert initial[0].isupper(), f"Expected uppercase first char, got '{initial}'"
    assert initial[1] == ".", f"Expected '.' at index 1, got '{initial}'"

    # Specific value check for "Smithson" → "S."
    assert initial == "S.", f"Expected 'S.', got '{initial}'"


@pytest.mark.asyncio
async def test_shared_session_count_reflects_calling_member_only(
    client: AsyncClient,
) -> None:
    """shared_session_count is scoped to the calling member's COMPLETED
    sessions only (QA batch 2026-07-14, Part 17).

    We create:
    - member_a has 1 completed session with the CHW.
    - member_b has 2 completed sessions with the CHW.

    When member_a calls GET /member/chws/{chw_id} they see count == 1.
    When member_b calls the same endpoint they see count == 2.
    """
    chw = await _register(client, "chw_count@example.com", "chw", "Count CHW")
    member_a = await _register(client, "member_a@example.com", "member", "Alice A")
    member_b = await _register(client, "member_b@example.com", "member", "Bob B")

    chw_id = _user_id_from_tokens(chw)

    # member_a: 1 completed session
    session_a1 = await _make_session(client, member_a, chw)
    await _set_session_status(session_a1, "completed")

    # member_b: 2 completed sessions (create request + session twice)
    session_b1 = await _make_session(client, member_b, chw)
    session_b2 = await _make_session(client, member_b, chw)
    await _set_session_status(session_b1, "completed")
    await _set_session_status(session_b2, "completed")

    res_a = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member_a),
    )
    assert res_a.status_code == 200, res_a.text
    assert res_a.json()["shared_session_count"] == 1, res_a.text

    res_b = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member_b),
    )
    assert res_b.status_code == 200, res_b.text
    assert res_b.json()["shared_session_count"] == 2, res_b.text


@pytest.mark.asyncio
async def test_shared_session_count_excludes_non_completed_statuses(
    client: AsyncClient,
) -> None:
    """QA batch (2026-07-14) Part 17 — regression.

    A pair with one completed session plus a cancelled, a missed, and a
    still-scheduled session must count only the completed one. Before the
    fix, the endpoint counted sessions of ANY status, so a future booking
    (or a cancelled/missed one) inflated "Sessions Together" / "Journey
    Progress" on the member-facing CHW profile.
    """
    chw = await _register(client, "chw_statuses@example.com", "chw", "Status CHW")
    member = await _register(client, "member_statuses@example.com", "member", "Sam S")
    chw_id = _user_id_from_tokens(chw)

    session_completed = await _make_session(client, member, chw)
    session_cancelled = await _make_session(client, member, chw)
    session_missed = await _make_session(client, member, chw)
    session_scheduled = await _make_session(client, member, chw)  # left as-is

    await _set_session_status(session_completed, "completed")
    await _set_session_status(session_cancelled, "cancelled")
    await _set_session_status(session_missed, "missed")
    assert session_scheduled  # created but deliberately left "scheduled"

    res = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member),
    )
    assert res.status_code == 200, res.text
    assert res.json()["shared_session_count"] == 1, res.text


@pytest.mark.asyncio
async def test_shared_session_count_zero_when_no_completed_sessions(
    client: AsyncClient,
) -> None:
    """A pair with only non-completed sessions (or none at all) shows 0."""
    chw = await _register(client, "chw_zero@example.com", "chw", "Zero CHW")
    member = await _register(client, "member_zero@example.com", "member", "Zero M")
    chw_id = _user_id_from_tokens(chw)

    session_id = await _make_session(client, member, chw)
    await _set_session_status(session_id, "cancelled")

    res = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member),
    )
    assert res.status_code == 200, res.text
    assert res.json()["shared_session_count"] == 0, res.text


# ─── Part 18: my_rating_avg / my_rating_count ──────────────────────────────────


@pytest.mark.asyncio
async def test_my_rating_defaults_to_none_with_no_ratings(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> None:
    """A member who has never rated this CHW sees my_rating_avg=None,
    my_rating_count=0 — the frontend renders "No ratings yet" from this."""
    chw_id = _user_id_from_tokens(chw_tokens)

    res = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["my_rating_avg"] is None
    assert data["my_rating_count"] == 0


@pytest.mark.asyncio
async def test_my_rating_averages_this_members_own_ratings_regardless_of_approval(
    client: AsyncClient,
) -> None:
    """QA batch (2026-07-14) Part 18 — regression.

    A member's own post-session ratings for a CHW must average into
    my_rating_avg with NO approval-status gate — moderation only controls
    public display of testimonial *text*. Before the fix, the tile read the
    CHW's global *approved-only* testimonial summary, so a fresh unapproved
    rating stayed invisible ("No ratings yet") right after the member rated
    a session.
    """
    from app.models.testimonial import Testimonial

    chw = await _register(client, "chw_rating@example.com", "chw", "Rating CHW")
    member = await _register(client, "member_rating@example.com", "member", "Rater M")
    chw_id = _user_id_from_tokens(chw)
    member_id = _user_id_from_tokens(member)

    session_1 = await _make_session(client, member, chw)
    session_2 = await _make_session(client, member, chw)

    async with _test_session_factory() as db:
        db.add(
            Testimonial(
                chw_id=chw_id,
                member_id=member_id,
                session_id=session_1,
                rating=4,
                status="pending",  # deliberately unapproved
                source="session",
            )
        )
        db.add(
            Testimonial(
                chw_id=chw_id,
                member_id=member_id,
                session_id=session_2,
                rating=5,
                status="pending",
                source="session",
            )
        )
        await db.commit()

    res = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member),
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["my_rating_avg"] == 4.5, res.text
    assert data["my_rating_count"] == 2, res.text


@pytest.mark.asyncio
async def test_my_rating_never_leaks_other_members_ratings(
    client: AsyncClient,
) -> None:
    """Other members' ratings of the same CHW must never leak into
    my_rating_avg/my_rating_count for the calling member."""
    from app.models.testimonial import Testimonial

    chw = await _register(client, "chw_isolation@example.com", "chw", "Iso CHW")
    member_a = await _register(client, "member_iso_a@example.com", "member", "Iso A")
    member_b = await _register(client, "member_iso_b@example.com", "member", "Iso B")
    chw_id = _user_id_from_tokens(chw)
    member_a_id = _user_id_from_tokens(member_a)
    member_b_id = _user_id_from_tokens(member_b)

    session_a = await _make_session(client, member_a, chw)
    session_b = await _make_session(client, member_b, chw)

    async with _test_session_factory() as db:
        db.add(
            Testimonial(
                chw_id=chw_id,
                member_id=member_a_id,
                session_id=session_a,
                rating=2,
                status="approved",
                source="session",
            )
        )
        db.add(
            Testimonial(
                chw_id=chw_id,
                member_id=member_b_id,
                session_id=session_b,
                rating=5,
                status="approved",
                source="session",
            )
        )
        await db.commit()

    res_a = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member_a),
    )
    assert res_a.status_code == 200, res_a.text
    assert res_a.json()["my_rating_avg"] == 2.0
    assert res_a.json()["my_rating_count"] == 1

    res_b = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member_b),
    )
    assert res_b.status_code == 200, res_b.text
    assert res_b.json()["my_rating_avg"] == 5.0
    assert res_b.json()["my_rating_count"] == 1


@pytest.mark.asyncio
async def test_member_user_id_as_chw_id_returns_404(
    client: AsyncClient,
    member_tokens: dict,
) -> None:
    """Passing a valid member user UUID as the chw_id returns 404.

    The endpoint gates on User.role == "chw" so a member's own UUID (or
    any other non-CHW user) is correctly rejected.
    """
    # Use the calling member's own UUID as the chw_id path param.
    member_id = _user_id_from_tokens(member_tokens)
    res = await client.get(
        f"/api/v1/member/chws/{member_id}",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 404, res.text


@pytest.mark.asyncio
async def test_chw_profile_picture_url_null_by_default(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> None:
    """A CHW with no uploaded photo exposes profile_picture_url == None.

    Cross-view cohesion: the member-facing CHW profile renders the CHW's
    avatar from this field, falling back to initials when it is null.
    """
    chw_id = _user_id_from_tokens(chw_tokens)
    res = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert "profile_picture_url" in data
    assert data["profile_picture_url"] is None


@pytest.mark.asyncio
async def test_chw_profile_picture_url_returned_when_set(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> None:
    """A CHW's uploaded photo is surfaced on the member-facing profile.

    The CHW sets profile_picture_url via PUT /chw/profile (an external URL
    passes through presigned_avatar_url unchanged); the member fetching that
    CHW's profile must receive the same URL — so the member sees the same
    photo the CHW set in their profile.
    """
    photo_url = "https://cdn.example.com/avatars/chw-xyz.png"

    put_res = await client.put(
        "/api/v1/chw/profile",
        json={"profile_picture_url": photo_url},
        headers=auth_header(chw_tokens),
    )
    assert put_res.status_code == 200, put_res.text

    chw_id = _user_id_from_tokens(chw_tokens)
    res = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["profile_picture_url"] == photo_url


@pytest.mark.asyncio
async def test_completely_empty_chw_profile_returns_200_with_safe_defaults(
    client: AsyncClient,
    member_tokens: dict,
) -> None:
    """QA-batch #11 — GET /member/chws/{chw_id} must never 500 on a CHW with
    a completely bare profile: no bio, no languages, no specializations, no
    zip_code, no availability_windows, no CHWIntake row at all (never
    completed the questionnaire).

    register_user() always provisions a CHWProfile row at signup time (with
    every optional column at its column default: specializations=[],
    languages=[], bio=None, zip_code=None, years_experience=0,
    availability_windows=None) and never creates a CHWIntake row — so a
    freshly-registered CHW who has done nothing else is exactly this
    "completely empty" state without needing to hand-seed anything.
    """
    empty_chw = await _register(
        client, "chw_totally_empty@example.com", "chw", "Empty Profile"
    )
    chw_id = _user_id_from_tokens(empty_chw)

    res = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    data = res.json()

    # Identity fields always present, never null.
    assert data["id"] == chw_id
    assert isinstance(data["first_name"], str)
    assert isinstance(data["last_name_initial"], str)

    # Language defaults to English with no additional languages.
    assert data["primary_language"] == "English"
    assert data["additional_languages"] == []

    # No specializations / no cert / no modality yet. years_experience is
    # NEVER null once a CHWProfile row exists (which register_user always
    # provisions) — it formats the 0 default as the "<1 year" bracket rather
    # than surfacing null; only a MISSING CHWProfile row would produce null,
    # which register_user's invariant makes unreachable in practice.
    assert data["primary_specialization"] is None
    assert data["years_experience"] == "<1 year"
    assert data["ca_chw_certified"] is False
    assert data["modality"] is None

    # Empty list defaults, never null.
    assert data["service_area_zips"] == []
    assert data["available_days"] == []
    assert isinstance(data["availability_windows"], dict)

    # No shared sessions with this member yet.
    assert data["shared_session_count"] == 0

    # No photo uploaded.
    assert data["profile_picture_url"] is None
