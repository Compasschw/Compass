"""Provider-agnostic interface for session communication (masked calling, recording, transcription).

Any communication provider (Vonage, Twilio, Plivo) must implement this interface.
The rest of the application imports only from this module — never from a specific provider.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class ProxySession:
    """Result of creating a masked communication session."""
    provider_session_id: str
    proxy_number: str
    provider: str


@dataclass
class RecordingResult:
    """Result of retrieving a call recording."""
    recording_url: str
    duration_seconds: int
    provider_recording_id: str


@dataclass
class TranscriptResult:
    """Result of transcribing a recording."""
    text: str
    confidence: float
    provider_transcript_id: str | None = None


class CommunicationProvider(ABC):
    """Abstract interface for communication providers.

    To add a new provider:
    1. Create a new file (e.g., twilio_provider.py)
    2. Implement this interface
    3. Update get_provider() in __init__.py
    """

    @abstractmethod
    async def create_proxy_session(
        self,
        session_id: str,
        chw_phone: str,
        member_phone: str,
    ) -> ProxySession:
        """Create a masked calling session. Both parties get a proxy number
        that routes to the other without exposing real numbers."""

    @abstractmethod
    async def end_proxy_session(self, provider_session_id: str) -> None:
        """Close the proxy session and release the masked number."""

    @abstractmethod
    async def get_recording(self, provider_session_id: str) -> RecordingResult | None:
        """Retrieve the call recording for a session. Returns None if no recording exists."""

    @abstractmethod
    async def get_transcript(self, recording_url: str) -> TranscriptResult | None:
        """Transcribe a recording. Returns None if transcription fails or is unavailable."""
