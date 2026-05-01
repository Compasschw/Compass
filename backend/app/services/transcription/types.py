"""Pydantic v2 types for the transcription service.

All types are PHI-adjacent — never log instances directly.
Import from here rather than from provider-specific modules.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class OwnerEnum(str, Enum):
    """Who owns an action item from a CHW session."""

    CHW = "chw"
    MEMBER = "member"
    BOTH = "both"


class PriorityEnum(str, Enum):
    """Priority level for a follow-up task."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class ResourceTypeEnum(str, Enum):
    """Type of resource referred during a session."""

    PROGRAM = "program"
    PROVIDER = "provider"
    DOCUMENT = "document"


class VerticalEnum(str, Enum):
    """SDOH vertical for a follow-up task."""

    HOUSING = "housing"
    FOOD = "food"
    TRANSPORTATION = "transportation"
    EMPLOYMENT = "employment"
    EDUCATION = "education"
    MENTAL_HEALTH = "mental_health"
    SUBSTANCE_USE = "substance_use"
    UTILITIES = "utilities"
    LEGAL = "legal"
    CHILDCARE = "childcare"
    OTHER = "other"


# ---------------------------------------------------------------------------
# Streaming session handle
# ---------------------------------------------------------------------------


class StreamingSession(BaseModel):
    """Opaque handle returned by start_streaming_session.

    Providers populate `provider_handle` with whatever internal object they
    need (e.g., an AssemblyAI RealtimeTranscriber instance). Callers treat
    this as an opaque token — they pass it to send_audio_chunk and
    end_streaming_session without inspecting internals.

    `session_id` is the Compass session UUID so correlation logs can map
    streaming handles back to visits without exposing transcript content.
    """

    session_id: UUID
    language: str = "en"
    started_at: datetime = Field(default_factory=datetime.utcnow)
    # Providers store their SDK handle here; excluded from serialisation.
    provider_handle: object | None = Field(default=None, exclude=True)

    model_config = {"arbitrary_types_allowed": True}


# ---------------------------------------------------------------------------
# Transcript building blocks
# ---------------------------------------------------------------------------


class SpeakerLabel(str, Enum):
    """Well-known speaker roles in a CHW session.

    The provider's diarization returns raw labels (A/B/...). The layer above
    this service maps them to CHW/MEMBER based on session metadata. Down here
    we keep it raw to avoid coupling.
    """

    A = "A"
    B = "B"
    C = "C"
    D = "D"
    UNKNOWN = "UNKNOWN"

    @classmethod
    def _missing_(cls, value: object) -> SpeakerLabel:
        """Accept arbitrary diarization labels gracefully."""
        return cls.UNKNOWN


class TranscriptChunk(BaseModel):
    """A single diarised utterance returned by the provider.

    `speaker` is the raw diarization label from the provider (e.g., "A").
    `confidence` is per-utterance when available, else falls back to the
    overall transcript confidence.
    """

    speaker: str = Field(description="Raw diarization label from the provider.")
    text: str = Field(description="Utterance text. Never log this field.")
    start_ms: int = Field(ge=0, description="Utterance start offset in milliseconds.")
    end_ms: int = Field(ge=0, description="Utterance end offset in milliseconds.")
    confidence: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Per-utterance confidence score, 0–1.",
    )
    is_partial: bool = Field(
        default=False,
        description="True for streaming partial results; False for finals.",
    )


class TranscriptionResult(BaseModel):
    """Aggregated output of a completed transcription job.

    `full_text` and `chunks` are PHI — handle under HIPAA safeguards.
    Only `provider_transcript_id` is safe for logging.
    """

    provider_transcript_id: str | None = Field(
        default=None,
        description="Provider-assigned ID. Safe to log for correlation.",
    )
    language: str = Field(default="en")
    confidence: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Overall confidence score across the full transcript.",
    )
    full_text: str = Field(
        default="",
        description="Complete transcript text. PHI — never log.",
    )
    chunks: list[TranscriptChunk] = Field(
        default_factory=list,
        description="Diarised utterances in chronological order.",
    )
    duration_ms: int | None = Field(
        default=None,
        ge=0,
        description="Total audio duration in milliseconds.",
    )
    medical_entities: list[dict] = Field(
        default_factory=list,
        description="Medical entities detected by the provider. PHI — never log.",
    )
    is_partial: bool = Field(
        default=False,
        description="True when this result comes from a streaming session mid-flight.",
    )


# ---------------------------------------------------------------------------
# LeMUR / follow-up extraction
# ---------------------------------------------------------------------------


class ActionItem(BaseModel):
    """A concrete action arising from the session."""

    description: str
    owner: OwnerEnum = OwnerEnum.BOTH
    due_date: str | None = Field(
        default=None,
        description="ISO 8601 date string or null.",
    )


class FollowUpTask(BaseModel):
    """A structured follow-up task referencing an SDOH vertical."""

    title: str
    vertical: VerticalEnum = VerticalEnum.OTHER
    priority: PriorityEnum = PriorityEnum.MEDIUM


class ResourceReferred(BaseModel):
    """A program, provider, or document referenced during the session."""

    name: str
    type: ResourceTypeEnum = ResourceTypeEnum.PROGRAM


class ExtractedFollowups(BaseModel):
    """Structured output from LeMUR follow-up extraction.

    On LLM failure or JSON parse error the provider returns an instance with
    all lists empty and `extraction_failed=True` so callers can distinguish
    "no follow-ups found" from "extraction did not run".
    """

    action_items: list[ActionItem] = Field(default_factory=list)
    follow_up_tasks: list[FollowUpTask] = Field(default_factory=list)
    resources_referred: list[ResourceReferred] = Field(default_factory=list)
    member_goals_stated: list[str] = Field(default_factory=list)
    extraction_failed: bool = Field(
        default=False,
        description="True when the LLM call failed or returned unparseable output.",
    )
    failure_reason: str | None = Field(
        default=None,
        description="Human-readable reason for extraction failure. Safe to log.",
    )

    @classmethod
    def degraded(cls, reason: str) -> ExtractedFollowups:
        """Return a safe empty instance for use when extraction fails."""
        return cls(extraction_failed=True, failure_reason=reason)
