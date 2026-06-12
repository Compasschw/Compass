"""Vonage implementation of the CommunicationProvider interface.

Uses Vonage Voice API for masked calling between CHW and member.
Requires VONAGE_API_KEY, VONAGE_API_SECRET, VONAGE_APPLICATION_ID, and
VONAGE_PRIVATE_KEY_PATH in environment/config.

Call flow (click-to-connect / masked bridge):
  1. Mobile app calls POST /api/v1/communication/call-bridge with recipient_id
  2. Backend creates a Vonage outbound call FROM our Vonage number TO the
     initiator (e.g. the CHW's phone)
  3. When the CHW answers, Vonage hits our answer webhook
  4. The webhook returns an NCCO (Nexmo Call Control Object) that connects
     the CHW's leg to the recipient's real phone number
  5. Neither party ever sees the other's real number — both see our
     Vonage number. Calls are recorded for clinical documentation.
"""

import logging

from app.services.communication.base import (
    CommunicationProvider,
    ProxySession,
    RecordingResult,
    TranscriptResult,
)

logger = logging.getLogger("compass.communication.vonage")


class VonageProvider(CommunicationProvider):
    """Vonage Voice API adapter for masked calling, recording, transcription."""

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        application_id: str,
        private_key_path: str,
        from_number: str = "",
        proxy_number_pool: list[str] | None = None,
    ) -> None:
        self._api_key = api_key
        self._api_secret = api_secret
        self._application_id = application_id
        self._private_key_path = private_key_path
        # Our rented Vonage number — what both parties see on caller ID.
        self._from_number = from_number
        self._number_pool = proxy_number_pool or ([from_number] if from_number else [])
        self._client = None

    def _is_configured(self) -> bool:
        return bool(
            self._api_key
            and self._api_secret
            and self._application_id
            and self._private_key_path
            and self._from_number
        )

    def _get_client(self):
        """Lazy-initialize the Vonage SDK client."""
        if self._client is None:
            if not self._is_configured():
                return None
            try:
                from vonage import Auth, Vonage
                auth = Auth(
                    api_key=self._api_key,
                    api_secret=self._api_secret,
                    application_id=self._application_id,
                    private_key=self._private_key_path,
                )
                self._client = Vonage(auth)
            except ImportError:
                logger.warning("vonage SDK not installed. Install with: pip install vonage")
                return None
            except Exception as e:  # noqa: BLE001
                logger.error("Failed to initialize Vonage client: %s", e)
                return None
        return self._client

    async def create_proxy_session(
        self,
        session_id: str,
        chw_phone: str,
        member_phone: str,
    ) -> ProxySession:
        """Initiate a masked bridge between CHW and member.

        Places **two** parallel outbound calls from our Vonage number:

        1. CHW leg → answer URL ``/voice/answer`` returns NCCO that joins the
           CHW into the named Conversation ``compass-session-<session_id>``
           after a brief hold message + optional WebSocket fork for
           transcription.
        2. Member leg → answer URL ``/voice/consent-prompt`` runs the
           California §632 consent IVR; on DTMF "1" the consent-result NCCO
           plays an ack, forks audio to a member-role WebSocket, and joins
           the same named Conversation. On DTMF "2" or timeout the member
           leg hangs up and the session is marked ``cancelled_no_consent``.

        Both legs joining the same named Conversation is what bridges them
        for two-way voice. Earlier versions placed only the CHW call and
        nested a ``connect(phone)`` action inside the CHW NCCO to dial the
        member — that pattern silently failed to bridge because the
        ``connect`` action blocks until the dialed leg ends, so the
        ``conversation`` action that follows never runs while the call is
        live.

        Returns a placeholder if Vonage isn't configured (e.g. local dev).

        NOTE: The Vonage Python SDK v4+ uses pydantic models where the
        source-number field is ``from_`` (trailing underscore — ``from`` is a
        Python keyword). The legacy dict form requires the same ``from_``
        key.
        """
        client = self._get_client()

        if client is None:
            logger.info(
                "Vonage not configured — returning placeholder proxy session for session_id=%s",
                session_id,
            )
            return ProxySession(
                provider_session_id=f"vonage-placeholder-{session_id}",
                proxy_number=self._from_number or "+1-000-000-0000",
                provider="vonage",
            )

        from_endpoint = {"type": "phone", "number": _strip(self._from_number)}
        event_url = [f"{_webhook_base()}/voice/events?session={session_id}"]

        chw_call_payload = {
            "to": [{"type": "phone", "number": _strip(chw_phone)}],
            "from_": from_endpoint,
            # No `member=` query param needed any more — the member is dialed
            # by the second create_call below.
            "answer_url": [f"{_webhook_base()}/voice/answer?session={session_id}"],
            "event_url": event_url,
        }
        member_call_payload = {
            "to": [{"type": "phone", "number": _strip(member_phone)}],
            "from_": from_endpoint,
            # consent-prompt is the answer URL for the member leg — it plays
            # the §632 IVR and on DTMF "1" hands off to consent-result which
            # joins the named conversation.
            "answer_url": [
                f"{_webhook_base()}/voice/consent-prompt?session={session_id}"
            ],
            "event_url": event_url,
        }

        # Place the CHW call first so the CHW is in the named conversation
        # (or at least ringing toward it) before the member's leg dials.
        try:
            chw_response = client.voice.create_call(chw_call_payload)
            chw_uuid = getattr(chw_response, "uuid", None) or (
                chw_response.get("uuid") if isinstance(chw_response, dict) else None
            )
            chw_conv = getattr(chw_response, "conversation_uuid", None) or (
                chw_response.get("conversation_uuid") if isinstance(chw_response, dict) else None
            )
            logger.info(
                "vonage.create_call.chw_leg: session=%s uuid=%s conv=%s",
                session_id, chw_uuid, chw_conv,
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Vonage create_call (CHW leg) failed for session %s: %s", session_id, e)
            return ProxySession(
                provider_session_id=f"vonage-failed-{session_id}",
                proxy_number=self._from_number,
                provider="vonage",
            )

        # Now place the member leg. If this fails, the CHW is alone on the
        # named conversation and will hear silence — we still return success
        # so the UI doesn't block, but log the failure prominently so ops
        # can intervene (e.g. retry or rotate the call).
        try:
            member_response = client.voice.create_call(member_call_payload)
            member_uuid = getattr(member_response, "uuid", None) or (
                member_response.get("uuid") if isinstance(member_response, dict) else None
            )
            member_conv = getattr(member_response, "conversation_uuid", None) or (
                member_response.get("conversation_uuid") if isinstance(member_response, dict) else None
            )
            logger.info(
                "vonage.create_call.member_leg: session=%s uuid=%s conv=%s",
                session_id, member_uuid, member_conv,
            )
        except Exception as e:  # noqa: BLE001
            logger.error(
                "Vonage create_call (MEMBER leg) failed for session %s — "
                "CHW will hear silence on the named conversation: %s",
                session_id, e,
            )

        # The "session" id we surface to the rest of the app is the named
        # conversation (deterministic, joinable by both legs), not the per-
        # leg Vonage UUID.  This makes downstream lookups (recording URL,
        # transcript joining) consistent across legs.
        return ProxySession(
            provider_session_id=f"compass-session-{session_id}",
            proxy_number=self._from_number,
            provider="vonage",
        )

    async def end_proxy_session(self, provider_session_id: str) -> None:
        """Hang up the active Vonage call if it's still live."""
        client = self._get_client()
        if client is None or provider_session_id.startswith(("vonage-placeholder", "vonage-failed")):
            return

        try:
            # The PUT /calls/{uuid} action=hangup terminates a live call.
            client.voice.update_call(provider_session_id, {"action": "hangup"})
            logger.info("Ended Vonage call: %s", provider_session_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("Vonage end_proxy_session failed (%s): %s", provider_session_id, e)

    async def get_recording(self, provider_session_id: str) -> RecordingResult | None:
        """Retrieve the recording URL for a completed call.

        Vonage sends the recording URL via the event webhook as a `record`
        event type, so the event handler persists it on CommunicationSession.
        This method reads the cached URL from the DB; no Vonage REST call
        is needed post-hoc.
        """
        # Implementation note: the recording URL is saved by the
        # /voice/events webhook when it receives the `record` event. Callers
        # should fetch the CommunicationSession row and pull `recording_url`
        # directly — no live Vonage lookup required.
        return None

    async def download_recording_bytes(self, recording_url: str) -> bytes | None:
        """Download a Vonage call recording's bytes for downstream processing.

        Vonage recording URLs (``https://api-{region}.nexmo.com/v1/files/...``)
        require an application-scoped RS256 JWT in the ``Authorization`` header
        — they are NOT publicly fetchable.  The Vonage Python SDK in our
        currently-pinned version does not expose a download method on the
        voice namespace, so we mint the JWT ourselves with the configured
        application_id + private key file and fetch via ``httpx``.

        Returns ``None`` on any failure (private key missing, JWT mint error,
        non-200 from Vonage, unreachable host).  Callers persist the empty
        state and let a re-delivered webhook retry rather than crashing.

        Security: the recording URL host is logged at INFO; the full URL is
        not logged because the path contains the recording UUID which can be
        correlated back to a member via downstream lookups.
        """
        if not (self._application_id and self._private_key_path):
            logger.warning(
                "download_recording_bytes: application_id or private_key_path "
                "not configured — cannot mint Vonage JWT"
            )
            return None

        # Mint the Vonage application JWT (RS256 over PKCS#1 private key).
        # The python-jose dependency we already ship handles RS256 signing.
        import time
        import uuid

        from jose import jwt as jose_jwt

        try:
            with open(self._private_key_path, "rb") as fh:
                private_key_pem = fh.read()
        except OSError as exc:
            logger.error(
                "download_recording_bytes: cannot read private key path=%s error=%s",
                self._private_key_path, exc,
            )
            return None

        now = int(time.time())
        try:
            token = jose_jwt.encode(
                claims={
                    "application_id": self._application_id,
                    "iat": now,
                    # 60-second TTL is enough for a single download and well
                    # within Vonage's allowed clock skew.
                    "exp": now + 60,
                    "jti": str(uuid.uuid4()),
                },
                key=private_key_pem,
                algorithm="RS256",
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "download_recording_bytes: Vonage JWT mint failed error_type=%s error=%s",
                type(exc).__name__, exc,
            )
            return None

        # Fetch the recording.  httpx is already a top-level dependency.
        import httpx
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
                response = await client.get(
                    recording_url,
                    headers={"Authorization": f"Bearer {token}"},
                    follow_redirects=True,
                )
        except httpx.HTTPError as exc:
            logger.error(
                "download_recording_bytes: httpx error url_host=%s error_type=%s",
                _safe_host(recording_url), type(exc).__name__,
            )
            return None

        if response.status_code != 200:
            logger.error(
                "download_recording_bytes: Vonage returned %d url_host=%s body_prefix=%s",
                response.status_code,
                _safe_host(recording_url),
                # Truncate so we don't dump a giant HTML error page into logs;
                # status + first 200 chars is enough to diagnose.
                (response.text or "")[:200].replace("\n", " "),
            )
            return None

        return response.content

    async def get_transcript(self, recording_url: str) -> TranscriptResult | None:
        """Transcribe via the transcription provider (AssemblyAI by default).

        We separate transcription from voice because (a) AssemblyAI has a
        medical speech model with clinical terminology Vonage lacks and
        (b) keeping the abstraction means we can swap transcription
        vendors (Deepgram, Google Medical, on-prem Whisper) without
        touching the Vonage integration.
        """
        if not recording_url:
            return None

        try:
            from app.services.transcription import get_transcription_provider
            provider = get_transcription_provider()
            transcript = await provider.transcribe(recording_url, medical=True)
            if transcript is None:
                return None
            return TranscriptResult(
                text=transcript.text,
                confidence=transcript.confidence,
                provider_transcript_id=transcript.provider_id,
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Transcription failed: %s", e)
            return None


# ─── Helpers ────────────────────────────────────────────────────────────────


def _strip(number: str) -> str:
    """Normalize a phone string into Vonage's expected format.

    Vonage's create_call ``to.number`` field expects E.164 **without** the
    leading ``+`` — for a US 10-digit number that means ``"13105550199"``.
    Common input shapes from our DB and signup form:

      "+1 (310) 555-0199" → "13105550199"   (strip formatting, keep "1")
      "+13105550199"      → "13105550199"   (strip "+")
      "13105550199"       → "13105550199"   (already correct)
      "3105550199"        → "13105550199"   (default to US: prepend "1")
      "(310) 555-0199"    → "13105550199"   (10-digit local → US E.164)

    Without the country-code prepend on 10-digit inputs, Vonage's outbound
    call routes unpredictably — observed 2026-05-18: one leg never rang,
    the other rang with a multi-second delay before dropping.

    Non-US international numbers (15-digit + already include their own
    country code) pass through unchanged.
    """
    digits = "".join(ch for ch in (number or "") if ch.isdigit())
    # US default: bare 10-digit NANP numbers get the "1" country code.
    if len(digits) == 10:
        digits = f"1{digits}"
    return digits


def _safe_host(url: str) -> str:
    """Extract just the hostname from a URL for safe logging (no PHI in path)."""
    from urllib.parse import urlparse
    try:
        return urlparse(url).hostname or "<unparseable>"
    except Exception:  # noqa: BLE001
        return "<unparseable>"


def _webhook_base() -> str:
    """Construct the public base URL for Vonage webhooks from settings.

    Vonage must reach this over HTTPS. We derive it from `magic_link_base_url`
    which is already the production public domain.
    """
    from app.config import settings

    # magic_link_base_url looks like "https://api.joincompasschw.com/auth/magic";
    # strip the tail to reuse it as the API base.
    base = settings.magic_link_base_url.rstrip("/")
    if base.endswith("/auth/magic"):
        base = base[: -len("/auth/magic")]
    # If the env var points at the web domain (joincompasschw.com), prefer the
    # dedicated api subdomain instead.
    base = base.replace("https://joincompasschw.com", "https://api.joincompasschw.com")
    # Append the router prefix so webhook URLs land on /api/v1/communication/...
    if not base.endswith("/api/v1/communication"):
        base = f"{base}/api/v1/communication"
    return base
