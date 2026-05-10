"""WebSocket endpoint for Vonage Voice per-leg audio ingestion.

Endpoint: WS /api/v1/sessions/{session_id}/transcript/vonage-stream?token=<jwt>

Purpose:
    Vonage Voice calls each participant (CHW and member) on separate phone legs.
    When the call is answered, each leg's NCCO instructs Vonage to forward raw
    audio via a dedicated WebSocket to this endpoint.  The token's embedded
    ``role`` claim ("chw" | "member") determines which role-keyed AssemblyAI
    streaming session receives the audio frames, giving true per-leg isolation:
    - CHW leg  → role="chw"  → transcript_hub.get_or_create_provider_stream(session_id, "chw")
    - Member leg → role="member" → transcript_hub.get_or_create_provider_stream(session_id, "member")

    This replaces the previous single-stream approach where both legs' audio
    was mixed in a single WebSocket fork.

Authentication:
    Short-lived HS256 JWT issued by the NCCO consent-result webhook (via
    ``create_vonage_ws_token(session_id, role=...)``) and presented by Vonage
    as ``?token=<jwt>`` because Vonage's WebSocket client cannot set custom HTTP
    headers on the initial upgrade request.  The token is validated (signature
    + exp + sub == "vonage" + known role) before the WebSocket handshake is
    accepted.  The ``role`` is read exclusively from the verified token — NOT
    from any query parameter — so it cannot be tampered with by an attacker who
    captures and replays a token.

Connection lifecycle:
    1. Vonage opens WS with ``?token=<jwt>``.
    2. Server validates token; closes with 4001 on any failure.
    3. Server extracts ``session_id`` and ``role`` from the verified token.
    4. Server confirms token's session_id matches the path parameter (anti-replay).
    5. Server accepts the WebSocket handshake.
    6. Vonage sends one text frame: a JSON ``websocket:connected`` envelope.
       We log safe metadata only (no PHI) and discard the frame.
    7. Vonage streams binary frames (16-bit PCM, 16 kHz mono).
       Each frame is forwarded to the role-specific provider stream.
    8. Vonage sends occasional ``websocket:dtmf`` text events (keypad presses).
       Logged at DEBUG; otherwise ignored.
    9. Any other text frames are silently ignored.
    10. On disconnect: duration and frame count are logged at INFO.

HIPAA notes:
    - Audio bytes are NEVER logged at any level.
    - Per-frame sizes are NEVER logged at INFO or above.
    - Only connection metadata (session_id, role, frame count, duration) is
      logged.  ``role`` is not PHI — it is an operational signal ("chw" or
      "member").
    - No DB connection is opened — the JWT contains the session_id and role as
      surrogate keys with no standalone clinical meaning.
    - Close code 4001 conveys auth failure without exposing PHI in close reason.

Design decisions:
    - Role is extracted from the cryptographically-bound JWT claim, never from a
      query parameter, to prevent role-spoofing by an attacker who captures one
      leg's token and presents it against the other leg's stream path.
    - ``get_or_create_provider_stream(session_id, role)`` is idempotent per role;
      re-connecting the CHW or member leg returns the existing stream.
    - A single bad audio chunk must not kill the WebSocket — exceptions inside
      the forwarding path are caught, logged at WARNING, and skipped.
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
    """Ingest per-leg Vonage Voice audio and forward it to the role-keyed transcript pipeline.

    Each call leg (CHW and member) connects to this endpoint independently with
    its own token.  The token's ``role`` claim ("chw" | "member") is extracted
    after signature verification and used to route audio frames to the correct
    AssemblyAI streaming session, giving true per-leg audio isolation.

    Binary frames from Vonage (16-bit PCM, 16 kHz, mono) are forwarded to the
    role-keyed provider stream via
    ``transcript_hub.get_or_create_provider_stream(session_id, role)``.

    Query params:
        token (str, required): A valid Vonage WS JWT signed by
            ``settings.vonage_ws_jwt_secret`` and bound to both ``session_id``
            and ``role``.  The role is read from the token, never from any
            additional query parameter.

    Close codes:
        4001 — JWT missing, malformed, expired, wrong subject, unknown role, or
                session_id mismatch between token claim and path parameter.
        1000/1001 — normal close (Vonage or server initiated).
    """
    # --- Step 1: validate JWT before accepting the handshake ---
    # ``verify_vonage_ws_token`` never raises; returns None on any failure.
    # On success it returns (session_id_from_token, role).
    token_claims: tuple[UUID, str] | None = None

    if token:
        token_claims = verify_vonage_ws_token(token)

    if token_claims is None:
        logger.warning(
            "vonage WS rejected: missing or invalid token session=%s",
            session_id,
        )
        await websocket.close(code=_WS_CLOSE_AUTH_FAILED, reason="Auth failed")
        return

    token_session_id, speaker_role = token_claims

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
        "vonage WS connected session=%s role=%s",
        session_id,
        speaker_role,
    )

    # --- Step 3: read the mandatory websocket:connected envelope ---
    # Vonage always sends this as the first text frame after the handshake.
    # We consume it, log safe metadata, then proceed to the audio loop.
    try:
        connected_message = await websocket.receive()
    except WebSocketDisconnect:
        logger.info(
            "vonage WS disconnected before connected envelope session=%s role=%s",
            session_id,
            speaker_role,
        )
        return

    if connected_message.get("type") == "websocket.disconnect":
        logger.info(
            "vonage WS client disconnected before connected envelope session=%s role=%s",
            session_id,
            speaker_role,
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
            "vonage WS connected envelope session=%s role=%s fields=%s",
            session_id,
            speaker_role,
            safe_log_fields,
        )

    # --- Step 4: lazy-init the role-keyed provider stream ---
    # Routes to a role-specific AssemblyAI streaming session.  The dual-stream
    # backend (parallel agent) exposes get_or_create_provider_stream(session_id, role)
    # so each role has its own independent stream with authoritative speaker_role
    # tagging.  This call is idempotent — re-connecting the same role returns the
    # existing stream.
    provider_stream: StreamingSession = await transcript_hub.get_or_create_provider_stream(
        session_id, speaker_role
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
                    "vonage WS disconnected session=%s role=%s frames=%d duration_s=%.1f",
                    session_id,
                    speaker_role,
                    frame_count,
                    time.monotonic() - session_started_at,
                )
                break

            message_type: str = message.get("type", "")

            # Detect Starlette's internal disconnect sentinel.
            if message_type == "websocket.disconnect":
                logger.info(
                    "vonage WS closed session=%s role=%s frames=%d duration_s=%.1f",
                    session_id,
                    speaker_role,
                    frame_count,
                    time.monotonic() - session_started_at,
                )
                break

            # --- Binary frame path: PCM audio chunk → role-keyed provider ---
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
                        "vonage provider send_audio failed session=%s role=%s error_type=%s — skipping frame",
                        session_id,
                        speaker_role,
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
                        "vonage WS dtmf event received session=%s role=%s",
                        session_id,
                        speaker_role,
                    )
                    continue

                # All other text events are ignored without error.
                # Vonage may send future event types; we must not crash on them.
                continue

    except Exception as exc:  # noqa: BLE001
        # Outer catch for truly unexpected failures (e.g., ASGI transport errors).
        # Log the type only — avoid logging message content that could be PHI.
        logger.error(
            "vonage WS unexpected error session=%s role=%s frames=%d error_type=%s",
            session_id,
            speaker_role,
            frame_count,
            type(exc).__name__,
        )
    finally:
        # Emit the final connection summary regardless of how the loop exits.
        # This is the canonical log line for Vonage WS session accounting.
        duration_s: float = time.monotonic() - session_started_at
        logger.info(
            "vonage WS closed session=%s role=%s frames=%d duration_s=%.1f",
            session_id,
            speaker_role,
            frame_count,
            duration_s,
        )
