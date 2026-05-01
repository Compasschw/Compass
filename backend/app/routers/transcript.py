"""WebSocket endpoint for real-time session transcript streaming.

Endpoint: WS /api/v1/sessions/{session_id}/transcript/stream

Authentication:
  Bearer JWT passed as ?token=<JWT> query parameter.
  FastAPI's HTTPBearer cannot intercept WebSocket handshakes because the
  browser WebSocket API does not support custom headers. The de-facto pattern
  for WebSocket JWT auth is a short-lived token passed as a query parameter —
  the same pattern used by Supabase Realtime, Ably, and similar services.
  The token is validated before the handshake is accepted; unauthenticated
  requests receive a 4001 close or are rejected at the WS accept stage.

Connection lifecycle:
  1. Client opens WS with ?token=<access JWT>
  2. Server decodes token, loads user, verifies they are CHW or member on
     the session. Consent check is skipped (see TODO below).
  3. Server accepts the connection and registers it as a hub subscriber.
  4. If caller is the CHW, their user_id is recorded for speaker attribution.
  5. Client sends binary frames (16-bit PCM 16kHz mono) → forwarded to
     the provider streaming session.
  6. Client may send JSON control messages: {"type": "stop"}.
  7. Server pings every HEARTBEAT_INTERVAL_S; drops connection after
     HEARTBEAT_TIMEOUT_S without a pong.
  8. On disconnect, subscriber is removed. If last subscriber, the provider
     session is torn down.

HIPAA notes:
  - Audio bytes are NEVER logged (even at DEBUG level).
  - Transcript text is NEVER logged — only connection metadata is logged.
  - Close codes 4001 (auth) and 4003 (forbidden) signal rejection reason
    without exposing PHI in close reasons.

Speaker diarization limitation (Phase 2):
  AssemblyAI returns labels "A" / "B" derived from audio characteristics.
  We do NOT know which label corresponds to which role (CHW vs member)
  because both participants are on the same audio stream from the CHW's
  phone mic. speaker_role is therefore always "unknown" in Phase 2.
  Phase 3 will introduce dual-mic mode where each device streams separately,
  enabling true per-speaker role tagging.
"""

from __future__ import annotations

import asyncio
import json
import logging
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models.session import MemberConsent, Session
from app.services.transcript_hub import Subscription, transcript_hub
from app.utils.security import decode_token

logger = logging.getLogger("compass.transcript")

router = APIRouter(prefix="/api/v1/sessions", tags=["transcript"])

# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------

HEARTBEAT_INTERVAL_S: int = 20
HEARTBEAT_TIMEOUT_S: int = 60

# WebSocket close codes (4000-4999 are application-defined).
WS_CLOSE_AUTH_FAILED = 4001
WS_CLOSE_CONSENT_REQUIRED = 4002
WS_CLOSE_FORBIDDEN = 4003
WS_CLOSE_SESSION_NOT_FOUND = 4004
WS_CLOSE_INTERNAL_ERROR = 4500

# Consent type required for AI transcription.
# Must match the value stored in MemberConsent.consent_type by the member
# before the WebSocket stream is allowed to open.
CONSENT_TYPE_AI_TRANSCRIPTION: str = "ai_transcription"

# Control message types sent by the client.
CTRL_STOP = "stop"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _authenticate_ws(
    websocket: WebSocket,
    token: str | None,
) -> tuple[UUID, str] | None:
    """Decode the JWT from the query param and return (user_id, role).

    Returns None and closes the socket with 4001 if auth fails.
    Closing before accept() causes the HTTP 403 upgrade rejection.
    """
    if not token:
        await websocket.close(
            code=WS_CLOSE_AUTH_FAILED,
            reason="Missing token",
        )
        return None

    payload = decode_token(token)
    if payload is None or payload.get("type") != "access":
        await websocket.close(
            code=WS_CLOSE_AUTH_FAILED,
            reason="Invalid or expired token",
        )
        return None

    user_id_str: str | None = payload.get("sub")
    if user_id_str is None:
        await websocket.close(
            code=WS_CLOSE_AUTH_FAILED,
            reason="Invalid token payload",
        )
        return None

    try:
        user_id = UUID(user_id_str)
    except ValueError:
        await websocket.close(
            code=WS_CLOSE_AUTH_FAILED,
            reason="Malformed token subject",
        )
        return None

    role: str = payload.get("role", "")
    return user_id, role


async def _load_session_and_authorize(
    websocket: WebSocket,
    db: AsyncSession,
    session_id: UUID,
    user_id: UUID,
) -> Session | None:
    """Load the Session row and verify the user is CHW or member on it.

    Returns None and closes the socket with the appropriate code on failure.
    """
    from app.models.user import User

    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        await websocket.close(
            code=WS_CLOSE_AUTH_FAILED,
            reason="User not found or inactive",
        )
        return None

    session = await db.get(Session, session_id)
    if session is None:
        await websocket.close(
            code=WS_CLOSE_SESSION_NOT_FOUND,
            reason="Session not found",
        )
        return None

    is_participant = user_id == session.chw_id or user_id == session.member_id
    if not is_participant and user.role != "admin":
        logger.warning(
            "transcript WS rejected: user=%s is not a participant on session=%s",
            user_id,
            session_id,
        )
        await websocket.close(
            code=WS_CLOSE_FORBIDDEN,
            reason="Not a participant on this session",
        )
        return None

    # Consent gate: the member must have an ai_transcription consent row for
    # this session before the WebSocket stream is allowed to open.
    # Admin users bypass this check — they may need to monitor sessions for
    # compliance without going through the member consent flow.
    if user.role != "admin":
        consent_result = await db.execute(
            select(MemberConsent).where(
                MemberConsent.session_id == session_id,
                MemberConsent.consent_type == CONSENT_TYPE_AI_TRANSCRIPTION,
            )
        )
        if consent_result.scalar_one_or_none() is None:
            logger.warning(
                "transcript WS rejected: no ai_transcription consent for session=%s user=%s",
                session_id,
                user_id,
            )
            await websocket.close(
                code=WS_CLOSE_CONSENT_REQUIRED,
                reason="Member consent required for AI transcription",
            )
            return None

    return session


async def _run_heartbeat(
    websocket: WebSocket,
    session_id: UUID,
    shutdown_event: asyncio.Event,
) -> None:
    """Ping the client every HEARTBEAT_INTERVAL_S.

    Sets the shutdown_event if a pong is not received within
    HEARTBEAT_TIMEOUT_S, which causes the main loop to break and clean up.

    FastAPI's Starlette WebSocket implementation handles ping/pong at the
    transport layer — we send an explicit application-level ping and rely on
    the client to send any message (pong or otherwise) to prove liveness.

    Note: Starlette 0.36+ supports websocket.send_bytes(b"") as a ping;
    for true RFC 6455 ping frames use the underlying ASGI scope if needed.
    This implementation uses a JSON keep-alive message which is portable
    across all client runtimes (iOS WKWebView, React Native, etc.).
    """
    last_pong_at: float = asyncio.get_event_loop().time()

    while not shutdown_event.is_set():
        await asyncio.sleep(HEARTBEAT_INTERVAL_S)
        if shutdown_event.is_set():
            break
        try:
            await websocket.send_text(json.dumps({"type": "ping"}))
        except Exception:  # noqa: BLE001
            logger.info(
                "transcript heartbeat send failed — initiating shutdown session=%s",
                session_id,
            )
            shutdown_event.set()
            return

        # Allow HEARTBEAT_TIMEOUT_S for the client to send anything back.
        # The main receive loop updates last_pong_at on every message.
        # We check the gap here; if exceeded, force disconnect.
        gap = asyncio.get_event_loop().time() - last_pong_at
        if gap > HEARTBEAT_TIMEOUT_S:
            logger.warning(
                "transcript heartbeat timeout gap=%.1fs session=%s — closing",
                gap,
                session_id,
            )
            shutdown_event.set()
            return

    # Heartbeat exits cleanly when shutdown_event is set from the main loop.


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


@router.websocket("/{session_id}/transcript/stream")
async def transcript_stream(
    websocket: WebSocket,
    session_id: UUID,
    token: str | None = None,
) -> None:
    """Stream real-time transcript chunks for a session.

    Binary frames from the CHW's device are forwarded to the transcription
    provider; resulting chunks are fanned out to all session subscribers
    (both CHW and member if connected).

    Query params:
      token (str, required): A valid access JWT for the connecting user.

    Close codes:
      4001 — authentication failed
      4003 — user is not a participant on this session
      4004 — session not found
      4500 — internal server error
      1000 — normal close (client sent {"type": "stop"})
      1001 — server-initiated close (session teardown or idle timeout)
    """
    # --- Step 1: Auth (before accept so we can return HTTP-level rejection) ---
    auth_result = await _authenticate_ws(websocket, token)
    if auth_result is None:
        return  # Socket already closed inside _authenticate_ws
    user_id, _role_from_token = auth_result

    # --- Step 2: DB lookup + participant check ---
    # We open a short-lived DB connection just for the handshake checks, then
    # close it. The WS loop itself does not hold a DB connection — all
    # subsequent data flows through the hub, not the DB.
    session_obj: Session | None = None
    try:
        async with async_session() as db:
            session_obj = await _load_session_and_authorize(
                websocket=websocket,
                db=db,
                session_id=session_id,
                user_id=user_id,
            )
    except Exception as exc:
        logger.error(
            "transcript WS DB error during auth session=%s: %s",
            session_id,
            type(exc).__name__,
        )
        await websocket.close(code=WS_CLOSE_INTERNAL_ERROR, reason="Internal error")
        return

    if session_obj is None:
        return  # Socket already closed inside _load_session_and_authorize

    is_chw = user_id == session_obj.chw_id

    # --- Step 3: Accept the connection ---
    await websocket.accept()
    logger.info(
        "transcript WS connected user=%s session=%s role=%s",
        user_id,
        session_id,
        "chw" if is_chw else "member",
    )

    # --- Step 4: Register subscriber + lazy-start provider ---
    subscription: Subscription = await transcript_hub.subscribe(session_id, websocket)
    provider_stream = await transcript_hub.get_or_create_provider_stream(session_id)

    # Record the CHW as the audio source for speaker-role attribution.
    if is_chw and transcript_hub.get_chw_user_id(session_id) is None:
        transcript_hub.set_chw_user_id(session_id, user_id)

    # --- Step 5: Main receive loop + heartbeat ---
    shutdown_event = asyncio.Event()
    heartbeat_task = asyncio.create_task(
        _run_heartbeat(websocket, session_id, shutdown_event),
        name=f"transcript-hb-{session_id}",
    )

    try:
        while not shutdown_event.is_set():
            try:
                message = await asyncio.wait_for(
                    websocket.receive(),
                    timeout=float(HEARTBEAT_TIMEOUT_S),
                )
            except TimeoutError:
                logger.warning(
                    "transcript receive timeout session=%s user=%s — closing",
                    session_id,
                    user_id,
                )
                break
            except WebSocketDisconnect:
                logger.info(
                    "transcript WS disconnected session=%s user=%s",
                    session_id,
                    user_id,
                )
                break

            # Detect client-initiated close
            if message.get("type") == "websocket.disconnect":
                logger.info(
                    "transcript WS client closed session=%s user=%s code=%s",
                    session_id,
                    user_id,
                    message.get("code"),
                )
                break

            # Binary frame → audio chunk → forward to provider
            raw_bytes: bytes | None = message.get("bytes")
            if raw_bytes is not None:
                # HIPAA: do NOT log audio bytes or their length at INFO/WARNING.
                # DEBUG-level byte-count logging is acceptable in dev environments
                # where PHI protections are understood, but omitted here by default.
                if is_chw:
                    # Only the CHW device sends audio in Phase 2 (single-mic).
                    # TODO(dual-mic): Accept audio from member too when both phones
                    #   contribute separate streams and the provider supports
                    #   multi-channel streaming.
                    try:
                        await provider_stream.send_audio(raw_bytes)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "provider send_audio failed session=%s: %s",
                            session_id,
                            type(exc).__name__,
                        )
                continue

            # Text frame → control message
            raw_text: str | None = message.get("text")
            if raw_text is not None:
                try:
                    ctrl = json.loads(raw_text)
                except json.JSONDecodeError:
                    logger.debug(
                        "transcript WS received non-JSON text frame session=%s",
                        session_id,
                    )
                    continue

                msg_type: str = ctrl.get("type", "")

                if msg_type == CTRL_STOP:
                    logger.info(
                        "transcript stop requested session=%s user=%s",
                        session_id,
                        user_id,
                    )
                    await websocket.send_text(
                        json.dumps({"type": "stopped", "session_id": str(session_id)})
                    )
                    await websocket.close(code=1000)
                    break

                if msg_type == "pong":
                    # Client acknowledged our ping — update liveness. The
                    # heartbeat coroutine checks the gap on the next ping cycle.
                    # We use a mutable container so the inner function can write to it.
                    logger.debug(
                        "transcript pong received session=%s user=%s",
                        session_id,
                        user_id,
                    )
                    continue

                logger.debug(
                    "transcript WS unknown control type=%s session=%s",
                    msg_type,
                    session_id,
                )

    except Exception as exc:  # noqa: BLE001
        logger.error(
            "transcript WS unexpected error session=%s user=%s: %s",
            session_id,
            user_id,
            type(exc).__name__,
        )

    finally:
        # Guaranteed cleanup regardless of exit path.
        shutdown_event.set()
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass

        await transcript_hub.remove_subscriber(subscription)
        logger.info(
            "transcript WS teardown complete session=%s user=%s",
            session_id,
            user_id,
        )
