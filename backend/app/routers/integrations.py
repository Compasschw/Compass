"""User-facing third-party integration endpoints.

Currently: Google Calendar connect/disconnect/status for the server-side,
one-way calendar-sync feature (see ``app.services.google_calendar``). The
frontend runs the Google OAuth consent flow (requesting the
``calendar.events`` scope with offline access), receives an authorization
``code``, and POSTs it here; the backend performs the code exchange, stores the
encrypted refresh token, and thereafter pushes session events to the user's
primary Google Calendar.

All three endpoints require an authenticated Compass user (member or CHW). The
credential is per-user and never shared.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.models.google_calendar import GoogleCalendarCredential
from app.services import google_calendar

logger = logging.getLogger("compass.integrations")

router = APIRouter(
    prefix="/api/v1/integrations/google-calendar",
    tags=["integrations"],
)


# ─── Schemas ─────────────────────────────────────────────────────────────────


class GoogleCalendarStatusResponse(BaseModel):
    """Whether the caller has a connected Google Calendar."""

    connected: bool
    google_email: str | None = None


class GoogleCalendarConnectRequest(BaseModel):
    """OAuth authorization code + the redirect URI it was obtained with."""

    code: str = Field(..., min_length=1, description="Google OAuth authorization code")
    redirect_uri: str = Field(..., min_length=1, description="Redirect URI used to obtain the code")


class GoogleCalendarConnectResponse(BaseModel):
    connected: bool


# ─── Endpoints ───────────────────────────────────────────────────────────────


@router.get("/status", response_model=GoogleCalendarStatusResponse)
async def google_calendar_status(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> GoogleCalendarStatusResponse:
    """Return whether the authenticated user has connected their Google Calendar."""
    cred = (
        await db.execute(
            select(GoogleCalendarCredential).where(GoogleCalendarCredential.user_id == current_user.id).limit(1)
        )
    ).scalars().first()
    if cred is None:
        return GoogleCalendarStatusResponse(connected=False, google_email=None)
    return GoogleCalendarStatusResponse(connected=True, google_email=cred.google_email)


@router.post("/connect", response_model=GoogleCalendarConnectResponse)
async def google_calendar_connect(
    data: GoogleCalendarConnectRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> GoogleCalendarConnectResponse:
    """Connect the authenticated user's Google Calendar.

    Exchanges the OAuth ``code`` for tokens, requires the granted ``scope`` to
    include ``calendar.events``, and upserts the (encrypted) refresh token.

    - 400 when the integration isn't configured, the exchange fails, no refresh
      token is returned, or the calendar.events scope was not granted.
    - 401 when unauthenticated (via ``get_current_user``).
    """
    if not settings.is_google_calendar_configured:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Google Calendar integration is not configured on this server.",
        )

    tokens = await google_calendar.exchange_code_for_tokens(
        code=data.code, redirect_uri=data.redirect_uri
    )
    if tokens is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to exchange the authorization code with Google.",
        )

    granted_scope = tokens.get("scope") or ""
    if google_calendar.CALENDAR_EVENTS_SCOPE not in granted_scope.split():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The Google Calendar events permission was not granted.",
        )

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        # Google only returns a refresh token with access_type=offline +
        # prompt=consent. Without it we can't push events, so refuse to connect.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Google did not return a refresh token; retry with offline access consent.",
        )

    google_email = google_calendar.email_from_id_token(tokens.get("id_token"))

    # Upsert: one credential row per user (UNIQUE user_id).
    cred = (
        await db.execute(
            select(GoogleCalendarCredential).where(GoogleCalendarCredential.user_id == current_user.id).limit(1)
        )
    ).scalars().first()
    if cred is None:
        cred = GoogleCalendarCredential(
            user_id=current_user.id,
            refresh_token=refresh_token,
            scope=granted_scope[:255],
            google_email=google_email,
        )
        db.add(cred)
    else:
        cred.refresh_token = refresh_token
        cred.scope = granted_scope[:255]
        if google_email:
            cred.google_email = google_email
    await db.commit()

    return GoogleCalendarConnectResponse(connected=True)


@router.post("/disconnect", response_model=GoogleCalendarConnectResponse)
async def google_calendar_disconnect(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> GoogleCalendarConnectResponse:
    """Disconnect the authenticated user's Google Calendar.

    Best-effort revokes the refresh token at Google, then deletes the local
    credential row. Idempotent — returns ``{connected: false}`` even if there was
    nothing to disconnect.
    """
    cred = (
        await db.execute(
            select(GoogleCalendarCredential).where(GoogleCalendarCredential.user_id == current_user.id).limit(1)
        )
    ).scalars().first()
    if cred is not None:
        # Best-effort revoke before deleting our copy — a revoke failure must not
        # block disconnection.
        await google_calendar.revoke_refresh_token(cred.refresh_token)
        await db.delete(cred)
        await db.commit()

    return GoogleCalendarConnectResponse(connected=False)
