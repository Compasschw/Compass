"""Payments provider factory."""

from app.services.payments.base import (
    AccountStatus,
    ConnectedAccount,
    OnboardingLink,
    PaymentsProvider,
    TransferRequest,
    TransferResult,
)

_provider_instance: PaymentsProvider | None = None


def get_payments_provider() -> PaymentsProvider:
    """Return the configured payments provider singleton."""
    global _provider_instance
    if _provider_instance is not None:
        return _provider_instance

    from app.config import settings

    provider_name = getattr(settings, "payments_provider", "stripe")

    if provider_name == "stripe":
        from app.services.payments.stripe_provider import StripeProvider
        _provider_instance = StripeProvider(
            secret_key=getattr(settings, "stripe_secret_key", ""),
            webhook_secret=getattr(settings, "stripe_webhook_secret", ""),
            platform_name=getattr(settings, "stripe_platform_name", "CompassCHW"),
        )
    else:
        raise ValueError(f"Unknown payments provider: {provider_name}")

    return _provider_instance


__all__ = [
    "AccountStatus",
    "ConnectedAccount",
    "OnboardingLink",
    "PaymentsProvider",
    "TransferRequest",
    "TransferResult",
    "get_payments_provider",
]
