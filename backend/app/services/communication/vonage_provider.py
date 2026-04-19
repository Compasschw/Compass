"""Vonage implementation of the CommunicationProvider interface.

Uses Vonage Voice API for masked calling, recording, and transcription.
Requires VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_APPLICATION_ID, and
VONAGE_PRIVATE_KEY_PATH in environment/config.

Swap this file for twilio_provider.py or plivo_provider.py to change providers.
"""

import logging

from app.services.communication.base import (
    CommunicationProvider,
    ProxySession,
    RecordingResult,
    TranscriptResult,
)

logger = logging.getLogger("compass.communication.vonage")


class VonageProvider(CommunicationProvider):
    """Vonage Voice API adapter for masked calling + recording + transcription.

    Production implementation requires the `vonage` Python SDK:
        pip install vonage

    The methods below are structured for the Vonage API but return
    placeholder responses until credentials are configured. This allows
    the rest of the application to be built and tested against the interface.
    """

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        application_id: str,
        private_key_path: str,
        proxy_number_pool: list[str] | None = None,
    ) -> None:
        self._api_key = api_key
        self._api_secret = api_secret
        self._application_id = application_id
        self._private_key_path = private_key_path
        self._number_pool = proxy_number_pool or []
        self._client = None

    def _get_client(self):
        """Lazy-initialize the Vonage client."""
        if self._client is None:
            try:
                import vonage
                self._client = vonage.Client(
                    key=self._api_key,
                    secret=self._api_secret,
                    application_id=self._application_id,
                    private_key=self._private_key_path,
                )
            except ImportError:
                logger.warning("vonage SDK not installed. Install with: pip install vonage")
                return None
            except Exception as e:
                logger.error("Failed to initialize Vonage client: %s", e)
                return None
        return self._client

    async def create_proxy_session(
        self,
        session_id: str,
        chw_phone: str,
        member_phone: str,
    ) -> ProxySession:
        """Create a Vonage voice proxy session with a masked number.

        In production, this would:
        1. Select an available number from the pool
        2. Create a Vonage Connect session linking both parties
        3. Return the proxy number for both parties to call

        For now, returns a placeholder to allow end-to-end testing of the session flow.
        """
        client = self._get_client()

        if client is None:
            logger.info(
                "Vonage not configured — returning placeholder proxy session for session_id=%s",
                session_id,
            )
            return ProxySession(
                provider_session_id=f"vonage-placeholder-{session_id}",
                proxy_number="+1-000-000-0000",
                provider="vonage",
            )

        # TODO: Implement Vonage Private Voice Communication API
        # See: https://developer.vonage.com/en/voice/voice-api/guides/masked-calling
        #
        # Steps:
        # 1. Pick a number from self._number_pool
        # 2. Create a conversation via Vonage Conversations API
        # 3. Add both participants with their real numbers
        # 4. Configure NCCO (Nexmo Call Control Object) for call routing
        # 5. Enable recording on the conversation
        #
        # proxy_number = self._number_pool.pop(0)
        # conversation = client.create_conversation(name=f"compass-{session_id}")
        # ... configure routing ...
        # return ProxySession(
        #     provider_session_id=conversation.id,
        #     proxy_number=proxy_number,
        #     provider="vonage",
        # )

        return ProxySession(
            provider_session_id=f"vonage-placeholder-{session_id}",
            proxy_number="+1-000-000-0000",
            provider="vonage",
        )

    async def end_proxy_session(self, provider_session_id: str) -> None:
        """End the Vonage proxy session and release the number back to the pool."""
        client = self._get_client()

        if client is None or provider_session_id.startswith("vonage-placeholder"):
            logger.info("Skipping proxy session cleanup for %s", provider_session_id)
            return

        # TODO: Implement Vonage session cleanup
        # 1. End the conversation
        # 2. Return the proxy number to self._number_pool
        logger.info("Ended Vonage proxy session: %s", provider_session_id)

    async def get_recording(self, provider_session_id: str) -> RecordingResult | None:
        """Retrieve the call recording from Vonage."""
        client = self._get_client()

        if client is None or provider_session_id.startswith("vonage-placeholder"):
            return None

        # TODO: Implement Vonage recording retrieval
        # recording = client.get_recording(conversation_id=provider_session_id)
        # return RecordingResult(
        #     recording_url=recording.url,
        #     duration_seconds=recording.duration,
        #     provider_recording_id=recording.id,
        # )
        return None

    async def get_transcript(self, recording_url: str) -> TranscriptResult | None:
        """Transcribe a recording.

        Routes through the transcription provider (AssemblyAI by default) for
        medical-grade accuracy + HIPAA BAA coverage. The Vonage-built-in
        transcription is available but lacks medical terminology and we'd
        need a separate BAA with Vonage for it.

        Separating this into the TranscriptionProvider abstraction means
        we can switch to Deepgram, Google Medical, or on-prem Whisper
        without touching the Vonage integration.
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
