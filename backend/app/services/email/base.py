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
