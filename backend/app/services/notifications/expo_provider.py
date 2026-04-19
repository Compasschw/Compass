"""Expo Push Notification provider.

Expo's push service wraps both APNs (iOS) and FCM (Android) behind a single
HTTP API. During development this means we don't need Apple/Google credentials
to send notifications — only an Expo push token per device.

Docs: https://docs.expo.dev/push-notifications/sending-notifications/
"""

import logging
from typing import Any

import httpx

from app.services.notifications.base import (
    NotificationPayload,
    NotificationProvider,
    NotificationResult,
)

logger = logging.getLogger("compass.notifications.expo")

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
MAX_BATCH_SIZE = 100  # Expo limit per request


class ExpoPushProvider(NotificationProvider):
    """Sends push notifications via Expo Push Service.

    Works without Apple/Google credentials as long as the client app uses
    `expo-notifications` to obtain tokens. For production-grade delivery
    guarantees, use the FCM v1 / APNs credentials directly — but Expo is
    fine for early launch and handles retries + batching for us.
    """

    def __init__(self, access_token: str | None = None) -> None:
        # Expo access token is optional — required only for non-public channels
        # or if you want higher rate limits. For MVP scale (<1000 sends/day),
        # the anonymous tier is sufficient.
        self._access_token = access_token

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate",
            "Content-Type": "application/json",
        }
        if self._access_token:
            headers["Authorization"] = f"Bearer {self._access_token}"
        return headers

    def _build_message(self, payload: NotificationPayload, token: str) -> dict[str, Any]:
        message = {
            "to": token,
            "title": payload.title,
            "body": payload.body,
            "sound": "default",
            "priority": "high",
            "channelId": "default",  # Android notification channel
            "data": {
                **payload.data,
                "category": payload.category,
            },
        }
        if payload.deeplink:
            message["data"]["deeplink"] = payload.deeplink
        return message

    async def send(
        self,
        payload: NotificationPayload,
        tokens: list[str],
    ) -> NotificationResult:
        result = NotificationResult()
        if not tokens:
            return result

        # Expo only accepts Expo push tokens (start with "ExponentPushToken[")
        # Filter out any non-Expo tokens defensively.
        valid_tokens = [t for t in tokens if t.startswith("ExponentPushToken[") or t.startswith("ExpoPushToken[")]
        if not valid_tokens:
            result.invalid_tokens = tokens
            return result

        # Batch up to MAX_BATCH_SIZE per request (Expo's limit)
        async with httpx.AsyncClient(timeout=10.0) as client:
            for i in range(0, len(valid_tokens), MAX_BATCH_SIZE):
                batch = valid_tokens[i : i + MAX_BATCH_SIZE]
                messages = [self._build_message(payload, t) for t in batch]

                try:
                    resp = await client.post(EXPO_PUSH_URL, json=messages, headers=self._headers())
                    resp.raise_for_status()
                    body = resp.json()

                    # Expo returns a list of tickets, one per message
                    # https://docs.expo.dev/push-notifications/sending-notifications/#push-tickets
                    tickets = body.get("data", [])
                    for idx, ticket in enumerate(tickets):
                        status = ticket.get("status")
                        if status == "ok":
                            result.sent += 1
                        else:
                            result.failed += 1
                            error_details = ticket.get("details", {})
                            if error_details.get("error") == "DeviceNotRegistered":
                                # This token should be pruned — device uninstalled the app
                                result.invalid_tokens.append(batch[idx])
                            result.errors.append(ticket.get("message", "unknown"))
                except httpx.HTTPStatusError as e:
                    logger.error("Expo push HTTP %d: %s", e.response.status_code, e.response.text[:500])
                    result.failed += len(batch)
                    result.errors.append(f"HTTP {e.response.status_code}")
                except Exception as e:  # noqa: BLE001
                    logger.error("Expo push error: %s", e)
                    result.failed += len(batch)
                    result.errors.append(str(e))

        return result
