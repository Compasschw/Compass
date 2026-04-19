"""Transcription provider factory."""

from app.services.transcription.base import (
    Transcript,
    TranscriptionProvider,
    TranscriptSegment,
)

_provider_instance: TranscriptionProvider | None = None


def get_transcription_provider() -> TranscriptionProvider:
    """Return the configured transcription provider singleton."""
    global _provider_instance
    if _provider_instance is not None:
        return _provider_instance

    from app.config import settings

    provider_name = getattr(settings, "transcription_provider", "assemblyai")

    if provider_name == "assemblyai":
        from app.services.transcription.assemblyai_provider import AssemblyAIProvider
        _provider_instance = AssemblyAIProvider(
            api_key=getattr(settings, "assemblyai_api_key", ""),
        )
    else:
        raise ValueError(f"Unknown transcription provider: {provider_name}")

    return _provider_instance


__all__ = [
    "Transcript",
    "TranscriptionProvider",
    "TranscriptSegment",
    "get_transcription_provider",
]
