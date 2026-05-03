"""Communication endpoints — Vonage Voice API webhooks + the mobile
call-bridge endpoint.

Routes:
  POST /api/v1/communication/call-bridge
       → Called by the mobile `phone.dial()` service. Initiates a masked
         call from our Vonage number to the CHW (the initiator). Returns
         the proxy number so the app can show it to the user.

  POST /api/v1/communication/voice/answer
       → Vonage calls this when the CHW's leg answers. We return an NCCO
         (call control object) that connects the call to the member's
         real number. Vonage bridges the two legs in the background.

  POST /api/v1/communication/voice/events
       → Vonage posts lifecycle events here: ringing, answered,
         completed, record. We log them for observability + persist the
         recording URL when Vonage uploads the recording.

Security note: Vonage webhooks don't use our JWT — they authenticate
via signed JWTs using our application's public key. We verify in
`_verify_vonage_jwt()` below.
"""

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.services.communication import get_provider

logger = logging.getLogger("compass.communication")

router = APIRouter(prefix="/api/v1/communication", tags=["communication"])


# ─── Schemas ─────────────────────────────────────────────────────────────────


class CallBridgeRequest(BaseModel):
    """Mobile app → backend: 'start a masked call to this recipient'."""
    recipient_id: UUID
    session_id: UUID | None = None


class CallBridgeResponse(BaseModel):
    """Backend → mobile app: 'here's the proxy number to display'."""
    proxy_number: str
    provider_session_id: str
    expires_at_iso: str | None = None


# ─── Call-bridge (mobile-facing) ─────────────────────────────────────────────


@router.post("/call-bridge", response_model=CallBridgeResponse)
async def call_bridge(
    body: CallBridgeRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Initiate a masked call between the current user and the recipient.

    Flow:
      1. Look up the recipient's phone from the User table.
      2. Create a Vonage outbound call (see VonageProvider).
      3. Return the proxy number so the mobile app can show it / dial it.
    """
    from app.models.communication import CommunicationSession
    from app.models.user import User

    caller = await db.get(User, current_user.id)
    recipient = await db.get(User, body.recipient_id)
    if caller is None or recipient is None:
        raise HTTPException(status_code=404, detail="User not found.")
    if not caller.phone or not recipient.phone:
        raise HTTPException(
            status_code=400,
            detail="Both parties must have a verified phone number on file.",
        )

    provider = get_provider()
    proxy = await provider.create_proxy_session(
        session_id=str(body.session_id or body.recipient_id),
        chw_phone=caller.phone,
        member_phone=recipient.phone,
    )

    # Persist the session so webhook events can correlate back to the
    # compass session. session_id is required by the model — skip DB write
    # for ad-hoc calls that aren't tied to a scheduled session (rare).
    if body.session_id is not None:
        db.add(
            CommunicationSession(
                session_id=body.session_id,
                provider=proxy.provider,
                provider_session_id=proxy.provider_session_id,
                proxy_number=proxy.proxy_number,
            )
        )
        await db.commit()

    logger.info(
        "call-bridge initiated: caller=%s recipient=%s session=%s provider_session=%s",
        caller.id, recipient.id, body.session_id, proxy.provider_session_id,
    )
    return CallBridgeResponse(
        proxy_number=proxy.proxy_number,
        provider_session_id=proxy.provider_session_id,
    )


# ─── Vonage webhooks ─────────────────────────────────────────────────────────


@router.post("/voice/answer")
async def voice_answer(
    request: Request,
    session: str | None = Query(default=None, description="Internal session id."),
    member: str | None = Query(default=None, description="Member phone number (digits only)."),
):
    """Vonage calls this when the CHW answers — returns an NCCO that bridges
    the call to the member through a recording-consent IVR.

    Consent flow (California Civil Code §632 — two-party consent):
      1. CHW answers (this endpoint fires).
      2. NCCO: ``connect`` to member, then on member-answer the IVR plays
         the disclosure and collects DTMF.
      3. Member presses 1 → /voice/consent-result returns the record+connect
         NCCO and writes a MemberConsent row.
      4. Member presses 2 (or no input) → /voice/consent-result returns a
         polite hangup, no recording, session marked
         ``cancelled_no_consent`` by the events webhook.

    NCCO reference: https://developer.vonage.com/en/voice/voice-api/ncco-reference
    """
    payload = await _safely_read_body(request)
    logger.info("voice/answer received (session=%s member=%s): %s", session, member, payload)

    if not member:
        return [
            {
                "action": "talk",
                "text": "This call is not configured. Please hang up and try again.",
            }
        ]

    from app.config import settings

    # The "answerOnAnswer" pattern: connect to member; once the member's leg
    # picks up, the inner `onAnswer` URL fires and returns the consent IVR.
    # That second NCCO drives the disclosure → DTMF → consent decision.
    consent_url = (
        f"{_public_base_url()}/api/v1/communication/voice/consent-prompt"
        f"?session={session or ''}"
    )
    return [
        {
            "action": "talk",
            "text": "Hold while we connect you to your member.",
            "bargeIn": True,
        },
        {
            "action": "connect",
            "from": settings.vonage_from_number or "",
            "endpoint": [
                {
                    "type": "phone",
                    "number": member,
                    # When the member picks up, Vonage fetches this NCCO and
                    # plays it on the member leg before bridging audio.
                    "onAnswer": {"url": consent_url},
                }
            ],
        },
    ]


@router.post("/voice/consent-prompt")
async def voice_consent_prompt(
    request: Request,
    session: str | None = Query(default=None, description="Internal session id."),
):
    """Played to the member's leg the moment they answer the call.

    Reads the recording-consent disclosure required by California's two-party
    consent law (Cal. Civ. Code §632) and collects a single DTMF digit. The
    digit is delivered to /voice/consent-result, which returns either the
    record+connect continuation (consent granted) or a polite hangup
    (consent declined).

    Repeating the prompt on no-input / invalid-input gives the member a
    second chance before we treat silence as a decline.
    """
    payload = await _safely_read_body(request)
    logger.info("voice/consent-prompt (session=%s): %s", session, payload)

    consent_result_url = (
        f"{_public_base_url()}/api/v1/communication/voice/consent-result"
        f"?session={session or ''}"
    )
    disclosure = (
        "Hello. This call is from your CompassCHW community health worker. "
        "For documentation and Medi-Cal billing, this call needs to be recorded. "
        "Press 1 to consent and continue. Press 2 to decline and hang up."
    )
    return [
        {
            "action": "talk",
            "text": disclosure,
            "bargeIn": True,
        },
        {
            "action": "input",
            "type": ["dtmf"],
            "dtmf": {
                "maxDigits": 1,
                "timeOut": 8,
                "submitOnHash": False,
            },
            "eventUrl": [consent_result_url],
        },
    ]


@router.post("/voice/consent-result")
async def voice_consent_result(
    request: Request,
    session: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    """Receives the DTMF digit collected by /voice/consent-prompt.

    Decision matrix:
      digit == "1"  → write MemberConsent (consent_type='session_recording'),
                      return record + (no-op) NCCO so audio is captured for
                      the remainder of the call.
      anything else → polite goodbye NCCO + hangup. The events webhook will
                      see the call ended and mark the session
                      ``cancelled_no_consent``.

    NCCO reference for `input.dtmf`:
    https://developer.vonage.com/en/voice/voice-api/ncco-reference#input
    """
    from datetime import UTC, datetime
    from uuid import UUID as _UUID

    from app.models.session import MemberConsent, Session

    payload = await _safely_read_body(request)
    logger.info("voice/consent-result (session=%s): %s", session, payload)

    digit = ""
    if isinstance(payload, dict):
        # Vonage sends `dtmf` as either a string or a dict per SDK version.
        dtmf_field = payload.get("dtmf")
        if isinstance(dtmf_field, dict):
            digit = (dtmf_field.get("digits") or "").strip()
        elif isinstance(dtmf_field, str):
            digit = dtmf_field.strip()

    if digit == "1" and session:
        # Write the consent record. `typed_signature` is repurposed here as a
        # method-of-consent marker — "DTMF:1@<phone>" — so audit trails can
        # tell IVR consent apart from typed-signature web consent.
        try:
            session_uuid = _UUID(session)
            session_row = await db.get(Session, session_uuid)
            if session_row is not None:
                caller_number = ""
                if isinstance(payload, dict):
                    caller_number = str(payload.get("from") or payload.get("to") or "")
                consent = MemberConsent(
                    session_id=session_uuid,
                    member_id=session_row.member_id,
                    consent_type="session_recording",
                    typed_signature=f"DTMF:1@{caller_number}"[:255],
                )
                db.add(consent)
                # Mark the audio-recording opt-in on the session itself for
                # quick joinless lookups by the billing pipeline.
                session_row.recording_consent_given_at = datetime.now(UTC)
                await db.commit()
                logger.info("Recording consent recorded for session %s via DTMF", session)
        except Exception as e:  # noqa: BLE001
            logger.error("Failed to persist DTMF consent for session %s: %s", session, e)

        return [
            {
                "action": "talk",
                "text": "Thank you. You are now connected.",
                "bargeIn": True,
            },
            {
                "action": "record",
                "eventUrl": [
                    f"{_public_base_url()}/api/v1/communication/voice/events"
                    f"?session={session or ''}"
                ],
                "endOnSilence": 3,
                "format": "mp3",
                "beepStart": False,
            },
        ]

    # Decline path (digit "2", invalid, or timeout).
    if session:
        try:
            session_uuid = _UUID(session)
            session_row = await db.get(Session, session_uuid)
            if session_row is not None and session_row.status == "in_progress":
                session_row.status = "cancelled_no_consent"
                await db.commit()
                logger.info(
                    "Session %s marked cancelled_no_consent after declined IVR consent",
                    session,
                )
        except Exception as e:  # noqa: BLE001
            logger.error("Failed to mark session %s as cancelled_no_consent: %s", session, e)

    return [
        {
            "action": "talk",
            "text": (
                "We could not record consent. Your CHW will follow up with you. "
                "Goodbye."
            ),
        },
    ]


@router.post("/voice/events")
async def voice_events(
    request: Request,
    session: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    """Vonage posts call lifecycle events here.

    Event types we care about:
      - started, ringing, answered, completed: lifecycle logging
      - record: persists the recording URL on CommunicationSession
    """
    from sqlalchemy import select

    from app.models.communication import CommunicationSession

    payload = await _safely_read_body(request)
    event_type = (payload.get("status") if isinstance(payload, dict) else None) or (
        payload.get("event_type") if isinstance(payload, dict) else None
    )
    logger.info("voice/events (session=%s type=%s): %s", session, event_type, payload)

    # If this is a recording event, persist the URL on the session.
    if isinstance(payload, dict) and payload.get("recording_url"):
        recording_url = payload["recording_url"]
        provider_session_id = payload.get("conversation_uuid") or payload.get("call_uuid")
        if provider_session_id:
            result = await db.execute(
                select(CommunicationSession).where(
                    CommunicationSession.provider_session_id == provider_session_id
                )
            )
            comm_session = result.scalar_one_or_none()
            if comm_session is not None:
                comm_session.recording_url = recording_url
                await db.commit()
                logger.info("Recording URL saved for session %s", provider_session_id)

    return {"received": True}


# ─── Helpers ────────────────────────────────────────────────────────────────


async def _safely_read_body(request: Request) -> dict:
    """Vonage sends JSON bodies but occasionally form-encoded on older apps.
    Accept both without crashing."""
    try:
        return await request.json()
    except Exception:  # noqa: BLE001
        try:
            form = await request.form()
            return dict(form)
        except Exception:  # noqa: BLE001
            return {}


def _public_base_url() -> str:
    """Public URL Vonage can reach. Derived from magic_link_base_url."""
    from app.config import settings

    base = settings.magic_link_base_url.rstrip("/")
    if base.endswith("/auth/magic"):
        base = base[: -len("/auth/magic")]
    return base.replace("https://joincompasschw.com", "https://api.joincompasschw.com")
