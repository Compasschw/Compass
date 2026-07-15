"""Vonage Messages API client for outbound SMS.

This is the SINGLE SMS-emitting channel in the codebase: masked-number
CHW<->member messaging, member-facing confirmations, and one-time OTP
verification codes all deliver through ``send_text`` here. (The legacy sync
key/secret SMS API client — formerly at
``app/services/communication/vonage_sms.py`` — was retired in Spec 1 so no
sync HTTP call blocks the event loop.) This module implements the
shared-masked-number PHI messaging channel:

  - Auth: a Vonage "Application" JWT (RS256), the same approach
    ``VonageProvider.download_recording_bytes`` already uses in
    ``app/services/communication/vonage_provider.py`` — signed with
    ``settings.vonage_application_id`` + the private key at
    ``settings.vonage_private_key_path``.
  - Transport: the Vonage **Messages API**, ``POST
    https://api.nexmo.com/v1/messages`` with
    ``{"message_type": "text", "channel": "sms", "to", "from", "text"}``.
    This is intentionally NOT the legacy SMS API the OTP sender uses —
    different auth model, different endpoint, different payload shape. The
    inbound webhook (``app/routers/communication.py::sms_inbound``) is coded
    against the Messages API's inbound payload shape to match; see that
    function's docstring and the PR description for the exact shape assumed,
    so ops can confirm it against the Vonage dashboard's configured webhook.

Pool-ready design note
-----------------------
Today there is ONE shared Vonage number for every CHW
(``settings.vonage_sms_number``, falling back to ``settings.
vonage_from_number``). A future phase may want a POOL of numbers. To make
that a pure addition — no rewrite of the send path or the inbound webhook —
"which number do we send FROM" is isolated behind ``get_sms_from_number()``
below; every call site asks this function and never reads
``settings.vonage_from_number`` / ``settings.vonage_sms_number`` directly.
When a pool ships, only this function's body needs to change (e.g. pick a
number scoped to the conversation/member); its signature and every caller
stay the same.

Inbound routing is, by construction, already number-agnostic: it routes
purely by the member's From number -> member row -> sticky conversation, and
never assumes a specific `to` number. ``get_our_sms_numbers()`` below exists
only for optional, non-blocking validation/logging of the inbound `to`
field against the set of numbers we currently own — it must never be used
to make a routing decision.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass

import httpx
from jose import jwt as jose_jwt

logger = logging.getLogger("compass.communication.vonage_sms_messages")

_MESSAGES_API_URL = "https://api.nexmo.com/v1/messages"
_JWT_TTL_SECONDS = 60
_HTTP_TIMEOUT_SECONDS = 20.0
# E.164 suffix length logged for debug correlation without exposing the
# full number (mirrors the masking used in the legacy OTP SMS client).
_LOG_SUFFIX_LEN = 4


@dataclass(frozen=True)
class SmsSendResult:
    """Outcome of a single outbound SMS send attempt.

    ``success`` is False for every failure mode (unconfigured private key,
    JWT mint error, network error, non-2xx from Vonage). ``send_text()``
    never raises — callers must check ``success`` rather than relying on
    exceptions, so a Vonage outage degrades to a clean 4xx/5xx response
    instead of crashing the request.
    """

    success: bool
    provider_message_id: str | None = None
    error: str | None = None
    status_code: int | None = None


def get_sms_from_number() -> str:
    """Return the Vonage number outbound SMS should be sent FROM.

    *** Pool-ready seam *** — every send call MUST go through this function
    instead of reading ``settings.vonage_from_number`` / ``settings.
    vonage_sms_number`` directly. Today it always returns the single shared
    number (``vonage_sms_number`` if set, else ``vonage_from_number``). A
    future number-pool feature changes only this function's internals (e.g.
    picking a number by conversation/member/load) — the send path and every
    endpoint that calls it stay unchanged.
    """
    from app.config import settings

    return (settings.vonage_sms_number or settings.vonage_from_number or "").strip()


def get_our_sms_numbers() -> frozenset[str]:
    """Return the set of Vonage numbers we currently own for SMS.

    Informational only. Used for defensive logging/validation of the
    inbound webhook's `to` field — NEVER for routing. Inbound routing is
    keyed exclusively off the member's `from` number so it keeps working
    unchanged once a number pool exists (this set would just grow).
    """
    from app.config import settings

    numbers = {settings.vonage_sms_number, settings.vonage_from_number}
    return frozenset(n.strip() for n in numbers if n and n.strip())


class VonageSmsMessagesClient:
    """Thin adapter over the Vonage Messages API for masked-number SMS.

    Stub mode: when the application JWT credentials or the from-number
    aren't configured (local dev, CI), ``send_text`` logs at INFO and
    returns a successful placeholder result — mirrors the stub-mode pattern
    used by ``VonageProvider`` so
    the rest of the send/persist pipeline can be exercised without a live
    Vonage account. Tests that need to assert failure/error handling mock
    ``send_text`` (or the module-level ``get_vonage_sms_messages_client``
    factory) directly rather than relying on stub mode.
    """

    def __init__(self, application_id: str, private_key_path: str) -> None:
        self._application_id = application_id
        self._private_key_path = private_key_path

    def is_configured(self) -> bool:
        return bool(
            self._application_id
            and self._private_key_path
            and get_sms_from_number()
        )

    def _mint_jwt(self) -> str | None:
        """Mint a short-lived Vonage Application JWT (RS256).

        Returns None (never raises) on any failure — missing/misreadable
        key file, or a signing error — so ``send_text`` can fold it into a
        clean ``SmsSendResult(success=False, ...)``.
        """
        if not (self._application_id and self._private_key_path):
            return None
        try:
            with open(self._private_key_path, "rb") as fh:
                private_key_pem = fh.read()
        except OSError as exc:
            logger.error(
                "vonage_sms: cannot read private key path=%s error=%s",
                self._private_key_path, exc,
            )
            return None

        now = int(time.time())
        try:
            return jose_jwt.encode(
                claims={
                    "application_id": self._application_id,
                    "iat": now,
                    "exp": now + _JWT_TTL_SECONDS,
                    "jti": str(uuid.uuid4()),
                },
                key=private_key_pem,
                algorithm="RS256",
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "vonage_sms: JWT mint failed error_type=%s error=%s",
                type(exc).__name__, exc,
            )
            return None

    async def send_text(self, to_e164: str, text: str) -> SmsSendResult:
        """Send a text message via the Vonage Messages API.

        Args:
            to_e164: Recipient phone in E.164 format (e.g. "+12125551234").
            text: Message body.

        Returns:
            SmsSendResult — never raises.
        """
        from_number = get_sms_from_number()
        if not self.is_configured():
            logger.info(
                "vonage_sms: not configured — stub mode, no SMS sent to=%s",
                _masked(to_e164),
            )
            return SmsSendResult(
                success=True,
                provider_message_id=f"vonage-sms-placeholder-{uuid.uuid4().hex}",
            )

        token = self._mint_jwt()
        if token is None:
            return SmsSendResult(success=False, error="jwt_mint_failed")

        payload = {
            "message_type": "text",
            "channel": "sms",
            "to": _digits_only(to_e164),
            "from": _digits_only(from_number),
            "text": text,
        }

        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(_HTTP_TIMEOUT_SECONDS)) as client:
                response = await client.post(
                    _MESSAGES_API_URL,
                    json=payload,
                    headers={"Authorization": f"Bearer {token}"},
                )
        except httpx.HTTPError as exc:
            logger.error(
                "vonage_sms: httpx error to=%s error_type=%s",
                _masked(to_e164), type(exc).__name__,
            )
            return SmsSendResult(success=False, error=f"network_error:{type(exc).__name__}")

        if response.status_code not in (200, 201, 202):
            logger.error(
                "vonage_sms: Vonage returned %d to=%s body_prefix=%s",
                response.status_code,
                _masked(to_e164),
                (response.text or "")[:200].replace("\n", " "),
            )
            return SmsSendResult(
                success=False,
                error=f"vonage_status_{response.status_code}",
                status_code=response.status_code,
            )

        try:
            body = response.json()
        except Exception:  # noqa: BLE001
            body = {}
        message_uuid = body.get("message_uuid") if isinstance(body, dict) else None

        logger.info(
            "vonage_sms: sent to=%s message_uuid=%s",
            _masked(to_e164), message_uuid,
        )
        return SmsSendResult(
            success=True,
            provider_message_id=message_uuid,
            status_code=response.status_code,
        )


def _digits_only(number: str) -> str:
    """Vonage's Messages API `to`/`from` fields expect digits only (no `+`)."""
    return "".join(ch for ch in (number or "") if ch.isdigit())


def _masked(phone_e164: str) -> str:
    """Return the last 4 digits prefixed with *** for safe (non-PHI) logging."""
    digits_only = phone_e164[-_LOG_SUFFIX_LEN:] if len(phone_e164) >= _LOG_SUFFIX_LEN else phone_e164
    return f"***{digits_only}"


def get_vonage_sms_messages_client() -> VonageSmsMessagesClient:
    """Return a VonageSmsMessagesClient built from current settings.

    Constructed fresh on every call (not cached as a module-level
    singleton) — unlike ``get_provider()``'s lazy Vonage SDK client, this
    client holds no expensive connection state, and reading settings fresh
    each call keeps it correct under test monkeypatching of
    ``app.config.settings``.
    """
    from app.config import settings

    return VonageSmsMessagesClient(
        application_id=settings.vonage_application_id,
        private_key_path=settings.vonage_private_key_path,
    )
