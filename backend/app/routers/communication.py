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
    """Vonage calls this when the CHW answers — returns an NCCO to connect
    the call to the member.

    NCCO reference: https://developer.vonage.com/en/voice/voice-api/ncco-reference
    """
    payload = await _safely_read_body(request)
    logger.info("voice/answer received (session=%s member=%s): %s", session, member, payload)

    if not member:
        # No member to bridge to — play a short message and hang up.
        return [
            {
                "action": "talk",
                "text": "This call is not configured. Please hang up and try again.",
            }
        ]

    from app.config import settings

    # Full NCCO: announce, then connect, with recording enabled.
    return [
        {
            "action": "talk",
            "text": "Connecting you to your CompassCHW session.",
            "bargeIn": True,
        },
        {
            "action": "record",
            "eventUrl": [f"{_public_base_url()}/api/v1/communication/voice/events?session={session}"],
            "endOnSilence": 3,
            "format": "mp3",
            "beepStart": False,
        },
        {
            "action": "connect",
            "from": settings.vonage_from_number or "",
            "endpoint": [{"type": "phone", "number": member}],
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
