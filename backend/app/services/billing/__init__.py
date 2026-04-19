"""Billing provider factory.

To switch providers, change BILLING_PROVIDER in config/env
and the factory will instantiate the correct adapter. No other code changes needed.
"""

from app.services.billing.base import (
    BillingProvider,
    ClaimResult,
    ClaimSubmission,
    EligibilityResult,
)

_provider_instance: BillingProvider | None = None


def get_billing_provider() -> BillingProvider:
    """Return the configured billing provider singleton."""
    global _provider_instance
    if _provider_instance is not None:
        return _provider_instance

    from app.config import settings

    provider_name = getattr(settings, "billing_provider", "pear_suite")

    if provider_name == "pear_suite":
        from app.services.billing.pear_suite_provider import PearSuiteProvider
        _provider_instance = PearSuiteProvider(
            api_key=getattr(settings, "pear_suite_api_key", ""),
            base_url=getattr(settings, "pear_suite_base_url", "https://api.pearsuite.com"),
        )
    else:
        raise ValueError(f"Unknown billing provider: {provider_name}")

    return _provider_instance


__all__ = [
    "BillingProvider",
    "ClaimResult",
    "ClaimSubmission",
    "EligibilityResult",
    "get_billing_provider",
]
