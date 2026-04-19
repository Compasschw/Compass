"""Provider-agnostic transcription interface."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class TranscriptSegment:
    """A single utterance with speaker + timing."""
    speaker: str  # e.g., "A" / "B" — from diarization
    text: str
    start_ms: int
    end_ms: int


@dataclass
class Transcript:
    text: str
    confidence: float
    language: str = "en"
    segments: list[TranscriptSegment] = field(default_factory=list)
    provider_id: str | None = None
    medical_entities: list[dict] = field(default_factory=list)


class TranscriptionProvider(ABC):
    """Abstract interface for transcribing call recordings."""

    @abstractmethod
    async def transcribe(self, audio_url: str, *, medical: bool = True) -> Transcript | None:
        """Transcribe the audio at `audio_url`.

        When `medical=True`, the provider should apply its medical-terminology
        model (if available). Returns None if transcription fails.
        """
