"""Vonage SMS provider for transactional one-time codes.

Sends 6-digit verification codes via Vonage's SMS API.  The same
VonageSmsProvider class is used for both registration-time challenges and
profile phone-update challenges.

Stub mode
---------
When Vonage credentials are not configured (local dev, CI) the class logs the
code body at DEBUG level and returns ``True`` so callers can exercise the full
verification flow without a real Vonage account.  The code is still hashed
and stored server-side — only the SMS delivery is skipped.

HIPAA note
----------
The full E.164 phone number is **never** written to INFO-level logs.  Only the
last 4 digits appear in structured log messages so that log aggregators (e.g.
CloudWatch, Datadog) cannot reconstruct subscribers' phone numbers.
"""

import logging

logger = logging.getLogger("compass.communication.vonage_sms")

# E.164 suffix length logged for debug correlation without exposing the full
# number.  "+12125551234" → "***1234".
_LOG_SUFFIX_LEN = 4


def _masked(phone_e164: str) -> str:
    """Return the last 4 digits prefixed with *** for safe logging."""
    digits_only = phone_e164[-_LOG_SUFFIX_LEN:] if len(phone_e164) >= _LOG_SUFFIX_LEN else phone_e164
    return f"***{digits_only}"


class VonageSmsProvider:
    """Thin adapter over the Vonage SMS API for OTP delivery.

    Args:
        api_key: Vonage API key.
        api_secret: Vonage API secret.
        from_number: Vonage virtual number in E.164 format (with or without
            the leading ``+``).  Vonage's SMS API requires the ``+`` to be
            stripped; this class handles the normalisation internally.

    The class lazily initialises the Vonage SDK client on the first
    :meth:`send_code` call.  Repeated failures are logged but never raise —
    the contract is that SMS delivery is best-effort; the calling layer is
    responsible for communicating delivery errors to the user.
    """

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        from_number: str,
    ) -> None:
        self._api_key = api_key
        self._api_secret = api_secret
        # Normalise: Vonage SMS API wants digits only (no + or spaces)
        self._from_number = from_number
        self._client = None

    # ── Configuration check ──────────────────────────────────────────────────

    def _is_configured(self) -> bool:
        return bool(self._api_key and self._api_secret and self._from_number)

    # ── Lazy client init ─────────────────────────────────────────────────────

    def _get_client(self):
        """Return a Vonage SDK client, or None when unavailable."""
        if self._client is not None:
            return self._client

        if not self._is_configured():
            return None

        try:
            from vonage import Auth, Vonage  # type: ignore[import-untyped]

            auth = Auth(api_key=self._api_key, api_secret=self._api_secret)
            self._client = Vonage(auth)
            return self._client
        except ImportError:
            logger.warning(
                "vonage SDK not installed. Install with: pip install vonage"
            )
            return None
        except Exception as exc:  # noqa: BLE001
            logger.error("Failed to initialise Vonage client: %s", exc)
            return None

    # ── Public API ───────────────────────────────────────────────────────────

    def send_code(self, to_e164: str, code: str) -> bool:
        """Send a 6-digit OTP to *to_e164* via Vonage SMS.

        Args:
            to_e164: Recipient phone in E.164 format, e.g. ``"+12125551234"``.
            code: The raw 6-digit numeric string to deliver.

        Returns:
            ``True`` when the message was accepted by Vonage (or when running
            in stub mode); ``False`` when delivery failed.

        HIPAA: the full *to_e164* is never emitted at INFO level.
        """
        body = (
            f"Your CompassCHW verification code is {code}. "
            "Expires in 10 minutes."
        )

        client = self._get_client()
        if client is None:
            # Stub mode — log body at DEBUG so devs can grab the code
            # without spinning up a real Vonage account.
            logger.info(
                "Vonage SMS not configured — stub mode. "
                "Would send OTP to %s (last 4 digits shown).",
                _masked(to_e164),
            )
            logger.debug("Stub SMS body: %s", body)
            return True

        # Vonage SMS API expects digits only (no + or formatting).
        to_digits = "".join(ch for ch in to_e164 if ch.isdigit())
        from_digits = "".join(ch for ch in self._from_number if ch.isdigit())

        try:
            from vonage_sms.models import SmsMessage  # type: ignore[import-untyped]

            message = SmsMessage(
                to=to_digits,
                from_=from_digits,
                text=body,
            )
            response = client.sms.send(message)

            # Vonage returns a messages list; status "0" = success per
            # https://developer.vonage.com/en/messaging/sms/code-snippets/send-an-sms
            messages = getattr(response, "messages", None) or []
            if messages:
                status = str(getattr(messages[0], "status", "-1"))
                if status == "0":
                    logger.info(
                        "SMS OTP sent to %s via Vonage.",
                        _masked(to_e164),
                    )
                    return True
                else:
                    error_text = getattr(messages[0], "error_text", "unknown")
                    logger.error(
                        "Vonage SMS delivery failed for %s: status=%s error=%s",
                        _masked(to_e164),
                        status,
                        error_text,
                    )
                    return False
            else:
                logger.error(
                    "Vonage SMS response had no messages for %s.",
                    _masked(to_e164),
                )
                return False

        except Exception as exc:  # noqa: BLE001
            logger.error(
                "Vonage SMS exception for %s: %s",
                _masked(to_e164),
                exc,
            )
            return False


# ── Module-level singleton factory ───────────────────────────────────────────


def get_vonage_sms_provider() -> VonageSmsProvider:
    """Return the application-scoped VonageSmsProvider, built from settings.

    Mirrors the lazy-singleton pattern used by other communication providers.
    The returned instance is unconfigured (stub) when Vonage env vars are
    absent, which is safe for local development.
    """
    from app.config import settings

    return VonageSmsProvider(
        api_key=settings.vonage_api_key,
        api_secret=settings.vonage_api_secret,
        from_number=settings.vonage_from_number,
    )
