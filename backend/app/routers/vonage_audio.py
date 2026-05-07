"""WebSocket endpoint for Vonage Voice audio ingestion into the transcript pipeline.

Endpoint: WS /api/v1/sessions/{session_id}/transcript/vonage-stream?token=<jwt>

Purpose:
    Vonage Voice calls the CHW's phone during a session.  When the call is
    answered, the NCCO agent instructs Vonage to forward raw audio via a
    WebSocket to this endpoint.  We pipe every binary frame straight into the
    existing ``TranscriptHub`` / AssemblyAI streaming pipeline — exactly the
    same path a CHW device uses, so the full fan-out and persistence machinery
    continues to work without modification.

Authentication:
    Short-lived HS256 JWT issued by the NCCO answer webhook (via
    ``create_vonage_ws_token``).  Passed as ``?token=<jwt>`` because Vonage's
    WebSocket client cannot set custom HTTP headers on the initial upgrade
    request.  The token is validated (signature + exp + sub == "vonage") before
    the WebSocket handshake is accepted.

Connection lifecycle:
    1. Vonage opens WS with ``?token=<jwt>``.
    2. Server validates token; closes with 4001 on failure.
    3. Server accepts the connection.
    4. Vonage sends one text frame: a JSON ``websocket:connected`` envelope.
       We log metadata only (no PHI) and discard the frame.
    5. Vonage streams binary frames (16-bit PCM, 16 kHz mono).
       Each frame is forwarded to ``provider_stream.send_audio(chunk)``.
    6. Vonage sends occasional ``websocket:dtmf`` text events (keypad presses).
       Logged at DEBUG; otherwise ignored.
    7. Any other text frames are silently ignored.
    8. On disconnect: duration and frame count are logged at INFO.

HIPAA notes:
    - Audio bytes are NEVER logged at any level.
    - Per-frame sizes are NEVER logged at INFO or above.
    - Only connection metadata (session_id, frame count, duration) is logged.
    - No DB connection is opened — the JWT contains the session_id as a
      surrogate key with no clinical meaning.
    - Close code 4001 conveys auth failure without exposing PHI in close reason.

Design decisions:
    - We do NOT subscribe a fake WebSocket to the hub (this endpoint is a
      producer, not a consumer — it pushes audio IN, not transcript OUT).
    - ``get_or_create_provider_stream`` is idempotent; if a CHW device is also
      streaming audio for the same session, both sources land on the same
      AssemblyAI session, which is intentional for Phase 2 (single-mic path).
    - A single bad audio chunk must not kill the WebSocket — exceptions inside
      the forwarding path are caught, logged, and skipped.
"""

from __future__ import annotations

import json
import logging
import time
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.services.transcript_hub import StreamingSession, transcript_hub
from app.utils.security import verify_vonage_ws_token

logger = logging.getLogger("compass.transcript.vonage")

router = APIRouter(prefix="/api/v1/sessions", tags=["vonage-audio"])

# WebSocket close codes (application-defined range 4000-4999).
_WS_CLOSE_AUTH_FAILED: int = 4001

# Vonage event field present in every text envelope.
_VONAGE_EVENT_FIELD = "event"

# Known text-event types from Vonage Voice WebSocket protocol.
_VONAGE_EVENT_CONNECTED = "websocket:connected"
_VONAGE_EVENT_DTMF = "websocket:dtmf"


@router.websocket("/{session_id}/transcript/vonage-stream")
async def vonage_audio_stream(
    websocket: WebSocket,
    session_id: UUID,
    token: str | None = None,
) -> None:
    """Ingest Vonage Voice audio and forward it to the AssemblyAI transcript pipeline.

    Binary frames from Vonage (16-bit PCM, 16 kHz, mono) are forwarded to the
    session's provider stream via ``transcript_hub.get_or_create_provider_stream()``.

    Query params:
        token (str, required): A valid Vonage WS JWT signed by
            ``settings.vonage_ws_jwt_secret`` and bound to ``session_id``.

    Close codes:
        4001 — JWT missing, malformed, expired, wrong subject, or session_id
                mismatch between token claim and path parameter.
        1000/1001 — normal close (Vonage or server initiated).
    """
    # --- Step 1: validate JWT before accepting the handshake ---
    # ``verify_vonage_ws_token`` never raises; returns None on any failure.
    token_session_id: UUID | None = None

    if token:
        token_session_id = verify_vonage_ws_token(token)

    if token_session_id is None:
        logger.warning(
            "vonage WS rejected: missing or invalid token session=%s",
            session_id,
        )
        await websocket.close(code=_WS_CLOSE_AUTH_FAILED, reason="Auth failed")
        return

    # Confirm the token's embedded session_id matches the path parameter.
    # This prevents a token issued for session A from being replayed against
    # session B's audio stream.
    if token_session_id != session_id:
        logger.warning(
            "vonage WS rejected: token session_id=%s does not match path session_id=%s",
            token_session_id,
            session_id,
        )
        await websocket.close(code=_WS_CLOSE_AUTH_FAILED, reason="Auth failed")
        return

    # --- Step 2: accept the WebSocket handshake ---
    await websocket.accept()
    logger.info(
        "vonage WS connected session=%s",
        session_id,
    )

    # --- Step 3: read the mandatory websocket:connected envelope ---
    # Vonage always sends this as the first text frame after the handshake.
    # We consume it, log safe metadata, then proceed to the audio loop.
    try:
        connected_message = await websocket.receive()
    except WebSocketDisconnect:
        logger.info(
            "vonage WS disconnected before connected envelope session=%s",
            session_id,
        )
        return

    if connected_message.get("type") == "websocket.disconnect":
        logger.info(
            "vonage WS client disconnected before connected envelope session=%s",
            session_id,
        )
        return

    connected_text: str | None = connected_message.get("text")
    if connected_text:
        try:
            connected_envelope = json.loads(connected_text)
        except json.JSONDecodeError:
            connected_envelope = {}

        # Log only safe metadata fields — never raw PHI.
        safe_log_fields = {
            key: connected_envelope.get(key)
            for key in ("event", "content-type", "uuid")
            if key in connected_envelope
        }
        logger.info(
            "vonage WS connected envelope session=%s fields=%s",
            session_id,
            safe_log_fields,
        )

    # --- Step 4: lazy-init the provider stream ---
    # Idempotent — returns an existing session if one already exists for this
    # session_id (e.g., a CHW device is also streaming).
    provider_stream: StreamingSession = await transcript_hub.get_or_create_provider_stream(
        session_id
    )

    # --- Step 5: main audio receive loop ---
    frame_count: int = 0
    session_started_at: float = time.monotonic()

    try:
        while True:
            try:
                message = await websocket.receive()
            except WebSocketDisconnect:
                logger.info(
                    "vonage WS disconnected session=%s frames=%d duration_s=%.1f",
                    session_id,
                    frame_count,
                    time.monotonic() - session_started_at,
                )
                break

            message_type: str = message.get("type", "")

            # Detect Starlette's internal disconnect sentinel.
            if message_type == "websocket.disconnect":
                logger.info(
                    "vonage WS closed session=%s frames=%d duration_s=%.1f",
                    session_id,
                    frame_count,
                    time.monotonic() - session_started_at,
                )
                break

            # --- Binary frame path: PCM audio chunk → provider ---
            raw_bytes: bytes | None = message.get("bytes")
            if raw_bytes is not None:
                # HIPAA: do NOT log audio bytes or their length at INFO or above.
                # A single bad frame must not kill the WebSocket connection —
                # wrap in try/except and continue on failure.
                try:
                    await provider_stream.send_audio(raw_bytes)
                    frame_count += 1
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "vonage provider send_audio failed session=%s error_type=%s — skipping frame",
                        session_id,
                        type(exc).__name__,
                    )
                continue

            # --- Text frame path: Vonage metadata events ---
            raw_text: str | None = message.get("text")
            if raw_text is not None:
                try:
                    event_envelope = json.loads(raw_text)
                except json.JSONDecodeError:
                    # Non-JSON text frame — ignore silently.
                    continue

                event_name: str = event_envelope.get(_VONAGE_EVENT_FIELD, "")

                if event_name == _VONAGE_EVENT_DTMF:
                    # DTMF keypad events carry the pressed digit — potentially
                    # sensitive but not clinical PHI.  Log at DEBUG only.
                    logger.debug(
                        "vonage WS dtmf event received session=%s",
                        session_id,
                    )
                    continue

                # All other text events are ignored without error.
                # Vonage may send future event types; we must not crash on them.
                continue

    except Exception as exc:  # noqa: BLE001
        # Outer catch for truly unexpected failures (e.g., ASGI transport errors).
        # Log the type only — avoid logging message content that could be PHI.
        logger.error(
            "vonage WS unexpected error session=%s frames=%d error_type=%s",
            session_id,
            frame_count,
            type(exc).__name__,
        )
    finally:
        # Emit the final connection summary regardless of how the loop exits.
        # This is the canonical log line for Vonage WS session accounting.
        duration_s: float = time.monotonic() - session_started_at
        logger.info(
            "vonage WS closed session=%s frames=%d duration_s=%.1f",
            session_id,
            frame_count,
            duration_s,
        )
