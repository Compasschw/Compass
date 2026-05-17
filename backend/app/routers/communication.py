"""Communication endpoints — Vonage Voice API webhooks + the mobile
call-bridge endpoint + bidirectional masked call endpoints.

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

  POST /api/v1/member/chws/{chw_id}/call
       → Member-initiated masked call to a CHW. Eligibility: member must
         have ≥1 session with the CHW. Rate-limited to 5 calls per
         (member_id, chw_id, UTC day). Recording is OFF (no consent IVR).

  POST /api/v1/chw/members/{member_id}/call
       → CHW-initiated masked call to a member outside session context.
         Same eligibility + rate limit + no recording.

Security note: Vonage webhooks don't use our JWT — they authenticate
via signed JWTs using our application's public key. We verify in
`_verify_vonage_jwt()` below.
"""

import hashlib
import hmac
import logging
import time
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from jose import JWTError, jwt as jose_jwt
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

import app.config as _app_config_module  # lazy settings access for testability
from app.database import get_db
from app.dependencies import get_current_user
from app.services.communication import get_provider
from app.services.communication_touch_log import TouchKind, record_touch

logger = logging.getLogger("compass.communication")


# ─── Vonage webhook signature verification (Finding #1, CRITICAL) ─────────────
#
# Vonage's "Signed Webhooks" feature sends a JWT in the Authorization header,
# signed with HS256 using the account-level Signature Secret (configured in
# the Vonage API dashboard under Account Settings → "Signed Webhooks"). We:
#   1. Pull the JWT from `Authorization: Bearer <token>`
#   2. Verify HS256 signature with `settings.vonage_signature_secret`
#   3. Reject tokens with `iat` outside the 5-min replay window
#   4. For POST/PUT/PATCH (where a body is the primary payload), verify the
#      `payload_hash` claim matches SHA-256 of the raw request body
#
# GETs skip the body-hash check because Vonage hashes their query-string
# representation (not the empty body); the JWT signature + iat freshness
# remain primary auth.
#
# References:
#   https://developer.vonage.com/en/getting-started/concepts/webhooks#validating-signed-webhooks
#   https://developer.vonage.com/en/voice/voice-api/webhook-reference#answer-webhook


_VONAGE_SIG_MAX_AGE_SECONDS = 300  # 5 minutes — reject replayed webhooks


async def _verify_vonage_signature(request: Request) -> None:
    """FastAPI dependency that verifies the Vonage webhook JWT.

    Vonage sends a JWT in ``Authorization: Bearer <token>``, signed with
    HS256 using the account-level Signature Secret. The JWT body includes:

        iss            "Vonage"
        iat            issued-at Unix timestamp (replay-window source)
        jti            unique token id
        application_id our Vonage Application UUID
        payload_hash   SHA-256 hex of the raw request body (integrity)

    We validate the signature, ``iat`` freshness, and (when the body is
    non-empty) the ``payload_hash`` claim against a fresh SHA-256 of the
    actual body bytes.

    Behaviour by environment:
    - ``production``: always verify; return 401 on failure. config.py refuses
      to boot without ``vonage_signature_secret`` so an unset secret here is
      impossible.
    - Other environments: skip when secret unset; log a warning.

    Raises:
        HTTPException(401): JWT absent, invalid signature, replayed, or
        body-hash mismatch.
    """
    # Access through the module reference so tests that patch `app.config.settings`
    # see the patched object rather than a stale module-level import snapshot.
    _s = _app_config_module.settings
    vonage_secret = getattr(_s, "vonage_signature_secret", "")
    is_production = getattr(_s, "environment", "development") == "production"

    if not vonage_secret:
        if is_production:
            logger.error(
                "vonage signature verification skipped — secret not set in production; "
                "this is a critical security misconfiguration"
            )
            raise HTTPException(
                status_code=401,
                detail="Webhook signature verification is not configured.",
            )
        logger.warning(
            "vonage_signature_secret not set — skipping Vonage webhook signature "
            "verification (non-production environment). Set VONAGE_SIGNATURE_SECRET "
            "to enable verification."
        )
        return

    # ── Pull the JWT from the Authorization header ────────────────────────────
    auth_header = request.headers.get("authorization", "")
    if not auth_header.lower().startswith("bearer "):
        logger.warning(
            "vonage webhook rejected — no Bearer token present path=%s method=%s",
            request.url.path,
            request.method,
        )
        raise HTTPException(status_code=401, detail="Missing Vonage webhook JWT.")
    token = auth_header[7:].strip()

    # ── Decode + verify HS256 signature with our shared secret ────────────────
    try:
        claims = jose_jwt.decode(
            token,
            vonage_secret,
            algorithms=["HS256"],
            options={
                # Vonage doesn't issue ``exp``, freshness is checked via ``iat``.
                "verify_exp": False,
                "verify_aud": False,
            },
        )
    except JWTError as exc:
        logger.warning(
            "vonage webhook rejected — JWT verification failed path=%s err=%s",
            request.url.path,
            exc,
        )
        raise HTTPException(
            status_code=401, detail="Invalid Vonage webhook JWT signature."
        ) from exc

    # ── Replay window: reject tokens issued more than 5 minutes ago ──────────
    iat = claims.get("iat")
    if isinstance(iat, (int, float)):
        age_seconds = abs(int(time.time()) - int(iat))
        if age_seconds > _VONAGE_SIG_MAX_AGE_SECONDS:
            logger.warning(
                "vonage webhook rejected — iat outside replay window "
                "age_s=%d max_age_s=%d path=%s",
                age_seconds,
                _VONAGE_SIG_MAX_AGE_SECONDS,
                request.url.path,
            )
            raise HTTPException(
                status_code=401,
                detail="Vonage webhook iat outside acceptable window.",
            )

    # ── Body integrity: payload_hash is SHA-256 hex of the raw request body ──
    # Only enforced for POST / PUT / PATCH where the body is the principal
    # vehicle of data. For GET (e.g. /voice/answer that's expected to RETURN
    # an NCCO based on query params), Vonage's JWT carries a payload_hash but
    # over a different input than the empty body — left unverified here. The
    # JWT's HS256 signature still proves Vonage authored the request, and the
    # iat freshness check above bounds replay; the trade-off is documented.
    payload_hash_claim = claims.get("payload_hash")
    if payload_hash_claim and request.method in {"POST", "PUT", "PATCH"}:
        body_bytes = await request.body()
        actual_hash = hashlib.sha256(body_bytes or b"").hexdigest()
        if not hmac.compare_digest(actual_hash.lower(), payload_hash_claim.lower()):
            logger.warning(
                "vonage webhook rejected — body hash mismatch path=%s method=%s",
                request.url.path,
                request.method,
            )
            raise HTTPException(
                status_code=401, detail="Vonage webhook body hash mismatch."
            )

    logger.debug(
        "vonage webhook JWT verified path=%s method=%s",
        request.url.path,
        request.method,
    )

router = APIRouter(prefix="/api/v1/communication", tags=["communication"])

# ─── Bidirectional call routers ────────────────────────────────────────────────
# These are registered under /api/v1/member/ and /api/v1/chw/ prefixes for
# role-clarity but live in this file to keep all Vonage call logic co-located.

member_call_router = APIRouter(prefix="/api/v1/member", tags=["member-calls"])
chw_call_router = APIRouter(prefix="/api/v1/chw", tags=["chw-calls"])

# ─── Rate-limit constants ──────────────────────────────────────────────────────

_CALL_RATE_LIMIT = 5   # maximum outbound calls per (initiator, recipient) per calendar day


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


class AdHocCallRequest(BaseModel):
    """Optional body for bidirectional ad-hoc call endpoints."""
    reason: str | None = Field(
        default=None,
        max_length=500,
        description=(
            "Free-text reason for the call, stored in the audit log. "
            "Never logged to structured output — treat as PHI."
        ),
    )


class AdHocCallResponse(BaseModel):
    """Response from a bidirectional ad-hoc call endpoint."""
    provider_session_id: str
    rate_limit_remaining: int


# ─── Bidirectional call helpers ───────────────────────────────────────────────


async def _count_daily_calls(
    db: AsyncSession,
    initiator_id: UUID,
    recipient_id: UUID,
) -> int:
    """Return the number of 'call' touches the initiator made to the recipient today (UTC).

    Used to enforce the per-(initiator, recipient, day) rate limit without
    relying on slowapi's IP-keyed counter, which would incorrectly aggregate
    calls from the same IP to different recipients.
    """
    from app.services.communication_touch_log import CommunicationTouch

    today_start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    result = await db.execute(
        select(func.count())
        .select_from(CommunicationTouch)
        .where(
            CommunicationTouch.initiator_id == initiator_id,
            CommunicationTouch.recipient_id == recipient_id,
            CommunicationTouch.kind == "call",
            CommunicationTouch.created_at >= today_start,
        )
    )
    return result.scalar_one()


async def _assert_shared_session(
    db: AsyncSession,
    chw_id: UUID,
    member_id: UUID,
) -> None:
    """Raise HTTP 403 when the CHW and member have no shared session (any status).

    Eligibility gate: ad-hoc contact is only allowed when a care relationship
    exists — i.e. at least one session row links the two parties. This prevents
    any authenticated CHW from cold-calling any member.
    """
    from app.models.session import Session

    # Use EXISTS-style query: we only need to know if at least one row exists,
    # not the total count. SELECT 1 + LIMIT 1 is more efficient than COUNT(*).
    result = await db.execute(
        select(Session.id)
        .where(
            Session.chw_id == chw_id,
            Session.member_id == member_id,
        )
        .limit(1)
    )
    count = 1 if result.scalar_one_or_none() is not None else 0
    if count == 0:
        raise HTTPException(
            status_code=403,
            detail=(
                "Ad-hoc calls are only available when a care relationship exists. "
                "No shared sessions found between this CHW and member."
            ),
        )


async def _initiate_ad_hoc_call(
    db: AsyncSession,
    *,
    initiator_id: UUID,
    recipient_id: UUID,
    initiator_phone: str,
    recipient_phone: str,
    reason: str | None,
) -> AdHocCallResponse:
    """Core call logic shared by both bidirectional call endpoints.

    Calls ``create_proxy_session`` with the initiator's phone as the first leg
    (Vonage calls the initiator first, then bridges to the recipient when they
    answer). No recording — these are casual outreach calls, not clinical
    session encounters.

    Writes a CommunicationTouch audit row. Callers must commit the session
    after this returns.
    """
    provider = get_provider()
    # We pass initiator_phone as chw_phone and recipient_phone as member_phone
    # intentionally reusing the existing bridge signature. Direction (who is
    # CHW vs member) doesn't affect the call flow at the Vonage layer — the
    # "initiator" leg is always rung first.
    proxy = await provider.create_proxy_session(
        session_id=f"adhoc-{initiator_id}-{recipient_id}",
        chw_phone=initiator_phone,
        member_phone=recipient_phone,
    )

    daily_calls_before = await _count_daily_calls(db, initiator_id, recipient_id)

    await record_touch(
        db,
        initiator_id=initiator_id,
        recipient_id=recipient_id,
        kind=TouchKind.call,
        provider_session_id=proxy.provider_session_id,
        extra_data={
            "reason": reason,
            "recording": False,
            "proxy_number": proxy.proxy_number,
            "provider": proxy.provider,
        },
    )

    remaining = max(0, _CALL_RATE_LIMIT - daily_calls_before - 1)
    return AdHocCallResponse(
        provider_session_id=proxy.provider_session_id,
        rate_limit_remaining=remaining,
    )


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

    # Finding #8 (HIGH): enforce CHW ↔ member relationship gate on call-bridge.
    # Determine which party is CHW and which is member to use assert_shared_session.
    # If the caller is a CHW and recipient is a member, verify the relationship.
    # Admins are exempt from the relationship check.
    if current_user.role != "admin":
        chw_id_for_gate: UUID | None = None
        member_id_for_gate: UUID | None = None

        if caller.role == "chw" and recipient.role == "member":
            chw_id_for_gate = caller.id
            member_id_for_gate = recipient.id
        elif caller.role == "member" and recipient.role == "chw":
            chw_id_for_gate = recipient.id
            member_id_for_gate = caller.id

        if chw_id_for_gate is not None and member_id_for_gate is not None:
            from app.services.relationship_guards import assert_shared_session
            await assert_shared_session(
                db,
                chw_id=chw_id_for_gate,
                member_id=member_id_for_gate,
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


@router.api_route("/voice/answer", methods=["GET", "POST"])
async def voice_answer(
    request: Request,
    session: str | None = Query(default=None, description="Internal session id."),
    member: str | None = Query(default=None, description="Deprecated — member dialed by a separate outbound call."),
    _sig: None = Depends(_verify_vonage_signature),
):
    """Vonage calls this when the CHW leg answers. Returns an NCCO that:

    1. Plays a brief hold message to the CHW.
    2. Forks the CHW leg's audio to its own WebSocket (role="chw") when the
       per-leg WS feature is configured.
    3. Joins the CHW leg into a named Vonage Conversation (keyed on session_id).

    The member's leg is dialed by a SEPARATE outbound call placed by
    ``VonageProvider.create_proxy_session`` at the same time as the CHW leg.
    That second call's answer_url points at ``/voice/consent-prompt``, which
    runs the California §632 consent IVR; on DTMF "1" the member NCCO does
    its own WS fork + ``conversation(name=...)`` join — so both legs end up
    in the same named conversation and Vonage bridges their audio.

    Per-leg isolation topology (Pattern A — conversation + independent WS forks):
    ┌──────────────────────────────────────────────────────────────────────────┐
    │ CHW leg NCCO (this endpoint):                                            │
    │   talk → connect(ws_chw, role=chw) → conversation(name=<session_id>)   │
    │                                                                          │
    │ Member leg NCCO (via separate outbound call → consent-prompt →           │
    │ consent-result):                                                         │
    │   talk → input(dtmf) → talk(ack) → connect(ws_member, role=member)     │
    │        → conversation(name=<session_id>)                                 │
    └──────────────────────────────────────────────────────────────────────────┘

    Each WebSocket connection receives only the microphone audio of the leg
    whose NCCO listed it. The named Conversation bridges the two legs for
    two-way voice.

    Earlier versions placed only one outbound call (to CHW) and nested a
    ``connect(phone, onAnswer=consent_url)`` action inside this NCCO to dial
    the member. That pattern silently failed to bridge: the ``connect`` action
    blocks until its child leg ends, so the ``conversation`` action that
    follows it never executes while the call is live. Switching to two
    independent outbound calls + a shared conversation name fixes the bridge.

    NOTE: Accepts both GET and POST. Vonage's default ``answer_method`` is GET;
    POST-only causes a 405 on the CHW's answer event and the call aborts.

    NCCO reference: https://developer.vonage.com/en/voice/voice-api/ncco-reference
    """
    payload = await _safely_read_body(request)
    logger.info("voice/answer received (session=%s): %s", session, payload)
    # ``member`` query param retained for backward compat but no longer used —
    # the member leg is dialed by VonageProvider.create_proxy_session directly.
    _ = member

    from app.config import settings

    # Vonage Conversation name — must be identical on both legs so they are
    # joined into the same audio bridge.  We use the session_id so the
    # conversation name is stable and correlates back to the Compass session.
    conversation_name = f"compass-session-{session}" if session else "compass-session-unknown"

    # Build the optional CHW-leg WebSocket fork action.
    # Requires vonage_ws_audio_url_base + vonage_ws_jwt_secret to be set.
    chw_ws_connect_action: dict | None = None
    if settings.vonage_ws_audio_url_base and session:
        try:
            from uuid import UUID as _UUIDWS

            from app.utils.security import create_vonage_ws_token

            chw_ws_token = create_vonage_ws_token(_UUIDWS(session), role="chw")
            chw_ws_uri = (
                f"{settings.vonage_ws_audio_url_base}"
                f"/api/v1/sessions/{session}/transcript/vonage-stream"
                f"?token={chw_ws_token}"
            )
            chw_ws_connect_action = {
                "action": "connect",
                "from": settings.vonage_from_number or "",
                "endpoint": [
                    {
                        "type": "websocket",
                        "uri": chw_ws_uri,
                        # 16 kHz PCM signed int16 — matches AssemblyAI v3 streaming.
                        "content-type": "audio/l16;rate=16000",
                        "headers": {"session_id": session, "role": "chw"},
                    }
                ],
            }
            logger.info(
                "CHW-leg WebSocket fork configured session=%s → %s",
                session,
                settings.vonage_ws_audio_url_base,
            )
        except (RuntimeError, ValueError, Exception) as exc:  # noqa: BLE001
            logger.warning(
                "CHW-leg WebSocket fork skipped session=%s — token error: %s %s",
                session,
                type(exc).__name__,
                exc,
            )

    # Assemble the CHW leg NCCO. Order matters:
    #   1. talk — immediate hold message to the CHW.
    #   2. connect (websocket, optional) — fork CHW mic audio to the pipeline.
    #   3. conversation — join the named room. Member leg joins the same name
    #      after passing the consent IVR (placed as a separate outbound call).
    #
    # ``record: True`` on the CHW leg's conversation action enables
    # Vonage-side recording of the **entire** bridged audio (both legs),
    # which is the right primitive for a named multi-party conversation.
    # Only the first joiner's record setting takes effect; the member leg's
    # subsequent conversation join inherits it without needing its own
    # record action.  The eventUrl receives the ``recording_url`` callback
    # when the conversation ends.
    ncco: list[dict] = [
        {
            "action": "talk",
            "text": "Hold while we connect you to your member.",
        },
    ]
    if chw_ws_connect_action is not None:
        ncco.append(chw_ws_connect_action)
    ncco.append(
        {
            "action": "conversation",
            "name": conversation_name,
            "record": True,
            "eventUrl": [
                f"{_public_base_url()}/api/v1/communication/voice/events"
                f"?session={session or ''}"
            ],
            "eventMethod": "POST",
        }
    )
    return ncco


@router.api_route("/voice/consent-prompt", methods=["GET", "POST"])
async def voice_consent_prompt(
    request: Request,
    session: str | None = Query(default=None, description="Internal session id."),
    _sig: None = Depends(_verify_vonage_signature),
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

    # Voice quality: switch from Vonage's default standard TTS to an Amazon
    # Polly **neural** voice (much more natural prosody). We use the en-US
    # neural Joanna voice (Vonage NCCO ``language="en-US"`` + ``style=11`` +
    # ``premium=True``). SSML wrapping with explicit ``<break>`` tags gives
    # the IVR a deliberate, friendly cadence rather than a single run-on
    # sentence that members otherwise misparse as robotic.
    #
    # NB: SSML requires ``<speak>...</speak>`` as the outer element; Vonage
    # auto-detects SSML by the opening tag (no extra config needed).
    disclosure_ssml = (
        "<speak>"
        "Hello, this is Compass Community Health calling."
        '<break time="450ms"/>'
        "Your care worker is on the line to speak with you."
        '<break time="500ms"/>'
        "So we can keep accurate notes for your care, this call will be recorded."
        '<break time="600ms"/>'
        "<emphasis level=\"moderate\">Press 1</emphasis> to accept and connect now."
        '<break time="300ms"/>'
        "<emphasis level=\"moderate\">Press 2</emphasis> if you'd rather not be recorded."
        "</speak>"
    )
    return [
        {
            "action": "talk",
            "text": disclosure_ssml,
            "language": "en-US",
            "style": 11,         # en-US Joanna (Neural variant when premium=True)
            "premium": True,     # Use Polly Neural voice — far more natural
            "bargeIn": True,     # Member can press 1/2 before prompt finishes
        },
        {
            "action": "input",
            "type": ["dtmf"],
            "dtmf": {
                "maxDigits": 1,
                # 8s was tight — bump to 12s so a member who's still listening
                # has time to press after the second emphasis.
                "timeOut": 12,
                "submitOnHash": False,
            },
            "eventUrl": [consent_result_url],
        },
    ]


@router.api_route("/voice/consent-result", methods=["GET", "POST"])
async def voice_consent_result(
    request: Request,
    session: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _sig: None = Depends(_verify_vonage_signature),
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

        from app.config import settings

        # Vonage Conversation name — must match what voice/answer set on the
        # CHW leg so both legs join the same named audio bridge.
        conversation_name = f"compass-session-{session}" if session else "compass-session-unknown"

        # Build the per-leg WebSocket fork actions for the member leg.
        # We issue a token with role="member" so this leg's audio is routed to
        # the member-specific AssemblyAI streaming session.
        #
        # Requires BOTH vonage_ws_audio_url_base (wss:// base) AND
        # vonage_ws_jwt_secret to be configured.  Either absent → graceful
        # degradation: fall back to conversation-only (no transcription WS),
        # so production calls are never dropped due to a config gap.
        member_ws_connect_action: dict | None = None

        if settings.vonage_ws_audio_url_base and session:
            try:
                from uuid import UUID as _UUIDWS

                from app.utils.security import create_vonage_ws_token

                member_ws_token = create_vonage_ws_token(_UUIDWS(session), role="member")
                member_ws_uri = (
                    f"{settings.vonage_ws_audio_url_base}"
                    f"/api/v1/sessions/{session}/transcript/vonage-stream"
                    f"?token={member_ws_token}"
                )
                member_ws_connect_action = {
                    "action": "connect",
                    "from": settings.vonage_from_number or "",
                    "endpoint": [
                        {
                            "type": "websocket",
                            "uri": member_ws_uri,
                            # 16 kHz PCM signed int16 — matches AssemblyAI v3
                            # streaming (universal_streaming_english / u3_rt_pro).
                            "content-type": "audio/l16;rate=16000",
                            # Headers carry session_id and role so the receiving
                            # handler can log/correlate without parsing the JWT.
                            "headers": {"session_id": session, "role": "member"},
                        }
                    ],
                }
                logger.info(
                    "Member-leg WebSocket fork configured session=%s → %s",
                    session,
                    settings.vonage_ws_audio_url_base,
                )
            except RuntimeError as exc:
                # create_vonage_ws_token raises RuntimeError when
                # vonage_ws_jwt_secret is not set.  Fall back gracefully.
                logger.warning(
                    "Member-leg WebSocket fork skipped session=%s — token generation failed: %s",
                    session,
                    exc,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Member-leg WebSocket fork skipped session=%s — unexpected error: %s",
                    session,
                    exc,
                )
        else:
            if not settings.vonage_ws_audio_url_base:
                logger.debug(
                    "vonage_ws_audio_url_base not configured — per-leg WebSocket fork disabled "
                    "(set VONAGE_WS_AUDIO_URL_BASE=wss://api.joincompasschw.com to enable)"
                )

        # Assemble the member-leg NCCO.  Action order matters to Vonage:
        #   1. talk — immediate acknowledgement to the member ("Thank you…").
        #   2. connect (websocket, optional) — forks member mic audio to the
        #      member-specific AssemblyAI streaming session before the
        #      conversation join, ensuring no audio gap at the start.
        #      This is a passthrough: execution continues to the next action.
        #   3. conversation — joins the member leg into the named Vonage
        #      Conversation that the CHW leg already joined (set in voice/answer).
        #      This bridges the two legs so they can hear each other.
        #
        # Recording is handled by ``record: True`` on the **CHW leg's**
        # conversation action (the first joiner sets the recording policy for
        # the named conversation).  A per-leg ``record`` action here would
        # finalize on its own silence/timeout long before the bridge ends —
        # which is what produced the earlier 18KB/38KB consent-prompt-only
        # MP3s instead of the full bridged audio.
        #
        # No bargeIn after talk — the next action is `connect` (not `input`).
        # Vonage rejects bargeIn-followed-by-non-input as a syntax error.
        ncco: list[dict] = [
            {
                "action": "talk",
                "text": "Thank you. You are now connected.",
            },
        ]
        if member_ws_connect_action is not None:
            ncco.append(member_ws_connect_action)
        # Join the member leg into the same named conversation as the CHW leg.
        ncco.append(
            {
                "action": "conversation",
                "name": conversation_name,
            }
        )

        return ncco

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


@router.api_route("/voice/events", methods=["GET", "POST"])
async def voice_events(
    request: Request,
    session: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _sig: None = Depends(_verify_vonage_signature),
):
    """Vonage posts call lifecycle events here.

    Event types we care about:
      - started, ringing, answered, completed: lifecycle logging
      - record: persists the recording URL on CommunicationSession

    Accepts both GET and POST. Vonage sends most lifecycle events as POST
    with a JSON body, but a few error/status pings come through as GET with
    the data in query params (e.g. `?reason=NCCO%20download%20error`). We
    merge query params into the parsed payload so both code paths see the
    same shape downstream.
    """
    from sqlalchemy import select

    from app.models.communication import CommunicationSession

    payload = await _safely_read_body(request)
    if not isinstance(payload, dict) or not payload:
        # GET ping or empty body — promote query params so downstream logic
        # still sees a dict it can read from.
        payload = dict(request.query_params)
    event_type = payload.get("status") or payload.get("event_type") or payload.get("reason")
    logger.info("voice/events (session=%s type=%s): %s", session, event_type, payload)

    # Resolve the CommunicationSession via the deterministic
    # ``compass-session-<session_id>`` mapping we set in
    # ``VonageProvider.create_proxy_session``.  Vonage's own ``conversation_uuid``
    # changes per call leg, so matching on it would miss the bridged
    # conversation entirely.  When create_proxy_session was called more than
    # once for the same session (retries), update the most recent row so the
    # finalisation lands where the user will actually look.
    comm_session: CommunicationSession | None = None
    if session:
        target_provider_id = f"compass-session-{session}"
        result = await db.execute(
            select(CommunicationSession)
            .where(CommunicationSession.provider_session_id == target_provider_id)
            .order_by(CommunicationSession.created_at.desc())
            .limit(1)
        )
        comm_session = result.scalar_one_or_none()

    # ── Recording URL persistence ─────────────────────────────────────────
    if payload.get("recording_url"):
        recording_url = payload["recording_url"]
        # Trust-boundary validation: the inbound webhook payload is attacker-
        # controllable until Vonage signature verification covers this branch.
        # Reject anything that is not https + a known Vonage-controlled host so
        # we never store (and later re-serve) a hostile URL on a PHI row.
        if not _is_safe_vendor_recording_url(recording_url):
            logger.warning(
                "voice/events: rejected unsafe recording_url=%r (session=%s)",
                recording_url,
                session,
            )
        elif comm_session is not None:
            comm_session.recording_url = recording_url
            recording_uuid = payload.get("recording_uuid")
            if recording_uuid:
                comm_session.provider_recording_id = str(recording_uuid)
            # Vonage gives us start/end timestamps on the record event; derive
            # duration so the UI can show "X-minute call" without re-parsing.
            start_iso = payload.get("start_time")
            end_iso = payload.get("end_time")
            if start_iso and end_iso:
                try:
                    from datetime import datetime as _dt
                    start_dt = _dt.fromisoformat(str(start_iso).replace("Z", "+00:00"))
                    end_dt = _dt.fromisoformat(str(end_iso).replace("Z", "+00:00"))
                    comm_session.recording_duration_seconds = max(
                        0, int((end_dt - start_dt).total_seconds())
                    )
                except (ValueError, TypeError):
                    pass
            await db.commit()
            logger.info(
                "Recording URL saved for session %s (compass session=%s)",
                comm_session.id, session,
            )
        else:
            logger.warning(
                "voice/events: recording_url received but no CommunicationSession "
                "found for session=%s (payload conv_uuid=%s)",
                session, payload.get("conversation_uuid"),
            )

    # ── Call-completion finalisation ──────────────────────────────────────
    # Vonage sends per-leg ``status=completed`` events with ``disconnected_by``
    # set to ``user`` (the participant hung up) or ``platform`` (Vonage timed
    # the leg out / NCCO finished).  We flip the CommunicationSession to
    # ``completed`` on the first ``user`` disconnect we see so the row reflects
    # that the bridge has ended and downstream finalisation (transcript merge,
    # AI summary trigger) can kick in.
    if (
        event_type == "completed"
        and comm_session is not None
        and comm_session.status != "completed"
        and payload.get("disconnected_by") == "user"
    ):
        from datetime import datetime as _dt, timezone as _tz
        comm_session.status = "completed"
        comm_session.closed_at = _dt.now(_tz.utc)
        await db.commit()
        logger.info(
            "CommunicationSession %s marked completed (compass session=%s)",
            comm_session.id, session,
        )

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


# Vendor-controlled hosts we trust to serve recording media. Anything else
# is refused at ingest so we never persist and re-serve a hostile URL.
# Vonage hosts: api.nexmo.com (legacy global), api-{region}.nexmo.com (regional).
# Our own S3 bucket may also host recordings exported by ops jobs.
_SAFE_RECORDING_HOST_SUFFIXES: tuple[str, ...] = (
    ".nexmo.com",
    ".vonage.com",
    ".s3.amazonaws.com",
    ".s3-us-west-2.amazonaws.com",
)


def _is_safe_vendor_recording_url(url: object) -> bool:
    """Validate a recording URL before persistence.

    Returns True only when the value is a string, parses as ``https://``, and
    the host (case-folded) ends with a suffix in ``_SAFE_RECORDING_HOST_SUFFIXES``.
    Used by the Vonage voice webhook (attacker-controllable input) and the
    session-end recording finaliser (provider-controlled but worth defending
    against compromised provider credentials).
    """
    if not isinstance(url, str) or not url:
        return False
    from urllib.parse import urlparse

    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https":
        return False
    host = (parsed.hostname or "").lower()
    if not host:
        return False
    return any(host == suffix.lstrip(".") or host.endswith(suffix) for suffix in _SAFE_RECORDING_HOST_SUFFIXES)


def _public_base_url() -> str:
    """Public URL Vonage can reach. Derived from magic_link_base_url."""
    from app.config import settings

    base = settings.magic_link_base_url.rstrip("/")
    if base.endswith("/auth/magic"):
        base = base[: -len("/auth/magic")]
    return base.replace("https://joincompasschw.com", "https://api.joincompasschw.com")


# ─── Bidirectional ad-hoc call endpoints ─────────────────────────────────────
#
# Two mirror endpoints:
#   POST /api/v1/member/chws/{chw_id}/call   — member initiates call to CHW
#   POST /api/v1/chw/members/{member_id}/call — CHW initiates call to member
#
# Shared rules (enforced by _assert_shared_session + _count_daily_calls):
#   1. Both parties must have ≥1 session (any status) in common → 403 otherwise.
#   2. Rate limit: 5 calls per (initiator_id, recipient_id) per UTC calendar day.
#      We use the CommunicationTouch table rather than slowapi's IP counter
#      because slowapi counts per IP — a CHW sharing a wifi could exhaust a
#      member's quota. DB-level counting per user pair is correct.
#   3. No recording: no `record` NCCO action, no consent IVR. These are casual
#      outreach calls outside clinical session context.
#
# Note: both routers are imported and registered in app/main.py.


@member_call_router.post(
    "/chws/{chw_id}/call",
    response_model=AdHocCallResponse,
    status_code=200,
    summary="Member initiates masked outbound call to CHW",
    description=(
        "Rings the member's registered phone first (member-initiated). When the "
        "member answers, Vonage bridges to the CHW's phone via masked proxy number. "
        "No recording — no consent IVR. Rate-limited to 5 calls per (member, CHW) "
        "per calendar day. Requires ≥1 shared session to establish care relationship."
    ),
)
async def member_call_chw(
    chw_id: UUID,
    body: AdHocCallRequest | None = None,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AdHocCallResponse:
    """POST /api/v1/member/chws/{chw_id}/call

    Auth: authenticated member.
    Eligibility: member must have ≥1 session (any status) with the target CHW.
    Rate limit: 5 per (member_id, chw_id) per UTC calendar day.

    Returns:
        provider_session_id: Vonage conversation UUID.
        rate_limit_remaining: number of calls remaining today.
    """
    from app.models.user import User

    if current_user.role not in ("member",):
        raise HTTPException(
            status_code=403,
            detail="Only members may call this endpoint. CHWs should use /chw/members/{id}/call.",
        )

    chw = await db.get(User, chw_id)
    if chw is None or not chw.is_active:
        raise HTTPException(status_code=404, detail="CHW not found.")
    if chw.role != "chw":
        raise HTTPException(status_code=400, detail="Target user is not a CHW.")

    caller = await db.get(User, current_user.id)
    if caller is None:
        raise HTTPException(status_code=404, detail="Current user not found.")

    if not caller.phone or not chw.phone:
        raise HTTPException(
            status_code=400,
            detail="Both parties must have a verified phone number on file.",
        )

    # Eligibility: ≥1 shared session (any status).
    await _assert_shared_session(db, chw_id=chw_id, member_id=current_user.id)

    # Per-(member, CHW, day) rate limit enforced via CommunicationTouch table.
    daily_count = await _count_daily_calls(db, current_user.id, chw_id)
    if daily_count >= _CALL_RATE_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Rate limit reached: {_CALL_RATE_LIMIT} calls per day to the same CHW. "
                "Please try again tomorrow."
            ),
        )

    reason = (body.reason if body else None)

    response = await _initiate_ad_hoc_call(
        db,
        initiator_id=current_user.id,
        recipient_id=chw_id,
        initiator_phone=caller.phone,
        recipient_phone=chw.phone,
        reason=reason,
    )
    await db.commit()

    logger.info(
        "member→chw ad-hoc call: member=%s chw=%s provider_session=%s",
        current_user.id,
        chw_id,
        response.provider_session_id,
    )
    return response


@chw_call_router.post(
    "/members/{member_id}/call",
    response_model=AdHocCallResponse,
    status_code=200,
    summary="CHW initiates masked outbound call to member outside session context",
    description=(
        "Rings the CHW's registered phone first (CHW-initiated). When the CHW "
        "answers, Vonage bridges to the member's phone via masked proxy number. "
        "No recording — no consent IVR. Rate-limited to 5 calls per (CHW, member) "
        "per calendar day. Requires ≥1 shared session to establish care relationship."
    ),
)
async def chw_call_member(
    member_id: UUID,
    body: AdHocCallRequest | None = None,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AdHocCallResponse:
    """POST /api/v1/chw/members/{member_id}/call

    Auth: authenticated CHW.
    Eligibility: CHW must have ≥1 session (any status) with the target member.
    Rate limit: 5 per (chw_id, member_id) per UTC calendar day.

    Returns:
        provider_session_id: Vonage conversation UUID.
        rate_limit_remaining: number of calls remaining today.
    """
    from app.models.user import User

    if current_user.role not in ("chw",):
        raise HTTPException(
            status_code=403,
            detail="Only CHWs may call this endpoint. Members should use /member/chws/{id}/call.",
        )

    member = await db.get(User, member_id)
    if member is None or not member.is_active:
        raise HTTPException(status_code=404, detail="Member not found.")
    if member.role != "member":
        raise HTTPException(status_code=400, detail="Target user is not a member.")

    caller = await db.get(User, current_user.id)
    if caller is None:
        raise HTTPException(status_code=404, detail="Current user not found.")

    if not caller.phone or not member.phone:
        raise HTTPException(
            status_code=400,
            detail="Both parties must have a verified phone number on file.",
        )

    # Eligibility: ≥1 shared session (any status).
    await _assert_shared_session(db, chw_id=current_user.id, member_id=member_id)

    # Per-(CHW, member, day) rate limit enforced via CommunicationTouch table.
    daily_count = await _count_daily_calls(db, current_user.id, member_id)
    if daily_count >= _CALL_RATE_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Rate limit reached: {_CALL_RATE_LIMIT} calls per day to the same member. "
                "Please try again tomorrow."
            ),
        )

    reason = (body.reason if body else None)

    response = await _initiate_ad_hoc_call(
        db,
        initiator_id=current_user.id,
        recipient_id=member_id,
        initiator_phone=caller.phone,
        recipient_phone=member.phone,
        reason=reason,
    )
    await db.commit()

    logger.info(
        "chw→member ad-hoc call: chw=%s member=%s provider_session=%s",
        current_user.id,
        member_id,
        response.provider_session_id,
    )
    return response
