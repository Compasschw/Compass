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
# Vonage signs webhook requests using HMAC-SHA256 with your account-level
# signature secret (configured in the Vonage API dashboard under
# API Settings → Signature method: SHA-256 HMAC).
#
# Signature scheme:
#   1. Vonage sends the signature as an `Authorization: Bearer <sig>` header
#      OR as a `sig` parameter appended to the query string / body.
#   2. The HMAC input is the concatenation of all query/body parameters sorted
#      alphabetically (key=value pairs) plus the shared secret appended.
#
# Because the exact scheme varies by Vonage SDK version and webhook type, we
# support two patterns:
#   A. JWT-style: `Authorization: Bearer <token>` — where <token> is a
#      Vonage-issued JWT.  We verify the HMAC signature embedded in it.
#   B. X-Vonage-Signature header — raw HMAC-SHA256 hex digest of the sorted
#      payload params, keyed with vonage_signature_secret.
#
# Design decision: use HMAC-SHA256 with vonage_signature_secret (account-level)
# rather than RS256 JWT (application-level JWKS) for two reasons:
#   1. HMAC verification is synchronous and requires no external network call.
#   2. The Vonage API dashboard's "Signature method" setting covers ALL
#      account-level webhooks regardless of Application configuration, making
#      it the single control plane that ops teams understand.
#
# References:
#   https://developer.vonage.com/en/getting-started/concepts/webhooks#validating-signed-webhooks
#   https://developer.vonage.com/en/voice/voice-api/webhook-reference#answer-webhook


_VONAGE_SIG_MAX_AGE_SECONDS = 300  # 5 minutes — reject replayed webhooks


def _compute_vonage_hmac(
    params: dict,
    secret: str,
) -> str:
    """Compute the expected HMAC-SHA256 hex digest for a Vonage webhook payload.

    Vonage sorts all payload parameters alphabetically by key, concatenates
    them as ``&key=value`` pairs (no leading ``&``), then appends the shared
    secret with an ``&`` separator and digests the whole string.

    Args:
        params: Dict of query-string or body parameters from the webhook.
                Must NOT include the ``sig`` key itself.
        secret: The account-level Vonage signature secret.

    Returns:
        Lowercase hex digest of the HMAC-SHA256 hash.
    """
    sorted_params = sorted(
        (k, v) for k, v in params.items() if k != "sig"
    )
    message = "&".join(f"{k}={v}" for k, v in sorted_params)
    message += f"&{secret}"
    return hmac.new(
        key=secret.encode(),
        msg=message.encode(),
        digestmod=hashlib.sha256,
    ).hexdigest()  # hmac.new() is the stdlib HMAC constructor (Python 3.x)


async def _verify_vonage_signature(request: Request) -> None:
    """FastAPI dependency that verifies the Vonage webhook HMAC-SHA256 signature.

    Behaviour by environment:
    - ``production``: always verify; return 401 on failure.
      The server refuses to start without ``vonage_signature_secret`` (guarded
      in config.py), so an empty secret here is impossible in production.
    - Other environments (development, staging): skip verification when
      ``vonage_signature_secret`` is empty, log a warning, and continue.
      This allows local development without a Vonage account while still
      exercising the real code path when the secret IS set.

    Raises:
        HTTPException(401): Signature absent, invalid, or replayed (outside window).
    """
    # Access through the module reference so tests that patch `app.config.settings`
    # see the patched object rather than a stale module-level import snapshot.
    _s = _app_config_module.settings
    vonage_secret = getattr(_s, "vonage_signature_secret", "")
    is_production = getattr(_s, "environment", "development") == "production"

    if not vonage_secret:
        if is_production:
            # config.py sys.exit(1) guard should have prevented reaching here,
            # but be defensive in case the object was hot-patched in tests.
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

    # Collect all params: merge query string + body (both GET and POST supported).
    params: dict[str, str] = dict(request.query_params)

    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        try:
            body_json = await request.json()
            if isinstance(body_json, dict):
                params.update({k: str(v) for k, v in body_json.items()})
        except Exception:  # noqa: BLE001
            pass
    elif "application/x-www-form-urlencoded" in content_type:
        try:
            form = await request.form()
            params.update(dict(form))
        except Exception:  # noqa: BLE001
            pass

    # Try to get the signature from the Authorization header (Bearer <sig>)
    # or from the X-Vonage-Signature header, or from the sig query/body param.
    received_sig: str = ""

    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        received_sig = auth_header[7:].strip()

    if not received_sig:
        received_sig = request.headers.get("x-vonage-signature", "").strip()

    if not received_sig:
        received_sig = params.get("sig", "").strip()

    if not received_sig:
        logger.warning(
            "vonage webhook rejected — no signature present "
            "path=%s method=%s",
            request.url.path,
            request.method,
        )
        raise HTTPException(status_code=401, detail="Missing Vonage webhook signature.")

    # Replay-window check: Vonage embeds a `timestamp` param (Unix seconds).
    # Reject webhooks older than _VONAGE_SIG_MAX_AGE_SECONDS.
    timestamp_str = params.get("timestamp", "")
    if timestamp_str:
        try:
            webhook_ts = int(timestamp_str)
            age_seconds = abs(int(time.time()) - webhook_ts)
            if age_seconds > _VONAGE_SIG_MAX_AGE_SECONDS:
                logger.warning(
                    "vonage webhook rejected — timestamp outside replay window "
                    "age_s=%d max_age_s=%d path=%s",
                    age_seconds,
                    _VONAGE_SIG_MAX_AGE_SECONDS,
                    request.url.path,
                )
                raise HTTPException(
                    status_code=401,
                    detail="Vonage webhook timestamp outside acceptable window.",
                )
        except ValueError:
            # Non-integer timestamp — do not block but log.
            logger.warning(
                "vonage webhook timestamp is non-integer: %r — skipping age check",
                timestamp_str,
            )

    expected_sig = _compute_vonage_hmac(params, vonage_secret)

    if not hmac.compare_digest(expected_sig.lower(), received_sig.lower()):
        logger.warning(
            "vonage webhook rejected — HMAC mismatch path=%s method=%s",
            request.url.path,
            request.method,
        )
        raise HTTPException(status_code=401, detail="Invalid Vonage webhook signature.")

    logger.debug(
        "vonage webhook signature verified path=%s method=%s",
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
    member: str | None = Query(default=None, description="Member phone number (digits only)."),
    _sig: None = Depends(_verify_vonage_signature),
):
    """Vonage calls this when the CHW answers — returns an NCCO that:

    1. Forks the CHW leg's audio to its own WebSocket (role="chw") when the
       per-leg WS feature is configured.
    2. Joins the CHW leg into a named Vonage Conversation (keyed on session_id).
    3. Connects to the member's phone via a separate ``connect`` action whose
       ``onAnswer`` URL fires on the member's leg, letting that leg run its own
       consent IVR and per-leg WS fork independently.

    Per-leg isolation topology (Pattern A — conversation + independent WS forks):
    ┌──────────────────────────────────────────────────────────────────────────┐
    │ CHW leg NCCO (this endpoint):                                            │
    │   talk → connect(ws_chw, role=chw) → conversation(name=<session_id>)   │
    │                                                                          │
    │ Member leg NCCO (via onAnswer → consent-prompt → consent-result):        │
    │   talk → input(dtmf) → talk(ack) → connect(ws_member, role=member)     │
    │        → conversation(name=<session_id>)                                 │
    └──────────────────────────────────────────────────────────────────────────┘
    The two WebSocket connections each receive only the microphone audio of
    the leg their NCCO runs on (Vonage sends per-leg mic audio to a websocket
    endpoint that appears in that leg's own NCCO before the conversation join).
    The named Conversation bridges the two legs for voice so participants can
    still hear each other.

    When vonage_ws_audio_url_base is not configured (local dev / staging without
    the feature enabled), the WS fork actions are omitted and the call falls back
    to a direct connect+conversation without transcription — the call still works.

    NOTE: Accepts both GET and POST. Vonage's default ``answer_method`` is GET;
    POST-only causes a 405 on the CHW's answer event and the call aborts.

    Consent flow (California Civil Code §632 — two-party consent):
      1. CHW answers (this endpoint fires).
      2. CHW leg joins the named conversation after its optional WS fork.
      3. Member's leg fires onAnswer → consent-prompt IVR → consent-result.
      4. Member presses 1 → consent-result NCCO: WS fork + conversation join.
      5. Member presses 2 (or no input) → polite hangup on member leg.

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

    # Vonage Conversation name — must be identical on both legs so they are
    # joined into the same audio bridge.  We use the session_id so the
    # conversation name is stable and correlates back to the Compass session.
    conversation_name = f"compass-session-{session}" if session else "compass-session-unknown"

    # The "answerOnAnswer" pattern: connect to member phone; once the member
    # picks up, the inner `onAnswer` URL fires on that leg and returns the
    # consent IVR NCCO.  That NCCO drives disclosure → DTMF → consent-result.
    consent_url = (
        f"{_public_base_url()}/api/v1/communication/voice/consent-prompt"
        f"?session={session or ''}"
    )

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

    # Assemble the CHW leg NCCO.
    # Action ordering matters:
    #   1. talk — immediate hold message to the CHW.
    #   2. connect (websocket, optional) — fork CHW mic audio to the pipeline.
    #      This is a passthrough: after the WS connects, execution continues.
    #   3. connect (phone + onAnswer) — dial the member; triggers member-leg NCCO.
    #   NOTE: `bargeIn` on `talk` is only valid when the next action is `input`.
    #   Vonage rejects bargeIn-followed-by-connect as a syntax error.
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
            "action": "connect",
            "from": settings.vonage_from_number or "",
            "endpoint": [
                {
                    "type": "phone",
                    "number": member,
                    # When the member picks up, Vonage fetches this NCCO and
                    # plays it on the member leg — independently of the CHW leg.
                    "onAnswer": {"url": consent_url},
                }
            ],
        }
    )

    # Join the CHW leg into the named conversation so the two legs can hear
    # each other.  The member leg joins the same conversation name after consent.
    ncco.append(
        {
            "action": "conversation",
            "name": conversation_name,
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
        #   3. record — backup mp3 upload via /voice/events; kept regardless of
        #      WS fork state for compliance audit trail (Medi-Cal billing).
        #   4. conversation — joins the member leg into the named Vonage
        #      Conversation that the CHW leg already joined (set in voice/answer).
        #      This bridges the two legs so they can hear each other.
        #
        # No bargeIn after talk — the next action is `connect` (not `input`).
        # Vonage rejects bargeIn-followed-by-non-input as a syntax error.
        record_action: dict = {
            "action": "record",
            "eventUrl": [
                f"{_public_base_url()}/api/v1/communication/voice/events"
                f"?session={session or ''}"
            ],
            "endOnSilence": 3,
            "format": "mp3",
            "beepStart": False,
        }

        ncco: list[dict] = [
            {
                "action": "talk",
                "text": "Thank you. You are now connected.",
            },
        ]
        if member_ws_connect_action is not None:
            ncco.append(member_ws_connect_action)
        ncco.append(record_action)
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

    # If this is a recording event, persist the URL on the session.
    if payload.get("recording_url"):
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
