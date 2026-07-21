"""Server-side, one-way Google Calendar sync (Compass → Google).

Compass pushes each scheduled session to every connected participant's **primary**
Google Calendar, mirroring the best-effort SMS/notification fan-out pattern used
throughout the session handlers: a failure here NEVER fails the session mutation,
and the whole feature is a silent no-op until it is fully configured.

Two gates guard every calendar API interaction:
  1. ``settings.google_calendar_sync_enabled`` — the master kill-switch (default
     OFF), and
  2. ``settings.is_google_calendar_configured`` — both the Google OAuth client id
     AND secret are set,
plus the acting user must have a stored ``GoogleCalendarCredential``. If any is
missing the public functions return immediately without building a Google client
or touching the network.

The only durable secret is the per-user **refresh token** (encrypted at rest via
``EncryptedString``). Access tokens are minted on demand from it by google-auth
and never persisted. The google-api-python-client is synchronous, so its calls
run in a threadpool (``asyncio.to_thread``) to avoid blocking the event loop.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings

logger = logging.getLogger("compass.google_calendar")

# Google OAuth 2.0 endpoints.
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"

# The single scope this feature requires. A connect grant MUST include it or we
# refuse to store the credential (we can't create events without it).
CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events"

# Default appointment length when a session has no explicit ``scheduled_end_at``.
_DEFAULT_DURATION = timedelta(minutes=30)


# ─── OAuth authorization-code exchange ───────────────────────────────────────


async def exchange_code_for_tokens(*, code: str, redirect_uri: str) -> dict[str, Any] | None:
    """Exchange a Google OAuth authorization code for access + refresh tokens.

    POSTs to Google's token endpoint with the ``authorization_code`` grant.
    Returns the parsed token response dict on success (contains ``access_token``,
    ``refresh_token`` when offline access was granted, ``scope``, and usually an
    ``id_token``), or ``None`` on any failure (not configured, non-200, network
    error, unparseable body). Never raises.

    Args:
        code: The one-time authorization code from Google's consent redirect.
        redirect_uri: The exact redirect URI registered for the OAuth client and
            used by the frontend to obtain ``code`` — Google validates it matches.
    """
    if not settings.is_google_calendar_configured:
        logger.warning("google_calendar: exchange attempted while not configured")
        return None
    try:
        async with httpx.AsyncClient(timeout=10.0) as http:
            resp = await http.post(
                GOOGLE_TOKEN_URL,
                data={
                    "code": code,
                    "client_id": settings.google_oauth_client_id,
                    "client_secret": settings.google_oauth_client_secret,
                    "redirect_uri": redirect_uri,
                    "grant_type": "authorization_code",
                },
            )
    except Exception:  # noqa: BLE001 — network/transport failure → treat as failed exchange
        logger.warning("google_calendar: token exchange request failed", exc_info=True)
        return None

    if resp.status_code != 200:
        # Never log the response body verbatim — it may echo the code. Status only.
        logger.warning("google_calendar: token exchange returned HTTP %s", resp.status_code)
        return None
    try:
        return resp.json()
    except (ValueError, json.JSONDecodeError):
        logger.warning("google_calendar: token exchange returned non-JSON body")
        return None


def email_from_id_token(id_token: str | None) -> str | None:
    """Best-effort extract the ``email`` claim from a Google id_token.

    Decodes the JWT payload segment WITHOUT signature verification — the token
    came directly from Google's TLS-protected token endpoint in the same request,
    so it is trusted transport-wise, and we only read a non-authorization display
    field (the account email). Returns ``None`` if the token is absent or
    malformed. Never raises.
    """
    if not id_token:
        return None
    try:
        parts = id_token.split(".")
        if len(parts) != 3:
            return None
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        email = payload.get("email")
        return email.lower().strip() if isinstance(email, str) and email else None
    except (ValueError, binascii.Error, json.JSONDecodeError, UnicodeDecodeError):
        return None


async def revoke_refresh_token(refresh_token: str) -> None:
    """Best-effort revoke a refresh token at Google. Never raises."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as http:
            await http.post(GOOGLE_REVOKE_URL, data={"token": refresh_token})
    except Exception:  # noqa: BLE001
        logger.warning("google_calendar: token revoke failed (ignored)", exc_info=True)


# ─── Credential lookup ───────────────────────────────────────────────────────


async def _get_credential(db: AsyncSession, user_id: UUID):
    """Return the user's ``GoogleCalendarCredential`` row, or ``None``."""
    from app.models.google_calendar import GoogleCalendarCredential

    return (
        await db.execute(
            select(GoogleCalendarCredential).where(GoogleCalendarCredential.user_id == user_id).limit(1)
        )
    ).scalars().first()


# ─── Synchronous Google API helpers (run inside asyncio.to_thread) ───────────


def _build_calendar_service(refresh_token: str) -> Any:
    """Build an authorized Google Calendar API client from a refresh token.

    Synchronous (google-api-python-client is sync) — always call via
    ``asyncio.to_thread``. Split out as a module-level function so tests can
    patch it to inject a fake service and avoid all network I/O.
    """
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    credentials = Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri=GOOGLE_TOKEN_URL,
        client_id=settings.google_oauth_client_id,
        client_secret=settings.google_oauth_client_secret,
        scopes=[CALENDAR_EVENTS_SCOPE],
    )
    return build("calendar", "v3", credentials=credentials, cache_discovery=False)


def _sync_upsert_event(refresh_token: str, event_body: dict[str, Any], existing_event_id: str | None) -> str | None:
    """PATCH an existing event or INSERT a new one on the user's primary calendar.

    Returns the Google event id. Synchronous — call via ``asyncio.to_thread``.
    """
    service = _build_calendar_service(refresh_token)
    if existing_event_id:
        result = (
            service.events()
            .patch(calendarId="primary", eventId=existing_event_id, body=event_body)
            .execute()
        )
    else:
        result = service.events().insert(calendarId="primary", body=event_body).execute()
    return (result or {}).get("id")


def _sync_delete_event(refresh_token: str, event_id: str) -> None:
    """DELETE an event from the user's primary calendar. Call via to_thread."""
    service = _build_calendar_service(refresh_token)
    service.events().delete(calendarId="primary", eventId=event_id).execute()


# ─── Event body construction ─────────────────────────────────────────────────


async def _build_event_body(db: AsyncSession, session: Any, user_id: UUID) -> dict[str, Any] | None:
    """Build the Google event payload for ``session`` as seen by ``user_id``.

    Encodes only the OTHER participant's first name (no PHI beyond a first name)
    and reflects the confirmed/pending state in the title. Returns ``None`` when
    the session has no ``scheduled_at`` (can't create a timed event).
    """
    start = getattr(session, "scheduled_at", None)
    if start is None:
        return None
    end = getattr(session, "scheduled_end_at", None) or (start + _DEFAULT_DURATION)

    from app.models.user import User

    other_id = session.member_id if user_id == session.chw_id else session.chw_id
    other = await db.get(User, other_id)
    other_first = other.name.split()[0] if other and other.name else "your Compass contact"

    confirmed = getattr(session, "scheduling_status", None) == "confirmed"
    suffix = "" if confirmed else " (pending)"
    return {
        "summary": f"Compass session with {other_first}{suffix}",
        "description": (
            "Compass Community Health Worker session. "
            "Created and managed by the Compass app — changes made directly in "
            "Google Calendar are not synced back."
        ),
        "start": {"dateTime": start.isoformat()},
        "end": {"dateTime": end.isoformat()},
    }


async def _get_calendar_event(db: AsyncSession, session: Any, user_id: UUID):
    """Read-only lookup of the ``CalendarEvent`` row for this user+session (or None)."""
    from app.models.calendar import CalendarEvent

    return (
        await db.execute(
            select(CalendarEvent)
            .where(CalendarEvent.user_id == user_id, CalendarEvent.session_id == session.id)
            .limit(1)
        )
    ).scalars().first()


def _new_calendar_event(session: Any, user_id: UUID):
    """Build (do not persist) a minimal ``CalendarEvent`` row to hold the Google
    event id when none exists yet (e.g. the schedule_session path). calendar_events
    is not rendered directly, so this creates no visible side effect."""
    from app.models.calendar import CalendarEvent

    start = getattr(session, "scheduled_at", None)
    if start is None:
        return None
    end = getattr(session, "scheduled_end_at", None) or (start + _DEFAULT_DURATION)
    return CalendarEvent(
        user_id=user_id,
        session_id=session.id,
        title="Compass session",
        date=start.date(),
        start_time=start.time(),
        end_time=end.time(),
        vertical=getattr(session, "vertical", None),
        event_type="session",
    )


# ─── Public best-effort hooks ────────────────────────────────────────────────


def _sync_enabled() -> bool:
    """Both the master flag AND full configuration must be present."""
    return bool(settings.google_calendar_sync_enabled and settings.is_google_calendar_configured)


async def push_session_event(db: AsyncSession, *, session: Any, user_id: UUID) -> None:
    """Create-or-update the Google Calendar event mirroring ``session`` for
    ``user_id``. Silent no-op unless sync is enabled, configured, and the user
    has a connected calendar. Never raises — best-effort like the SMS fan-out."""
    if not _sync_enabled():
        return
    cred = await _get_credential(db, user_id)
    if cred is None:
        return

    # Read-only prep first — NO DB writes yet, so a Google failure below leaves
    # the caller's shared transaction untouched (a rollback here would expire the
    # caller's ORM objects and break its post-hook attribute access).
    event_body = await _build_event_body(db, session, user_id)
    if event_body is None:
        return
    cal_event = await _get_calendar_event(db, session, user_id)
    existing_id = cal_event.google_event_id if cal_event is not None else None

    # Network call (in a threadpool). On any failure: log + return, nothing to undo.
    try:
        new_id = await asyncio.to_thread(_sync_upsert_event, cred.refresh_token, event_body, existing_id)
    except Exception:  # noqa: BLE001 — best-effort; never fail the caller's mutation
        logger.warning("google_calendar: push_session_event failed for user %s", user_id, exc_info=True)
        return

    # Persist the id/sync-time. Only rolls back its OWN write on failure.
    try:
        if cal_event is None:
            cal_event = _new_calendar_event(session, user_id)
            if cal_event is None:
                return
            db.add(cal_event)
        if new_id:
            cal_event.google_event_id = new_id
        cal_event.google_synced_at = datetime.now(UTC)
        await db.commit()
    except Exception:  # noqa: BLE001
        await db.rollback()
        logger.warning("google_calendar: persisting google_event_id failed for user %s", user_id, exc_info=True)


async def delete_session_event(db: AsyncSession, *, session: Any, user_id: UUID) -> None:
    """Delete the Google Calendar event mirroring ``session`` for ``user_id`` and
    clear the stored id. Silent no-op unless enabled/configured/connected and an
    event id is stored. Never raises."""
    if not _sync_enabled():
        return
    cred = await _get_credential(db, user_id)
    if cred is None:
        return

    from app.models.calendar import CalendarEvent

    cal_event = (
        await db.execute(
            select(CalendarEvent)
            .where(CalendarEvent.user_id == user_id, CalendarEvent.session_id == session.id)
            .limit(1)
        )
    ).scalars().first()
    if cal_event is None or not cal_event.google_event_id:
        return

    event_id = cal_event.google_event_id
    try:
        await asyncio.to_thread(_sync_delete_event, cred.refresh_token, event_id)
    except Exception:  # noqa: BLE001 — best-effort; still clear the local id below
        logger.warning("google_calendar: delete_session_event failed for user %s", user_id, exc_info=True)
    try:
        cal_event.google_event_id = None
        cal_event.google_synced_at = None
        await db.commit()
    except Exception:  # noqa: BLE001
        await db.rollback()
        logger.warning("google_calendar: clearing google_event_id failed for user %s", user_id, exc_info=True)
