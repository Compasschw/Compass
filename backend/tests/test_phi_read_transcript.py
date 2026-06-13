"""phi_read audit coverage for the session transcript read (audit 2026-06-12 #13).

GET /api/v1/sessions/{id}/transcript exposes transcript text (PHI), so it must
write a phi_read AuditLog row (HIPAA §164.312(b)). Uses the admin-key auth path
to keep the test self-contained (no participant/JWT setup), which also exercises
the actor_user_id=None branch.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.config import settings
from app.models.audit import AuditLog
from app.models.request import ServiceRequest
from app.models.session import Session, SessionTranscript
from app.models.user import User
from tests.conftest import test_session as _test_session_factory


def _admin_header() -> dict[str, str]:
    return {"Authorization": f"Bearer {settings.admin_key}"}


@pytest.mark.asyncio
async def test_transcript_read_writes_phi_read_audit(client: AsyncClient):
    async with _test_session_factory() as db:
        chw = User(email="t_chw@x.com", password_hash="x", name="T CHW", role="chw")
        member = User(email="t_mem@x.com", password_hash="x", name="T Member", role="member")
        db.add_all([chw, member])
        await db.flush()

        req = ServiceRequest(
            member_id=member.id,
            vertical="housing",
            verticals=["housing"],
            urgency="routine",
            description="seed",
            preferred_mode="phone",
            status="completed",
        )
        db.add(req)
        await db.flush()

        session = Session(
            request_id=req.id,
            chw_id=chw.id,
            member_id=member.id,
            vertical="housing",
            status="completed",
            mode="phone",
        )
        db.add(session)
        await db.flush()

        db.add(SessionTranscript(
            session_id=session.id,
            speaker_label="A",
            speaker_role="chw",
            text="PHI transcript content",
            is_final=True,
            started_at_ms=0,
        ))
        await db.commit()
        session_id = session.id

    res = await client.get(
        f"/api/v1/sessions/{session_id}/transcript",
        headers=_admin_header(),
    )
    assert res.status_code == 200, res.text
    assert res.json()["total"] == 1

    async with _test_session_factory() as db:
        rows = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.action == "phi_read",
                    AuditLog.resource == "session_transcript",
                    AuditLog.resource_id == str(session_id),
                )
            )
        ).scalars().all()
    assert rows, "expected a phi_read audit row for the transcript read"
    assert rows[-1].details["actor_role"] == "admin"
    assert rows[-1].details["chunk_count"] == 1
    assert rows[-1].user_id is None  # admin-key access has no user actor


@pytest.mark.asyncio
async def test_transcript_read_404_writes_no_audit(client: AsyncClient):
    """A 404 (no such session) must not write a phi_read row — nothing was read."""
    missing = uuid.uuid4()
    res = await client.get(
        f"/api/v1/sessions/{missing}/transcript",
        headers=_admin_header(),
    )
    assert res.status_code == 404

    async with _test_session_factory() as db:
        rows = (
            await db.execute(
                select(AuditLog).where(
                    AuditLog.action == "phi_read",
                    AuditLog.resource == "session_transcript",
                    AuditLog.resource_id == str(missing),
                )
            )
        ).scalars().all()
    assert not rows
