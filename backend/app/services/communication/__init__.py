"""Communication provider factory.

To switch providers, change COMMUNICATION_PROVIDER in config/env
and the factory will instantiate the correct adapter. No other code changes needed.
"""

from app.services.communication.base import (
    CommunicationProvider,
    ProxySession,
    RecordingResult,
    TranscriptResult,
)

_provider_instance: CommunicationProvider | None = None


def get_provider() -> CommunicationProvider:
    """Return the configured communication provider singleton.

    Currently defaults to Vonage. To switch:
    1. Set COMMUNICATION_PROVIDER=twilio (or plivo) in env
    2. Create the corresponding provider file
    3. Add the elif branch below
    """
    global _provider_instance
    if _provider_instance is not None:
        return _provider_instance

    from app.config import settings

    provider_name = getattr(settings, "communication_provider", "vonage")

    if provider_name == "vonage":
        from app.services.communication.vonage_provider import VonageProvider
        _provider_instance = VonageProvider(
            api_key=getattr(settings, "vonage_api_key", ""),
            api_secret=getattr(settings, "vonage_api_secret", ""),
            application_id=getattr(settings, "vonage_application_id", ""),
            private_key_path=getattr(settings, "vonage_private_key_path", ""),
            from_number=getattr(settings, "vonage_from_number", ""),
        )
    # elif provider_name == "twilio":
    #     from app.services.communication.twilio_provider import TwilioProvider
    #     _provider_instance = TwilioProvider(...)
    # elif provider_name == "plivo":
    #     from app.services.communication.plivo_provider import PlivoProvider
    #     _provider_instance = PlivoProvider(...)
    else:
        raise ValueError(f"Unknown communication provider: {provider_name}")

    return _provider_instance


__all__ = [
    "CommunicationProvider",
    "ProxySession",
    "RecordingResult",
    "TranscriptResult",
    "get_provider",
]
