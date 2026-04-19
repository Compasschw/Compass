"""Provider-agnostic interface for push notifications.

Any notification provider (Expo, direct APNs, direct FCM) must implement
this interface. The rest of the application imports only from this module.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from uuid import UUID


@dataclass
class NotificationPayload:
    """A single notification to deliver to one or more devices."""
    user_id: UUID
    title: str
    body: str
    # Client-side routing hints — the app uses `deeplink` to navigate when the
    # notification is tapped. Example: "compasschw://sessions/<id>"
    deeplink: str | None = None
    # Arbitrary structured data the client can use; kept small (APNs has a 4KB cap)
    data: dict = field(default_factory=dict)
    # Category identifies the notification type — used for iOS notification grouping
    # and for analytics. Examples: "request.accepted", "message.new", "session.reminder"
    category: str = "default"


@dataclass
class NotificationResult:
    """Outcome of sending one notification batch."""
    sent: int = 0
    failed: int = 0
    invalid_tokens: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class NotificationProvider(ABC):
    """Abstract interface for push notification providers."""

    @abstractmethod
    async def send(self, payload: NotificationPayload, tokens: list[str]) -> NotificationResult:
        """Send `payload` to all device tokens. Returns a result describing
        success/failure counts and any tokens that should be pruned (e.g., because
        Expo reported them as unregistered)."""
