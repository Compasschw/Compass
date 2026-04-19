"""Notification service factory + high-level send helper.

Typical usage:
    from app.services.notifications import notify_user, NotificationPayload

    await notify_user(db, user_id, NotificationPayload(
        user_id=user_id,
        title="You have a new request",
        body="A member needs housing navigation help nearby.",
        deeplink="compasschw://requests",
        category="request.new",
    ))

`notify_user` handles fanout across all of the user's active device tokens
and automatically prunes any tokens the provider reports as invalid.
"""

from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.notifications.base import (
    NotificationPayload,
    NotificationProvider,
    NotificationResult,
)

_provider_instance: NotificationProvider | None = None


def get_notification_provider() -> NotificationProvider:
    """Return the configured notification provider singleton."""
    global _provider_instance
    if _provider_instance is not None:
        return _provider_instance

    from app.config import settings

    provider_name = getattr(settings, "notification_provider", "expo")

    if provider_name == "expo":
        from app.services.notifications.expo_provider import ExpoPushProvider
        _provider_instance = ExpoPushProvider(
            access_token=getattr(settings, "expo_access_token", "") or None,
        )
    else:
        raise ValueError(f"Unknown notification provider: {provider_name}")

    return _provider_instance


async def notify_user(
    db: AsyncSession,
    user_id: UUID,
    payload: NotificationPayload,
) -> NotificationResult:
    """Fanout `payload` to every active device registered to `user_id`.

    Prunes tokens that the provider reports as invalid (e.g., uninstalled apps).
    Failures don't raise — push notifications are best-effort; callers shouldn't
    break on delivery errors.
    """
    from app.models.device import DeviceToken

    result = await db.execute(
        select(DeviceToken.token)
        .where(DeviceToken.user_id == user_id)
        .where(DeviceToken.is_active == True)  # noqa: E712
    )
    tokens = [row[0] for row in result.all()]

    if not tokens:
        return NotificationResult()

    provider = get_notification_provider()
    outcome = await provider.send(payload, tokens)

    if outcome.invalid_tokens:
        # Prune invalid tokens — device uninstalled or provider-unregistered
        await db.execute(
            update(DeviceToken)
            .where(DeviceToken.token.in_(outcome.invalid_tokens))
            .values(is_active=False)
        )
        await db.commit()

    return outcome


__all__ = [
    "NotificationPayload",
    "NotificationProvider",
    "NotificationResult",
    "get_notification_provider",
    "notify_user",
]
