"""Provider-agnostic transactional email interface."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class EmailMessage:
    to: str
    subject: str
    html: str
    text: str
    # Optional — useful for tracking deliverability in the provider dashboard
    tags: dict[str, str] = field(default_factory=dict)


@dataclass
class EmailResult:
    success: bool
    provider_message_id: str | None = None
    error: str | None = None


class EmailProvider(ABC):
    """Abstract interface for transactional email providers."""

    @abstractmethod
    async def send(self, message: EmailMessage) -> EmailResult:
        """Deliver `message`. Should return without raising on delivery failure —
        callers check `result.success` to decide whether to retry."""


class NoopEmailProvider(EmailProvider):
    """Test/CI-only provider that logs and returns success without making any
    network call.

    Selected via ``settings.email_provider == "noop"`` — set by
    ``tests/conftest.py`` (``EMAIL_PROVIDER=noop``, mirroring the existing
    ``DISABLE_RATE_LIMIT`` test-env pattern) so the test suite's many
    ``/auth/register`` / ``/chw/members`` calls don't each fire a real
    outbound AWS SES API call (cost, latency, and SES-quota/abuse-detection
    risk on a BAA-covered production account). Never selected by default —
    ``Settings.email_provider`` defaults to ``"ses"`` in ``app/config.py``,
    so production and any environment that doesn't explicitly opt in keeps
    sending real email.
    """

    async def send(self, message: EmailMessage) -> EmailResult:
        import logging

        logging.getLogger("compass.email.noop").info(
            "noop email provider — not sending to=%s subject=%r",
            message.to, message.subject,
        )
        return EmailResult(success=True, provider_message_id="noop-placeholder")
