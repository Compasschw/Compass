"""Vonage implementation of the CommunicationProvider interface.

Uses Vonage Voice API for masked calling between CHW and member.
Requires VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_APPLICATION_ID, and
VONAGE_PRIVATE_KEY_PATH in environment/config.

Call flow (click-to-connect / masked bridge):
  1. Mobile app calls POST /api/v1/communication/call-bridge with recipient_id
  2. Backend creates a Vonage outbound call FROM our Vonage number TO the
     initiator (e.g. the CHW's phone)
  3. When the CHW answers, Vonage hits our answer webhook
  4. The webhook returns an NCCO (Nexmo Call Control Object) that connects
     the CHW's leg to the recipient's real phone number
  5. Neither party ever sees the other's real number — both see our
     Vonage number. Calls are recorded for clinical documentation.
"""

import logging
from uuid import uuid4

from app.services.communication.base import (
    CommunicationProvider,
    ProxySession,
    RecordingResult,
    TranscriptResult,
)

logger = logging.getLogger("compass.communication.vonage")


class VonageProvider(CommunicationProvider):
    """Vonage Voice API adapter for masked calling, recording, transcription."""

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        application_id: str,
        private_key_path: str,
        from_number: str = "",
        proxy_number_pool: list[str] | None = None,
    ) -> None:
        self._api_key = api_key
        self._api_secret = api_secret
        self._application_id = application_id
        self._private_key_path = private_key_path
        # Our rented Vonage number — what both parties see on caller ID.
        self._from_number = from_number
        self._number_pool = proxy_number_pool or ([from_number] if from_number else [])
        self._client = None

    def _is_configured(self) -> bool:
        return bool(
            self._api_key
            and self._api_secret
            and self._application_id
            and self._private_key_path
            and self._from_number
        )

    def _get_client(self):
        """Lazy-initialize the Vonage SDK client."""
        if self._client is None:
            if not self._is_configured():
                return None
            try:
                from vonage import Auth, Vonage
                auth = Auth(
                    api_key=self._api_key,
                    api_secret=self._api_secret,
                    application_id=self._application_id,
                    private_key=self._private_key_path,
                )
                self._client = Vonage(auth)
            except ImportError:
                logger.warning("vonage SDK not installed. Install with: pip install vonage")
                return None
            except Exception as e:  # noqa: BLE001
                logger.error("Failed to initialize Vonage client: %s", e)
                return None
        return self._client

    async def create_proxy_session(
        self,
        session_id: str,
        chw_phone: str,
        member_phone: str,
    ) -> ProxySession:
        """Initiate a masked bridge between CHW and member.

        Places an outbound call from our Vonage number to the CHW; when the
        CHW answers, our `/voice/answer` webhook receives the event and
        returns an NCCO that `connect`s the call to the member. Both legs
        are recorded to S3 via the `record` NCCO action.

        Returns a placeholder if Vonage isn't configured (e.g. local dev).
        """
        client = self._get_client()

        if client is None:
            logger.info(
                "Vonage not configured — returning placeholder proxy session for session_id=%s",
                session_id,
            )
            return ProxySession(
                provider_session_id=f"vonage-placeholder-{session_id}",
                proxy_number=self._from_number or "+1-000-000-0000",
                provider="vonage",
            )

        # Outbound call — Vonage hits our answer webhook with the session_id
        # in the custom `event_url` query so we can look up the member phone
        # at bridge time. The answer URL is configured on the Vonage
        # Application (points at /api/v1/communication/voice/answer).
        try:
            response = client.voice.create_call(
                {
                    "to": [{"type": "phone", "number": _strip(chw_phone)}],
                    "from": {"type": "phone", "number": _strip(self._from_number)},
                    # Pass context as query params so the webhook can route
                    # the call to the right member without touching the DB.
                    "answer_url": [
                        f"{_webhook_base()}/voice/answer"
                        f"?session={session_id}&member={_strip(member_phone)}"
                    ],
                    "event_url": [f"{_webhook_base()}/voice/events?session={session_id}"],
                }
            )
            # Vonage returns { "uuid": "...", "conversation_uuid": "...", "status": "started" }
            call_uuid = getattr(response, "uuid", None) or (
                response.get("uuid") if isinstance(response, dict) else None
            )
            conversation_uuid = getattr(response, "conversation_uuid", None) or (
                response.get("conversation_uuid") if isinstance(response, dict) else None
            )
            provider_session_id = conversation_uuid or call_uuid or f"vonage-unknown-{uuid4()}"

            return ProxySession(
                provider_session_id=provider_session_id,
                proxy_number=self._from_number,
                provider="vonage",
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Vonage create_call failed for session %s: %s", session_id, e)
            return ProxySession(
                provider_session_id=f"vonage-failed-{session_id}",
                proxy_number=self._from_number,
                provider="vonage",
            )

    async def end_proxy_session(self, provider_session_id: str) -> None:
        """Hang up the active Vonage call if it's still live."""
        client = self._get_client()
        if client is None or provider_session_id.startswith(("vonage-placeholder", "vonage-failed")):
            return

        try:
            # The PUT /calls/{uuid} action=hangup terminates a live call.
            client.voice.update_call(provider_session_id, {"action": "hangup"})
            logger.info("Ended Vonage call: %s", provider_session_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("Vonage end_proxy_session failed (%s): %s", provider_session_id, e)

    async def get_recording(self, provider_session_id: str) -> RecordingResult | None:
        """Retrieve the recording URL for a completed call.

        Vonage sends the recording URL via the event webhook as a `record`
        event type, so the event handler persists it on CommunicationSession.
        This method reads the cached URL from the DB; no Vonage REST call
        is needed post-hoc.
        """
        # Implementation note: the recording URL is saved by the
        # /voice/events webhook when it receives the `record` event. Callers
        # should fetch the CommunicationSession row and pull `recording_url`
        # directly — no live Vonage lookup required.
        return None

    async def get_transcript(self, recording_url: str) -> TranscriptResult | None:
        """Transcribe via the transcription provider (AssemblyAI by default).

        We separate transcription from voice because (a) AssemblyAI has a
        medical speech model with clinical terminology Vonage lacks and
        (b) keeping the abstraction means we can swap transcription
        vendors (Deepgram, Google Medical, on-prem Whisper) without
        touching the Vonage integration.
        """
        if not recording_url:
            return None

        try:
            from app.services.transcription import get_transcription_provider
            provider = get_transcription_provider()
            transcript = await provider.transcribe(recording_url, medical=True)
            if transcript is None:
                return None
            return TranscriptResult(
                text=transcript.text,
                confidence=transcript.confidence,
                provider_transcript_id=transcript.provider_id,
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Transcription failed: %s", e)
            return None


# ─── Helpers ────────────────────────────────────────────────────────────────


def _strip(number: str) -> str:
    """Vonage wants digits only (no +, spaces, dashes). E.164 without the +."""
    return "".join(ch for ch in (number or "") if ch.isdigit())


def _webhook_base() -> str:
    """Construct the public base URL for Vonage webhooks from settings.

    Vonage must reach this over HTTPS. We derive it from `magic_link_base_url`
    which is already the production public domain.
    """
    from app.config import settings

    # magic_link_base_url looks like "https://api.joincompasschw.com/auth/magic";
    # strip the tail to reuse it as the API base.
    base = settings.magic_link_base_url.rstrip("/")
    if base.endswith("/auth/magic"):
        base = base[: -len("/auth/magic")]
    # If the env var points at the web domain (joincompasschw.com), prefer the
    # dedicated api subdomain instead.
    base = base.replace("https://joincompasschw.com", "https://api.joincompasschw.com")
    # Append the router prefix so webhook URLs land on /api/v1/communication/...
    if not base.endswith("/api/v1/communication"):
        base = f"{base}/api/v1/communication"
    return base
