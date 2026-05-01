"""Provider-agnostic transcription interface.

Any transcription provider (AssemblyAI, Deepgram, Whisper, etc.) must
implement TranscriptionProvider. The rest of the application imports only
from this module and types.py — never from a specific provider file.

To add a new provider:
1. Create <provider>_provider.py and subclass TranscriptionProvider.
2. Update get_transcription_provider() in __init__.py.
3. Add necessary config keys to app/config.py.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from uuid import UUID

from app.services.transcription.types import (
    ExtractedFollowups,
    StreamingSession,
    TranscriptionResult,
)

# Re-export legacy Phase-1 names so existing imports don't break during migration.
# TODO: Remove once all callers are updated to use TranscriptionResult + TranscriptChunk.
# noqa: F401 — these aliases are intentional re-exports; ruff sees them as unused
# in this file, but downstream callers import them from here.
from app.services.transcription.types import TranscriptChunk as TranscriptSegment  # noqa: F401
from app.services.transcription.types import TranscriptionResult as Transcript  # noqa: F401


class TranscriptionProvider(ABC):
    """Abstract interface for all transcription providers.

    Design constraints:
    - All methods are async — providers make network I/O.
    - No business logic here — pure I/O adapters only.
    - Never log audio bytes, transcript text, or member names.
      Log only provider IDs, session UUIDs, and status codes.
    - Providers must degrade gracefully: prefer returning a result with
      empty/partial data over raising, except for programming errors
      (missing config, bad argument types).
    """

    @abstractmethod
    async def start_streaming_session(
        self,
        session_id: UUID,
        language: str = "en",
    ) -> StreamingSession:
        """Open a streaming WebSocket to the provider.

        Returns a StreamingSession handle for use with send_audio_chunk
        and end_streaming_session. The handle is provider-opaque to callers.

        Args:
            session_id: Compass session UUID for correlation logging.
            language: BCP-47 language code, e.g. "en", "es".

        Returns:
            A StreamingSession whose provider_handle is populated by the
            provider implementation.

        Raises:
            RuntimeError: If the provider API key is missing or the WebSocket
                          connection cannot be established.
        """

    @abstractmethod
    async def send_audio_chunk(
        self,
        stream: StreamingSession,
        pcm_chunk: bytes,
    ) -> None:
        """Forward a 16-bit PCM audio chunk to the provider stream.

        Audio format contract:
            - Encoding:    16-bit signed PCM, little-endian
            - Sample rate: 16 000 Hz
            - Channels:    1 (mono)

        Args:
            stream:    The StreamingSession returned by start_streaming_session.
            pcm_chunk: Raw PCM bytes — never log the content of this argument.

        Raises:
            RuntimeError: If the streaming session is not open or the provider
                          WebSocket has disconnected.
        """

    @abstractmethod
    async def end_streaming_session(
        self,
        stream: StreamingSession,
    ) -> TranscriptionResult:
        """Close the streaming session and return the final aggregated transcript.

        The provider should flush any buffered audio, wait for the final
        transcript from the server, then close the WebSocket cleanly.

        Args:
            stream: The StreamingSession to terminate.

        Returns:
            A TranscriptionResult with is_partial=False. On provider error,
            returns a result with empty full_text rather than raising.
        """

    @abstractmethod
    async def transcribe_async(
        self,
        audio_url: str,
        language: str = "en",
        medical_model: bool = True,
    ) -> TranscriptionResult:
        """Submit a post-call audio URL for async transcription.

        The method submits the job to the provider, polls until completion,
        and returns the full result. Suitable for recordings already stored
        in S3 (pre-signed URLs or public objects).

        Args:
            audio_url:     Accessible URL to the audio file (S3 pre-signed,
                           public, or provider-uploadable).
            language:      BCP-47 language code.
            medical_model: When True, use the provider's medical-terminology
                           model (AssemblyAI Conformer-2). Incurs add-on cost.

        Returns:
            TranscriptionResult with full_text, diarised chunks, and any
            detected medical entities. On timeout or error, returns a result
            with an empty full_text and the provider_transcript_id set if
            available (for later manual retrieval).
        """

    @abstractmethod
    async def extract_followups(
        self,
        transcript: str,
        member_name: str | None = None,
    ) -> ExtractedFollowups:
        """Run LeMUR (or equivalent LLM) to extract structured follow-ups.

        Parses the transcript for:
        - action_items: concrete next steps with owner and optional due date
        - follow_up_tasks: SDOH-vertical tasks with priority
        - resources_referred: programs, providers, or documents mentioned
        - member_goals_stated: member's self-expressed goals

        On any LLM or parsing failure the provider MUST return
        ExtractedFollowups.degraded(reason) — never raise.

        Args:
            transcript:  Full transcript text. PHI — never log.
            member_name: Optional first name for personalising the prompt.
                         PHI — never log.

        Returns:
            ExtractedFollowups. Check extraction_failed for partial results.
        """

    # ------------------------------------------------------------------
    # Legacy Phase-1 compatibility shim
    # ------------------------------------------------------------------

    async def transcribe(
        self,
        audio_url: str,
        *,
        medical: bool = True,
    ) -> TranscriptionResult | None:
        """Thin compatibility wrapper over transcribe_async.

        Deprecated: use transcribe_async directly. Will be removed once all
        callers migrate to the Phase-2 interface.
        """
        result = await self.transcribe_async(
            audio_url=audio_url,
            medical_model=medical,
        )
        # Return None on empty transcript to preserve Phase-1 contract.
        if not result.full_text and not result.provider_transcript_id:
            return None
        return result
