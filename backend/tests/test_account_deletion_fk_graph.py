"""FK-graph treatment tests for the hard-delete account deletion flow.

These tests seed one row in every member-owned PHI table (plus the two
DB-privilege-blocked ledger tables and the two untouched-but-referencing
tables) and assert, after DELETE /api/v1/auth/users/me, that:

  - every member-owned PHI table row is GONE (hard-deleted)
  - billing_claims / audit_log rows STILL EXIST, still point at the (now
    scrubbed) user id, and resolve to zero PII when joined to users
  - wellness_points_ledger / reward_redemptions rows STILL EXIST, unchanged
    (these are the two tables the service code must NEVER write to — see
    account_deletion.py module docstring)
  - the hard-deleted member no longer appears in a CHW roster/member-list
    endpoint response

This is a code-behavior test, not a DB-privilege test: the test DB is created
via Base.metadata.create_all, which does NOT apply the REVOKE statements from
the real migrations. If the service code were to (incorrectly) write to
wellness_points_ledger/reward_redemptions, this test would silently succeed
in the schema sense — the assertion here is purely "does our Python code
touch these rows", not "does Postgres block it".
"""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.audit import AuditLog
from app.models.billing import BillingClaim
from app.models.calendar import CalendarEvent
from app.models.case_note import CaseNote
from app.models.conversation import CallLog, Conversation, FileAttachment, Message
from app.models.enums import RequestStatus
from app.models.flag_note import FlagNote
from app.models.followup import SessionFollowup
from app.models.journeys import (
    JourneyTemplate,
    JourneyTemplateStep,
    MemberJourney,
    MemberJourneyStepState,
    WellnessPointsLedger,
)
from app.models.member_document import MemberDocument
from app.models.request import ServiceRequest
from app.models.reward import RewardTransaction
from app.models.rewards import RewardCatalogItem, RewardRedemption
from app.models.session import MemberConsent, Session, SessionDocumentation
from app.models.testimonial import Testimonial
from app.models.twilio import TwilioProxySession
from app.models.user import User
from app.services.s3_phi_cleanup import PhiCleanupResult
from tests.conftest import auth_header
from tests.conftest import test_session as _test_session_factory

_DELETE_URL = "/api/v1/auth/users/me"


@pytest.fixture(autouse=True)
def _stub_s3_phi_cleanup():
    with patch(
        "app.services.s3_phi_cleanup._cleanup_sync",
        return_value=PhiCleanupResult(),
    ):
        yield


def _extract_user_id(tokens: dict) -> uuid.UUID:
    import base64
    import json

    payload_b64 = tokens["access_token"].split(".")[1]
    payload_b64 += "=" * (-len(payload_b64) % 4)
    payload = json.loads(base64.urlsafe_b64decode(payload_b64))
    return uuid.UUID(payload["sub"])


async def _delete_account(client: AsyncClient, tokens: dict):
    return await client.request(
        "DELETE",
        _DELETE_URL,
        json={},
        headers=auth_header(tokens),
    )


class _SeededGraph:
    """Container of every id we need to assert on after deletion."""

    def __init__(self) -> None:
        self.member_id: uuid.UUID
        self.chw_id: uuid.UUID
        self.session_id: uuid.UUID
        """The UNBILLED session — must be hard-deleted."""
        self.billed_session_id: uuid.UUID
        """The BILLED session — must survive (billing_claims carve-out)."""
        self.billed_service_request_id: uuid.UUID
        """ServiceRequest backing the billed session — must survive (same carve-out)."""
        self.service_request_id: uuid.UUID
        self.conversation_id: uuid.UUID
        self.message_id: uuid.UUID
        self.file_attachment_id: uuid.UUID
        self.call_log_id: uuid.UUID
        self.case_note_id: uuid.UUID
        self.flag_note_id: uuid.UUID
        self.member_document_id: uuid.UUID
        self.member_consent_id: uuid.UUID
        self.session_documentation_id: uuid.UUID
        self.member_journey_id: uuid.UUID
        self.member_journey_step_state_id: uuid.UUID
        self.session_followup_id: uuid.UUID
        self.reward_transaction_id: uuid.UUID
        self.testimonial_id: uuid.UUID
        self.twilio_proxy_session_id: uuid.UUID
        self.billing_claim_id: uuid.UUID
        self.audit_log_id: uuid.UUID
        self.wellness_points_ledger_id: uuid.UUID
        self.reward_redemption_id: uuid.UUID
        self.calendar_event_id: uuid.UUID


async def _seed_full_graph(client: AsyncClient) -> tuple[dict, _SeededGraph]:
    """Register a member + CHW, then seed one row in every relevant table."""
    chw_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "fkgraph-chw@example.com",
            "password": "Testpass123!",
            "name": "FK Graph CHW",
            "role": "chw",
        },
    )
    assert chw_res.status_code == 201, chw_res.text
    chw_tokens = chw_res.json()
    chw_id = _extract_user_id(chw_tokens)

    member_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "fkgraph-member@example.com",
            "password": "Testpass123!",
            "name": "FK Graph Member",
            "role": "member",
            "phone": "+13105550199",
            "date_of_birth": "1990-01-01",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": "11112222A",
            "address_line1": "1 FK Ave",
            "city": "Los Angeles",
            "state": "CA",
            "zip_code": "90001",
            "terms_accepted": True,
            "communications_consent": True,
        },
    )
    assert member_res.status_code == 201, member_res.text
    member_tokens = member_res.json()
    member_id = _extract_user_id(member_tokens)

    g = _SeededGraph()
    g.member_id = member_id
    g.chw_id = chw_id

    now = datetime.now(UTC)

    async with _test_session_factory() as db:
        # ── ServiceRequest (matched — establishes the CHW roster relationship gate) ──
        service_request = ServiceRequest(
            id=uuid.uuid4(),
            member_id=member_id,
            matched_chw_id=chw_id,
            vertical="housing",
            verticals=["housing"],
            urgency="routine",
            description="FK graph test request",
            preferred_mode="virtual",
            status=RequestStatus.matched.value,
        )
        db.add(service_request)
        await db.flush()
        g.service_request_id = service_request.id

        # ── Session (+ SessionDocumentation, MemberConsent) ──────────────────────────
        session = Session(
            id=uuid.uuid4(),
            request_id=service_request.id,
            chw_id=chw_id,
            member_id=member_id,
            vertical="housing",
            status="completed",
            mode="virtual",
            started_at=now - timedelta(hours=1),
            ended_at=now,
        )
        db.add(session)
        await db.flush()
        g.session_id = session.id

        session_doc = SessionDocumentation(
            id=uuid.uuid4(),
            session_id=session.id,
            summary="FK graph test summary",
            members_served=1,
        )
        db.add(session_doc)
        await db.flush()
        g.session_documentation_id = session_doc.id

        member_consent = MemberConsent(
            id=uuid.uuid4(),
            session_id=session.id,
            member_id=member_id,
            consent_type="ai_transcription",
            typed_signature="FK Graph Member",
        )
        db.add(member_consent)
        await db.flush()
        g.member_consent_id = member_consent.id

        # ── Conversation (+ Message, FileAttachment, CallLog) ────────────────────────
        conversation = Conversation(
            id=uuid.uuid4(),
            chw_id=chw_id,
            member_id=member_id,
            session_id=session.id,
        )
        db.add(conversation)
        await db.flush()
        g.conversation_id = conversation.id

        message = Message(
            id=uuid.uuid4(),
            conversation_id=conversation.id,
            sender_id=member_id,
            body="FK graph test message",
            type="text",
        )
        db.add(message)
        await db.flush()
        g.message_id = message.id

        file_attachment = FileAttachment(
            id=uuid.uuid4(),
            message_id=message.id,
            s3_key="fk-graph/test.pdf",
            filename="test.pdf",
            size_bytes=100,
            content_type="application/pdf",
        )
        db.add(file_attachment)
        await db.flush()
        g.file_attachment_id = file_attachment.id

        call_log = CallLog(
            id=uuid.uuid4(),
            conversation_id=conversation.id,
            twilio_sid="CA_fk_graph_test",
            duration_seconds=60,
        )
        db.add(call_log)
        await db.flush()
        g.call_log_id = call_log.id

        # ── CaseNote / FlagNote ────────────────────────────────────────────────────
        case_note = CaseNote(
            id=uuid.uuid4(),
            member_id=member_id,
            chw_id=chw_id,
            session_id=session.id,
            body="FK graph test case note",
        )
        db.add(case_note)
        await db.flush()
        g.case_note_id = case_note.id

        flag_note = FlagNote(
            id=uuid.uuid4(),
            member_id=member_id,
            author_chw_id=chw_id,
            body="FK graph test flag note",
        )
        db.add(flag_note)
        await db.flush()
        g.flag_note_id = flag_note.id

        # ── MemberDocument ────────────────────────────────────────────────────────
        member_document = MemberDocument(
            id=uuid.uuid4(),
            member_id=member_id,
            document_type="id",
            filename="id.pdf",
            s3_url="s3://bucket/fk-graph/id.pdf",
            s3_key="fk-graph/id.pdf",
            content_type="application/pdf",
            size_bytes=100,
            uploaded_by=member_id,
        )
        db.add(member_document)
        await db.flush()
        g.member_document_id = member_document.id

        # ── CalendarEvent ─────────────────────────────────────────────────────────
        calendar_event = CalendarEvent(
            id=uuid.uuid4(),
            user_id=member_id,
            session_id=session.id,
            title="FK graph test event",
            date=now.date(),
        )
        db.add(calendar_event)
        await db.flush()
        g.calendar_event_id = calendar_event.id

        # ── A SECOND, BILLED session — must SURVIVE deletion (carve-out) ─────────────
        # billing_claims.session_id is a NOT NULL FK with no cascade, so a session
        # with a billing claim cannot be hard-deleted without violating that FK.
        # This session (and its backing ServiceRequest) is intentionally left in
        # place, same treatment as billing_claims itself.
        billed_service_request = ServiceRequest(
            id=uuid.uuid4(),
            member_id=member_id,
            matched_chw_id=chw_id,
            vertical="housing",
            verticals=["housing"],
            urgency="routine",
            description="FK graph billed request",
            preferred_mode="virtual",
            status=RequestStatus.matched.value,
        )
        db.add(billed_service_request)
        await db.flush()
        g.billed_service_request_id = billed_service_request.id

        billed_session = Session(
            id=uuid.uuid4(),
            request_id=billed_service_request.id,
            chw_id=chw_id,
            member_id=member_id,
            vertical="housing",
            status="completed",
            mode="virtual",
            started_at=now - timedelta(hours=2),
            ended_at=now - timedelta(hours=1),
        )
        db.add(billed_session)
        await db.flush()
        g.billed_session_id = billed_session.id

        # ── SessionFollowup ───────────────────────────────────────────────────────
        followup = SessionFollowup(
            id=uuid.uuid4(),
            session_id=session.id,
            member_id=member_id,
            chw_id=chw_id,
            kind="action_item",
            description="FK graph test followup",
        )
        db.add(followup)
        await db.flush()
        g.session_followup_id = followup.id

        # ── MemberJourney (+ template/step + MemberJourneyStepState) ────────────────
        journey_template = JourneyTemplate(
            id=uuid.uuid4(),
            slug=f"fk-graph-template-{uuid.uuid4().hex[:8]}",
            name="FK Graph Template",
            category="housing",
        )
        db.add(journey_template)
        await db.flush()

        journey_step = JourneyTemplateStep(
            id=uuid.uuid4(),
            template_id=journey_template.id,
            order=1,
            name="Step 1",
            description="FK graph step",
        )
        db.add(journey_step)
        await db.flush()

        member_journey = MemberJourney(
            id=uuid.uuid4(),
            member_id=member_id,
            template_id=journey_template.id,
            chw_id=chw_id,
            current_step_id=journey_step.id,
        )
        db.add(member_journey)
        await db.flush()
        g.member_journey_id = member_journey.id

        step_state = MemberJourneyStepState(
            id=uuid.uuid4(),
            member_journey_id=member_journey.id,
            template_step_id=journey_step.id,
            status="in_progress",
        )
        db.add(step_state)
        await db.flush()
        g.member_journey_step_state_id = step_state.id

        # ── RewardTransaction (app-owned ledger, NOT reward_redemptions) ────────────
        reward_txn = RewardTransaction(
            id=uuid.uuid4(),
            member_id=member_id,
            action="session_completed",
            description="FK graph test reward txn",
            points=10,
            balance_after=10,
        )
        db.add(reward_txn)
        await db.flush()
        g.reward_transaction_id = reward_txn.id

        # ── Testimonial ───────────────────────────────────────────────────────────
        testimonial = Testimonial(
            id=uuid.uuid4(),
            chw_id=chw_id,
            member_id=member_id,
            session_id=session.id,
            rating=5,
            text="FK graph test testimonial",
        )
        db.add(testimonial)
        await db.flush()
        g.testimonial_id = testimonial.id

        # ── TwilioProxySession ───────────────────────────────────────────────────────
        twilio_proxy = TwilioProxySession(
            id=uuid.uuid4(),
            chw_id=chw_id,
            member_id=member_id,
            twilio_session_sid="KC_fk_graph_test",
            chw_proxy_number="+13105550001",
            member_proxy_number="+13105550002",
        )
        db.add(twilio_proxy)
        await db.flush()
        g.twilio_proxy_session_id = twilio_proxy.id

        # ── BillingClaim (retained, untouched — via billed_session) ────────────────
        billing_claim = BillingClaim(
            id=uuid.uuid4(),
            session_id=billed_session.id,
            chw_id=chw_id,
            member_id=member_id,
            procedure_code="T1016",
            units=1,
            gross_amount=Decimal("50.00"),
            platform_fee=Decimal("5.00"),
            net_payout=Decimal("45.00"),
        )
        db.add(billing_claim)
        await db.flush()
        g.billing_claim_id = billing_claim.id

        # ── AuditLog (retained, untouched, pre-existing row) ───────────────────────
        audit_row = AuditLog(
            id=uuid.uuid4(),
            user_id=member_id,
            action="TEST_SEED",
            resource="fk_graph_test",
            resource_id=str(member_id),
        )
        db.add(audit_row)
        await db.flush()
        g.audit_log_id = audit_row.id

        # ── WellnessPointsLedger (DB-privilege-blocked; must survive UNCHANGED) ─────
        ledger_row = WellnessPointsLedger(
            id=uuid.uuid4(),
            member_id=member_id,
            points=10,
            reason="journey_step_completed",
        )
        db.add(ledger_row)
        await db.flush()
        g.wellness_points_ledger_id = ledger_row.id

        # ── RewardRedemption (DB-privilege-blocked; must survive UNCHANGED) ─────────
        catalog_item = RewardCatalogItem(
            id=uuid.uuid4(),
            sku=f"fk-graph-sku-{uuid.uuid4().hex[:8]}",
            name="FK Graph Reward",
            description="FK graph test reward",
            cost_points=10,
            fulfillment_type="digital_gift_card",
        )
        db.add(catalog_item)
        await db.flush()

        redemption = RewardRedemption(
            id=uuid.uuid4(),
            member_id=member_id,
            catalog_item_id=catalog_item.id,
            cost_points_at_redemption=10,
        )
        db.add(redemption)
        await db.flush()
        g.reward_redemption_id = redemption.id

        await db.commit()

    return member_tokens, g


class TestAccountDeletionFkGraph:
    async def test_full_fk_graph_treatment(self, client: AsyncClient):
        member_tokens, g = await _seed_full_graph(client)

        res = await _delete_account(client, member_tokens)
        assert res.status_code == 204, res.text

        async with _test_session_factory() as db:
            # ── Hard-deleted: zero rows via FK to the member ──────────────────────
            assert (
                await db.get(MemberDocument, g.member_document_id)
            ) is None, "MemberDocument must be hard-deleted"
            assert (await db.get(CaseNote, g.case_note_id)) is None, "CaseNote must be hard-deleted"
            assert (await db.get(FlagNote, g.flag_note_id)) is None, "FlagNote must be hard-deleted"
            assert (
                await db.get(Conversation, g.conversation_id)
            ) is None, "Conversation must be hard-deleted"
            assert (await db.get(Message, g.message_id)) is None, "Message must be hard-deleted"
            assert (
                await db.get(FileAttachment, g.file_attachment_id)
            ) is None, "FileAttachment must be hard-deleted"
            assert (await db.get(CallLog, g.call_log_id)) is None, "CallLog must be hard-deleted"
            assert (
                await db.get(ServiceRequest, g.service_request_id)
            ) is None, "ServiceRequest (unbilled) must be hard-deleted"
            assert (await db.get(Session, g.session_id)) is None, "Session (unbilled) must be hard-deleted"
            assert (
                await db.get(SessionDocumentation, g.session_documentation_id)
            ) is None, "SessionDocumentation must be hard-deleted"
            assert (
                await db.get(MemberConsent, g.member_consent_id)
            ) is None, "MemberConsent must be hard-deleted"
            assert (
                await db.get(MemberJourney, g.member_journey_id)
            ) is None, "MemberJourney must be hard-deleted"
            assert (
                await db.get(MemberJourneyStepState, g.member_journey_step_state_id)
            ) is None, "MemberJourneyStepState must be hard-deleted (cascade)"
            assert (
                await db.get(SessionFollowup, g.session_followup_id)
            ) is None, "SessionFollowup must be hard-deleted"
            assert (
                await db.get(RewardTransaction, g.reward_transaction_id)
            ) is None, "RewardTransaction must be hard-deleted"
            assert (
                await db.get(Testimonial, g.testimonial_id)
            ) is None, "Testimonial must be hard-deleted"
            assert (
                await db.get(TwilioProxySession, g.twilio_proxy_session_id)
            ) is None, "TwilioProxySession must be hard-deleted"
            assert (
                await db.get(CalendarEvent, g.calendar_event_id)
            ) is None, "CalendarEvent must be hard-deleted"

            # ── Retained, untouched: BillingClaim ─────────────────────────────────
            billing_claim = await db.get(BillingClaim, g.billing_claim_id)
            assert billing_claim is not None, "BillingClaim must STILL EXIST"
            assert billing_claim.member_id == g.member_id, "member_id FK must be unchanged"

            joined = await db.execute(
                select(User).where(User.id == billing_claim.member_id)
            )
            scrubbed_user = joined.scalar_one()
            assert scrubbed_user.name == "Deleted User"
            assert scrubbed_user.role == "deleted"

            # ── Retained: the BILLED session + its ServiceRequest (carve-out) ──────
            # billing_claims.session_id is a NOT NULL FK with no cascade — a
            # session still referenced by a billing claim cannot be hard-deleted
            # without violating that FK, so it (and its backing ServiceRequest)
            # is left in place instead, same treatment as billing_claims itself.
            billed_session = await db.get(Session, g.billed_session_id)
            assert billed_session is not None, (
                "Session referenced by a billing_claims row must survive (carve-out)"
            )
            assert billed_session.member_id == g.member_id

            billed_request = await db.get(ServiceRequest, g.billed_service_request_id)
            assert billed_request is not None, (
                "ServiceRequest backing a retained billed session must survive (carve-out)"
            )

            # ── Retained, untouched: AuditLog ─────────────────────────────────────
            audit_row = await db.get(AuditLog, g.audit_log_id)
            assert audit_row is not None, "Pre-existing AuditLog row must STILL EXIST"
            assert audit_row.user_id == g.member_id

            # ── DB-privilege-blocked: WellnessPointsLedger — must survive UNCHANGED ─
            ledger_row = await db.get(WellnessPointsLedger, g.wellness_points_ledger_id)
            assert ledger_row is not None, "wellness_points_ledger row must STILL EXIST"
            assert ledger_row.member_id == g.member_id
            assert ledger_row.points == 10

            # ── DB-privilege-blocked: RewardRedemption — must survive UNCHANGED ────
            redemption = await db.get(RewardRedemption, g.reward_redemption_id)
            assert redemption is not None, "reward_redemptions row must STILL EXIST"
            assert redemption.member_id == g.member_id
            assert redemption.status == "pending"

    async def test_hard_deleted_member_not_in_chw_roster(self, client: AsyncClient):
        """After hard-delete, the member must not appear in the CHW's roster
        (GET /api/v1/chw/members) — proven by both the MemberProfile join
        (row is gone) and the User.role == "member" filter (role is now
        "deleted").
        """
        member_tokens, g = await _seed_full_graph(client)

        # Re-login as the CHW to fetch their roster (chw_id was created inside
        # _seed_full_graph via /auth/register, discard those tokens and log
        # back in fresh since we only kept the raw ids).
        chw_login = await client.post(
            "/api/v1/auth/login",
            json={"email": "fkgraph-chw@example.com", "password": "Testpass123!"},
        )
        assert chw_login.status_code == 200, chw_login.text
        chw_tokens = chw_login.json()

        # Sanity check: member appears in the roster BEFORE deletion.
        pre_roster = await client.get(
            "/api/v1/chw/members", headers=auth_header(chw_tokens)
        )
        assert pre_roster.status_code == 200, pre_roster.text
        pre_ids = {row["id"] for row in pre_roster.json()}
        assert str(g.member_id) in pre_ids, "member must appear in the roster before deletion"

        res = await _delete_account(client, member_tokens)
        assert res.status_code == 204, res.text

        post_roster = await client.get(
            "/api/v1/chw/members", headers=auth_header(chw_tokens)
        )
        assert post_roster.status_code == 200, post_roster.text
        post_ids = {row["id"] for row in post_roster.json()}
        assert str(g.member_id) not in post_ids, (
            "hard-deleted member must NOT appear in the CHW roster"
        )
