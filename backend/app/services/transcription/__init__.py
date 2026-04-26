"""Transcription provider factory.

To switch providers, change TRANSCRIPTION_PROVIDER in config / env.
No other code changes required — the factory wires the correct adapter.
"""

from app.services.transcription.base import TranscriptionProvider
from app.services.transcription.types import (
    ActionItem,
    ExtractedFollowups,
    FollowUpTask,
    OwnerEnum,
    PriorityEnum,
    ResourceReferred,
    ResourceTypeEnum,
    StreamingSession,
    TranscriptChunk,
    TranscriptionResult,
    VerticalEnum,
)

# Legacy Phase-1 re-exports — remove once all callers migrate.
from app.services.transcription.base import Transcript, TranscriptSegment

_provider_instance: TranscriptionProvider | None = None


def get_transcription_provider() -> TranscriptionProvider:
    """Return the configured transcription provider singleton.

    The instance is cached after the first call. To force re-initialisation
    (e.g., in tests) set _provider_instance = None before calling.

    Raises:
        ValueError: If ASSEMBLYAI_API_KEY is not set when the assemblyai
                    provider is selected, or if the provider name is unknown.
    """
    global _provider_instance
    if _provider_instance is not None:
        return _provider_instance

    from app.config import settings  # lazy import to avoid circular deps

    provider_name: str = getattr(settings, "transcription_provider", "assemblyai")

    if provider_name == "assemblyai":
        api_key: str = getattr(settings, "assemblyai_api_key", "")
        if not api_key:
            raise ValueError(
                "ASSEMBLYAI_API_KEY is not set. "
                "Configure it in .env before enabling the assemblyai transcription provider."
            )
        from app.services.transcription.assemblyai_provider import AssemblyAIProvider

        _provider_instance = AssemblyAIProvider(
            api_key=api_key,
            lemur_model=getattr(settings, "assemblyai_lemur_model", "default"),
            environment=getattr(settings, "environment", "development"),
        )
    else:
        raise ValueError(
            f"Unknown transcription provider: {provider_name!r}. "
            "Supported values: 'assemblyai'."
        )

    return _provider_instance


__all__ = [
    # Factory
    "get_transcription_provider",
    # Base interface
    "TranscriptionProvider",
    # Types
    "ActionItem",
    "ExtractedFollowups",
    "FollowUpTask",
    "OwnerEnum",
    "PriorityEnum",
    "ResourceReferred",
    "ResourceTypeEnum",
    "StreamingSession",
    "TranscriptChunk",
    "TranscriptionResult",
    "VerticalEnum",
    # Legacy Phase-1 re-exports
    "Transcript",
    "TranscriptSegment",
]
