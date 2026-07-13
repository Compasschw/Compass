"""Integration tests for the assessment engine.

Coverage
--------
1. Template fetch — GET /api/v1/assessment-templates/{id}
   - Returns compass_member_v1 with 39 questions (16 SDOH + 23 medical)
   - Returns compass_intro_script_v1 with 7 steps
   - 404 for unknown template IDs

2. Assessment start — POST /api/v1/sessions/{session_id}/assessments
   - Creates a fresh assessment (201)
   - Idempotent: second call returns the existing in_progress row (200)
   - Re-assessment: completed assessment does NOT block creating a new one (201)
   - 422 for unknown template_id
   - 403 for non-CHW caller (member)

3. Response append — POST /api/v1/assessments/{id}/responses
   - Creates a response row with server-stamped captured_at when omitted
   - Respects client-supplied captured_at
   - Multiple responses to the same question_id are allowed (new rows, no update)
   - captured_at is preserved per-row (audit trail test)
   - 409 when assessment is completed (cannot append)
   - 409 when assessment is abandoned

4. Lifecycle transitions
   - complete: transitions in_progress → completed and stamps completed_at
   - abandon: transitions in_progress → abandoned
   - 409 on double-complete
   - 409 on complete after abandon

5. Latest completed assessment
   - GET /api/v1/chw/members/{member_id}/assessments/latest
   - Returns most recent completed assessment with all responses
   - 404 when no completed assessment exists
   - 403 for member caller

6. Epic W2 — per-question Skip
   - skipped=true persists distinctly from a real answer (skipped=false) and
     from an unanswered question (no row at all)
   - skipped=true defaults answer_value/answer_label to the reserved
     placeholder when the client omits them
   - skipped=false (default) still requires answer_value/answer_label — 422
     otherwise (pre-existing contract, unchanged)

7. Epic W3 — partial save + resume hydration
   - The idempotent "start/resume" call (POST .../assessments, existing
     in_progress row) returns prior responses, including skipped ones, so the
     CHW's device can hydrate previously-saved + previously-skipped state on
     reopen.

Each test runs against a real PostgreSQL test database (same conftest as all
other tests). No mocks — full request → router → ORM → commit path.
"""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select

import base64
import json

from app.models.assessment import MemberAssessment, MemberAssessmentResponse
from tests.conftest import auth_header, test_session as _db_factory


def _extract_user_id_from_token(tokens: dict) -> str:
    """Decode the JWT access token and return the 'sub' claim (user UUID string).

    Uses base64 decoding only — no signature verification needed in tests
    since we trust the local test-issued token.
    """
    token = tokens["access_token"]
    # JWT structure: header.payload.signature — all base64url-encoded
    payload_b64 = token.split(".")[1]
    # Add padding to make it valid base64
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded).decode())
    return payload["sub"]


# ─── Shared fixtures & helpers ────────────────────────────────────────────────


async def _create_request_and_accept(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> str:
    """Create a service request and have the CHW accept it."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Assessment test request",
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
    return request_id


async def _create_session(
    client: AsyncClient,
    chw_tokens: dict,
    request_id: str,
) -> str:
    """Create a session and return its UUID string."""
    from datetime import UTC, datetime
    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "mode": "in_person",
            "scheduled_at": datetime.now(UTC).isoformat(),
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    return res.json()["id"]


async def _start_assessment(
    client: AsyncClient,
    chw_tokens: dict,
    session_id: str,
    template_id: str = "compass_member_v1",
) -> dict:
    """POST to start an assessment; return parsed JSON body."""
    res = await client.post(
        f"/api/v1/sessions/{session_id}/assessments",
        json={"template_id": template_id},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code in (200, 201), f"Expected 200/201, got {res.status_code}: {res.text}"
    return res.json(), res.status_code


_SAMPLE_RESPONSE_BODY = {
    "question_id": "housing_situation",
    "question_text": "What best describes your current housing situation?",
    "answer_value": "own_or_rent_stable",
    "answer_label": "I own or rent a stable home",
    "category": "sdoh",
    "subcategory": "housing",
    "tags": ["SDOH"],
}


# ─── 1. Template endpoint ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_compass_member_template(
    client: AsyncClient,
    chw_tokens: dict,
) -> None:
    """Template returns 39 questions: 16 SDOH + 23 medical."""
    res = await client.get(
        "/api/v1/assessment-templates/compass_member_v1",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["id"] == "compass_member_v1"
    assert body["total_questions"] == 39
    assert body["metadata"]["sdoh_count"] == 16
    assert body["metadata"]["medical_count"] == 23
    assert len(body["questions"]) == 39
    assert len(body["sections"]) == 17  # 6 SDOH + 11 medical

    # Verify ordering: first 16 questions are SDOH, next 23 are medical
    sdoh_qs = [q for q in body["questions"] if q["category"] == "sdoh"]
    medical_qs = [q for q in body["questions"] if q["category"] == "medical"]
    assert len(sdoh_qs) == 16
    assert len(medical_qs) == 23
    # The first question must be in the housing section (SDOH Part 1 first)
    assert body["questions"][0]["section_id"] == "housing_economic"
    # The first medical question (index 16) must be pregnancy
    assert body["questions"][16]["section_id"] == "pregnancy"


@pytest.mark.asyncio
async def test_get_intro_script_template(
    client: AsyncClient,
    chw_tokens: dict,
) -> None:
    """Intro script template returns 7 steps."""
    res = await client.get(
        "/api/v1/assessment-templates/compass_intro_script_v1",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["id"] == "compass_intro_script_v1"
    assert body["total_steps"] == 7
    assert len(body["steps"]) == 7

    # Each step must have a title, script_text, and tips list
    for step in body["steps"]:
        assert "title" in step
        assert "script_text" in step
        assert isinstance(step["tips"], list)

    # Crisis tip box must exist in step 6
    step_6 = body["steps"][5]
    tip_types = [t["type"] for t in step_6["tips"]]
    assert "crisis" in tip_types


@pytest.mark.asyncio
async def test_unknown_template_returns_404(
    client: AsyncClient,
    chw_tokens: dict,
) -> None:
    res = await client.get(
        "/api/v1/assessment-templates/does_not_exist",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 404


# ─── 2. Start assessment ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_start_assessment_creates_row(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)

    body, status_code = await _start_assessment(client, chw_tokens, session_id)

    assert status_code == 201
    assert body["status"] == "in_progress"
    assert body["template_id"] == "compass_member_v1"
    assert body["session_id"] == session_id
    assert body["completed_at"] is None
    assert isinstance(body["id"], str)


@pytest.mark.asyncio
async def test_start_assessment_idempotent(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Second call returns the existing in_progress row with HTTP 200."""
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)

    body1, code1 = await _start_assessment(client, chw_tokens, session_id)
    body2, code2 = await _start_assessment(client, chw_tokens, session_id)

    assert code1 == 201
    assert code2 == 200
    assert body1["id"] == body2["id"]  # same assessment row
    assert body2["status"] == "in_progress"


@pytest.mark.asyncio
async def test_start_assessment_after_completed_creates_new(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """A completed assessment does not block creating a new in_progress one."""
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)

    body1, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id_1 = body1["id"]

    # Complete the first assessment
    res = await client.post(
        f"/api/v1/assessments/{assessment_id_1}/complete",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200

    # Start a new one — should be a fresh row (201)
    body2, code2 = await _start_assessment(client, chw_tokens, session_id)
    assert code2 == 201
    assert body2["id"] != assessment_id_1
    assert body2["status"] == "in_progress"


@pytest.mark.asyncio
async def test_start_assessment_unknown_template(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)

    res = await client.post(
        f"/api/v1/sessions/{session_id}/assessments",
        json={"template_id": "not_a_real_template"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_start_assessment_forbidden_for_member(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Members may not start assessments."""
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)

    res = await client.post(
        f"/api/v1/sessions/{session_id}/assessments",
        json={"template_id": "compass_member_v1"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403


# ─── 3. Response append ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_append_response_stamps_server_time(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """captured_at defaults to server UTC when not supplied by the client."""
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    before = datetime.now(UTC)
    res = await client.post(
        f"/api/v1/assessments/{assessment_id}/responses",
        json=_SAMPLE_RESPONSE_BODY,
        headers=auth_header(chw_tokens),
    )
    after = datetime.now(UTC)

    assert res.status_code == 201, res.text
    data = res.json()
    assert data["question_id"] == "housing_situation"
    assert data["category"] == "sdoh"
    assert data["subcategory"] == "housing"
    assert data["tags"] == ["SDOH"]

    captured = datetime.fromisoformat(data["captured_at"])
    assert before <= captured <= after


@pytest.mark.asyncio
async def test_append_response_uses_client_captured_at(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """captured_at from the client is stored verbatim."""
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    client_ts = "2026-05-06T10:30:00+00:00"
    payload = {**_SAMPLE_RESPONSE_BODY, "captured_at": client_ts}

    res = await client.post(
        f"/api/v1/assessments/{assessment_id}/responses",
        json=payload,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    data = res.json()
    # Timestamp must be preserved (allowing for UTC normalization)
    captured = datetime.fromisoformat(data["captured_at"])
    assert captured.year == 2026
    assert captured.month == 5
    assert captured.day == 6
    assert captured.hour == 10
    assert captured.minute == 30


@pytest.mark.asyncio
async def test_multiple_responses_same_question_creates_new_rows(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Re-answering a question creates new rows — never updates existing ones."""
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    # First answer
    res1 = await client.post(
        f"/api/v1/assessments/{assessment_id}/responses",
        json=_SAMPLE_RESPONSE_BODY,
        headers=auth_header(chw_tokens),
    )
    assert res1.status_code == 201

    # Second answer to the same question (member changed their mind)
    second_payload = {
        **_SAMPLE_RESPONSE_BODY,
        "answer_value": "experiencing_homelessness",
        "answer_label": "I am experiencing homelessness",
    }
    res2 = await client.post(
        f"/api/v1/assessments/{assessment_id}/responses",
        json=second_payload,
        headers=auth_header(chw_tokens),
    )
    assert res2.status_code == 201

    # Two distinct rows must exist in the DB
    id1 = res1.json()["id"]
    id2 = res2.json()["id"]
    assert id1 != id2

    # Verify via DB query
    async with _db_factory() as db:
        result = await db.execute(
            select(MemberAssessmentResponse).where(
                MemberAssessmentResponse.assessment_id == UUID(assessment_id),
                MemberAssessmentResponse.question_id == "housing_situation",
            ).order_by(MemberAssessmentResponse.captured_at.asc())
        )
        rows = result.scalars().all()

    assert len(rows) == 2
    assert rows[0].answer_value == "own_or_rent_stable"
    assert rows[1].answer_value == "experiencing_homelessness"


@pytest.mark.asyncio
async def test_append_response_to_completed_assessment_returns_409(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    await client.post(
        f"/api/v1/assessments/{assessment_id}/complete",
        headers=auth_header(chw_tokens),
    )

    res = await client.post(
        f"/api/v1/assessments/{assessment_id}/responses",
        json=_SAMPLE_RESPONSE_BODY,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_append_response_to_abandoned_assessment_returns_409(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    await client.post(
        f"/api/v1/assessments/{assessment_id}/abandon",
        headers=auth_header(chw_tokens),
    )

    res = await client.post(
        f"/api/v1/assessments/{assessment_id}/responses",
        json=_SAMPLE_RESPONSE_BODY,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 409


# ─── 4. Lifecycle transitions ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_complete_assessment_stamps_completed_at(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    before = datetime.now(UTC)
    res = await client.post(
        f"/api/v1/assessments/{assessment_id}/complete",
        headers=auth_header(chw_tokens),
    )
    after = datetime.now(UTC)

    assert res.status_code == 200, res.text
    data = res.json()
    assert data["status"] == "completed"
    assert data["completed_at"] is not None

    completed_at = datetime.fromisoformat(data["completed_at"])
    assert before <= completed_at <= after


@pytest.mark.asyncio
async def test_double_complete_returns_409(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    res1 = await client.post(
        f"/api/v1/assessments/{assessment_id}/complete",
        headers=auth_header(chw_tokens),
    )
    assert res1.status_code == 200

    res2 = await client.post(
        f"/api/v1/assessments/{assessment_id}/complete",
        headers=auth_header(chw_tokens),
    )
    assert res2.status_code == 409


@pytest.mark.asyncio
async def test_complete_after_abandon_returns_409(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    await client.post(
        f"/api/v1/assessments/{assessment_id}/abandon",
        headers=auth_header(chw_tokens),
    )

    res = await client.post(
        f"/api/v1/assessments/{assessment_id}/complete",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_abandon_assessment(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    res = await client.post(
        f"/api/v1/assessments/{assessment_id}/abandon",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "abandoned"
    # completed_at should remain None
    assert res.json()["completed_at"] is None


# ─── 5. Latest completed assessment ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_latest_assessment_returns_most_recent_completed(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """latest endpoint returns the newest completed assessment with all responses."""
    member_id = _extract_user_id_from_token(member_tokens)

    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)

    # Start and add a response
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    await client.post(
        f"/api/v1/assessments/{assessment_id}/responses",
        json=_SAMPLE_RESPONSE_BODY,
        headers=auth_header(chw_tokens),
    )

    # Complete it
    await client.post(
        f"/api/v1/assessments/{assessment_id}/complete",
        headers=auth_header(chw_tokens),
    )

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/assessments/latest",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["id"] == assessment_id
    assert data["status"] == "completed"
    assert len(data["responses"]) == 1
    assert data["responses"][0]["question_id"] == "housing_situation"


@pytest.mark.asyncio
async def test_latest_assessment_404_when_none_completed(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """404 when the member has no completed assessment.

    The endpoint enforces ``assert_shared_session`` before the 404 branch,
    so the CHW must first establish a care relationship (request → accept →
    session) — otherwise an unrelated CHW receives 403, not 404.
    """
    member_id = _extract_user_id_from_token(member_tokens)

    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    await _create_session(client, chw_tokens, request_id)

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/assessments/latest",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_latest_assessment_forbidden_for_member(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Members may not call the latest assessment endpoint."""
    member_id = _extract_user_id_from_token(member_tokens)

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/assessments/latest",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_latest_assessment_returns_newest_of_multiple_completed(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """When two assessments are completed, /latest returns the more recent one."""
    member_id = _extract_user_id_from_token(member_tokens)

    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)

    # First assessment
    body1, _ = await _start_assessment(client, chw_tokens, session_id)
    aid1 = body1["id"]
    await client.post(f"/api/v1/assessments/{aid1}/complete", headers=auth_header(chw_tokens))

    # Second assessment (re-assessment)
    body2, code2 = await _start_assessment(client, chw_tokens, session_id)
    assert code2 == 201
    aid2 = body2["id"]
    await client.post(
        f"/api/v1/assessments/{aid2}/responses",
        json={**_SAMPLE_RESPONSE_BODY, "question_id": "food_insecurity",
              "question_text": "In the past 12 months, were you ever worried that food would run out?",
              "answer_value": "yes", "answer_label": "Yes",
              "subcategory": "food_access"},
        headers=auth_header(chw_tokens),
    )
    await client.post(f"/api/v1/assessments/{aid2}/complete", headers=auth_header(chw_tokens))

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/assessments/latest",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["id"] == aid2, "Should return the second (newer) assessment"


# ─── 6. Per-answer audit trail ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_per_answer_timestamps_are_independent(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Each answer can have a distinct captured_at (audit trail integrity)."""
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    ts1 = "2026-05-06T09:00:00+00:00"
    ts2 = "2026-05-06T09:05:00+00:00"
    ts3 = "2026-05-06T09:10:00+00:00"

    questions = [
        ("housing_situation", "What best describes your current housing situation?",
         "own_or_rent_stable", "I own or rent a stable home", "sdoh", "housing", ts1),
        ("food_insecurity", "Were you ever worried that food would run out?",
         "no", "No", "sdoh", "food_access", ts2),
        ("transportation_barrier", "Has lack of transportation kept you from appointments?",
         "yes", "Yes", "sdoh", "transportation", ts3),
    ]

    for qid, qtext, val, lbl, cat, sub, ts in questions:
        res = await client.post(
            f"/api/v1/assessments/{assessment_id}/responses",
            json={
                "question_id": qid,
                "question_text": qtext,
                "answer_value": val,
                "answer_label": lbl,
                "category": cat,
                "subcategory": sub,
                "tags": ["SDOH"],
                "captured_at": ts,
            },
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201

    # Verify DB rows preserve distinct timestamps
    async with _db_factory() as db:
        result = await db.execute(
            select(MemberAssessmentResponse)
            .where(MemberAssessmentResponse.assessment_id == UUID(assessment_id))
            .order_by(MemberAssessmentResponse.captured_at.asc())
        )
        rows = result.scalars().all()

    assert len(rows) == 3
    # Timestamps are strictly increasing
    assert rows[0].captured_at < rows[1].captured_at < rows[2].captured_at
    assert rows[0].question_id == "housing_situation"
    assert rows[1].question_id == "food_insecurity"
    assert rows[2].question_id == "transportation_barrier"


# ─── 6. Epic W2 — per-question Skip ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_skip_response_defaults_placeholder_answer_fields(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """skipped=true with no answer_value/answer_label defaults to the
    reserved placeholder ('skipped'/'Skipped') and persists skipped=True."""
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    res = await client.post(
        f"/api/v1/assessments/{assessment_id}/responses",
        json={
            "question_id": "housing_situation",
            "question_text": "What best describes your current housing situation?",
            "category": "sdoh",
            "subcategory": "housing",
            "tags": ["SDOH"],
            "skipped": True,
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    data = res.json()
    assert data["skipped"] is True
    assert data["answer_value"] == "skipped"
    assert data["answer_label"] == "Skipped"


@pytest.mark.asyncio
async def test_skipped_response_distinct_from_answered_and_unanswered(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """A skipped question, an answered question, and an unanswered question
    must all be distinguishable from one another via the DB row set."""
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    # Q1 — answered normally.
    res1 = await client.post(
        f"/api/v1/assessments/{assessment_id}/responses",
        json=_SAMPLE_RESPONSE_BODY,
        headers=auth_header(chw_tokens),
    )
    assert res1.status_code == 201, res1.text

    # Q2 — explicitly skipped.
    res2 = await client.post(
        f"/api/v1/assessments/{assessment_id}/responses",
        json={
            "question_id": "food_insecurity",
            "question_text": "Were you ever worried that food would run out?",
            "category": "sdoh",
            "subcategory": "food_access",
            "tags": ["SDOH"],
            "skipped": True,
        },
        headers=auth_header(chw_tokens),
    )
    assert res2.status_code == 201, res2.text

    # Q3 — never touched at all (unanswered).

    async with _db_factory() as db:
        result = await db.execute(
            select(MemberAssessmentResponse).where(
                MemberAssessmentResponse.assessment_id == UUID(assessment_id),
            )
        )
        rows = {r.question_id: r for r in result.scalars().all()}

    assert set(rows.keys()) == {"housing_situation", "food_insecurity"}
    assert rows["housing_situation"].skipped is False
    assert rows["housing_situation"].answer_value == "own_or_rent_stable"
    assert rows["food_insecurity"].skipped is True
    assert rows["food_insecurity"].answer_value == "skipped"
    # Unanswered — "transportation_barrier" — has no row at all, which is the
    # third, distinct state from both answered and skipped.
    assert "transportation_barrier" not in rows


@pytest.mark.asyncio
async def test_non_skipped_response_still_requires_answer_value(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """skipped=false (the default) preserves the pre-Epic-W2 contract:
    answer_value/answer_label are still required — 422 if omitted."""
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    res = await client.post(
        f"/api/v1/assessments/{assessment_id}/responses",
        json={
            "question_id": "housing_situation",
            "question_text": "What best describes your current housing situation?",
            "category": "sdoh",
            "subcategory": "housing",
            "tags": [],
            # answer_value/answer_label omitted, skipped defaults to False.
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_skipped_response_counts_in_response_list_length(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """A skipped response is a real row in the responses list — the client
    computes 'X of 39' progress from len(responses), so a skip must count."""
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    body, _ = await _start_assessment(client, chw_tokens, session_id)
    assessment_id = body["id"]

    await client.post(
        f"/api/v1/assessments/{assessment_id}/responses",
        json={
            "question_id": "housing_situation",
            "question_text": "What best describes your current housing situation?",
            "category": "sdoh",
            "subcategory": "housing",
            "tags": [],
            "skipped": True,
        },
        headers=auth_header(chw_tokens),
    )

    res = await client.post(
        f"/api/v1/assessments/{assessment_id}/complete",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert len(res.json()["responses"]) == 1
    assert res.json()["responses"][0]["skipped"] is True


# ─── 7. Epic W3 — partial save + resume hydration ─────────────────────────────


@pytest.mark.asyncio
async def test_resume_hydrates_prior_answered_and_skipped_responses(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Reopening an in-progress assessment (idempotent start/resume) must
    return prior responses — including skipped ones — so the client can
    seed selected/skipped state on the form. This is a regression test: on
    pre-Epic-W2 code the 'skipped' key does not round-trip through the API
    at all, so this assertion fails on the old code.
    """
    request_id = await _create_request_and_accept(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)

    body1, code1 = await _start_assessment(client, chw_tokens, session_id)
    assert code1 == 201
    assessment_id = body1["id"]

    # Answer one question normally.
    await client.post(
        f"/api/v1/assessments/{assessment_id}/responses",
        json=_SAMPLE_RESPONSE_BODY,
        headers=auth_header(chw_tokens),
    )
    # Skip another question.
    await client.post(
        f"/api/v1/assessments/{assessment_id}/responses",
        json={
            "question_id": "food_insecurity",
            "question_text": "Were you ever worried that food would run out?",
            "category": "sdoh",
            "subcategory": "food_access",
            "tags": ["SDOH"],
            "skipped": True,
        },
        headers=auth_header(chw_tokens),
    )

    # Simulate the CHW closing and reopening the panel: the bootstrap flow
    # calls start/resume again for the same session, which must idempotently
    # return the SAME assessment with its responses hydrated (200, not 201).
    body2, code2 = await _start_assessment(client, chw_tokens, session_id)
    assert code2 == 200
    assert body2["id"] == assessment_id
    assert body2["status"] == "in_progress"

    responses_by_qid = {r["question_id"]: r for r in body2["responses"]}
    assert set(responses_by_qid.keys()) == {"housing_situation", "food_insecurity"}
    assert responses_by_qid["housing_situation"]["skipped"] is False
    assert responses_by_qid["housing_situation"]["answer_value"] == "own_or_rent_stable"
    assert responses_by_qid["food_insecurity"]["skipped"] is True
    assert responses_by_qid["food_insecurity"]["answer_value"] == "skipped"
