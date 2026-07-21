"""Tests for the server-side Google Calendar sync feature.

Covers:
  * /connect exchanges the OAuth code (httpx mocked), requires the
    calendar.events scope, and stores an ENCRYPTED refresh token (raw plaintext
    never present in the DB column).
  * /status reflects connected/disconnected + google_email.
  * /disconnect deletes the credential row (revoke mocked).
  * Negative-auth (401) on all three endpoints.
  * push_session_event: create-then-update stores google_event_id; find-or-create
    of the CalendarEvent row; uses an existing row in place; delete clears the id.
  * Flag OFF / not configured / no credential → silent no-op, Google client is
    NEVER built.
  * Best-effort: a raising Google client never fails accept / confirm / cancel.

The Google API client is mocked by patching the service's ``_build_calendar_service``
so no test ever touches the network.
"""

from __future__ import annotations

import base64
import json
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock
from uuid import UUID

from httpx import AsyncClient
from sqlalchemy import select, text

from app.config import settings
from app.models.calendar import CalendarEvent
from app.models.google_calendar import GoogleCalendarCredential
from app.models.request import ServiceRequest
from app.models.session import Session
from app.models.user import User
from app.services import google_calendar
from tests.conftest import auth_header
from tests.conftest import test_session as _db_session_factory

CAL_SCOPE = google_calendar.CALENDAR_EVENTS_SCOPE
STATUS_URL = "/api/v1/integrations/google-calendar/status"
CONNECT_URL = "/api/v1/integrations/google-calendar/connect"
DISCONNECT_URL = "/api/v1/integrations/google-calendar/disconnect"


# ─── helpers ─────────────────────────────────────────────────────────────────


def _sub(tokens: dict) -> str:
    """Decode the user id (sub) out of a Compass access token."""
    payload_b64 = tokens["access_token"].split(".")[1]
    padded = payload_b64 + "=" * (-len(payload_b64) % 4)
    return str(UUID(json.loads(base64.urlsafe_b64decode(padded).decode())["sub"]))


def _fake_id_token(email: str) -> str:
    """Build an (unsigned) JWT whose payload carries an email claim."""
    def _seg(obj: dict) -> str:
        raw = json.dumps(obj).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    return f"{_seg({'alg': 'RS256'})}.{_seg({'email': email})}.sig"


def _enable_sync(monkeypatch) -> None:
    """Turn on the flag AND set client id/secret so is_google_calendar_configured."""
    monkeypatch.setattr(settings, "google_calendar_sync_enabled", True)
    monkeypatch.setattr(settings, "google_oauth_client_id", "test-client-id.apps.googleusercontent.com")
    monkeypatch.setattr(settings, "google_oauth_client_secret", "test-client-secret")


def _fake_httpx(monkeypatch, *, token_payload: dict | None, status_code: int = 200) -> None:
    """Patch httpx.AsyncClient used by the service so the token/revoke POSTs are mocked."""

    class _FakeResp:
        def __init__(self) -> None:
            self.status_code = status_code

        def json(self) -> dict:
            if token_payload is None:
                raise ValueError("no body")
            return token_payload

    class _FakeClient:
        def __init__(self, *a, **k) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, data=None):
            return _FakeResp()

    monkeypatch.setattr(google_calendar.httpx, "AsyncClient", _FakeClient)


async def _seed_session(*, scheduling_status: str | None = "pending", with_calendar_events: bool = False):
    """Seed chw + member + request + session directly. Returns (chw_id, member_id, session_id)."""
    chw_id = uuid.uuid4()
    member_id = uuid.uuid4()
    async with _db_session_factory() as db:
        db.add_all([
            User(id=chw_id, email=f"chw-{chw_id}@ex.com", role="chw", name="Casey Worker"),
            User(id=member_id, email=f"mbr-{member_id}@ex.com", role="member", name="Morgan Member"),
        ])
        await db.flush()
        req = ServiceRequest(
            member_id=member_id,
            matched_chw_id=chw_id,
            vertical="housing",
            verticals=["housing"],
            urgency="routine",
            description="seed",
            preferred_mode="phone",
            status="matched",
        )
        db.add(req)
        await db.flush()
        scheduled_at = datetime.now(UTC) + timedelta(days=1)
        session = Session(
            request_id=req.id,
            chw_id=chw_id,
            member_id=member_id,
            vertical="housing",
            mode="phone",
            scheduled_at=scheduled_at,
            scheduling_status=scheduling_status,
            status="scheduled",
        )
        db.add(session)
        await db.flush()
        if with_calendar_events:
            db.add_all([
                CalendarEvent(
                    user_id=chw_id, session_id=session.id, title="Session with Morgan",
                    date=scheduled_at.date(), start_time=scheduled_at.time(),
                    end_time=(scheduled_at + timedelta(minutes=30)).time(),
                    vertical="housing", event_type="session",
                ),
                CalendarEvent(
                    user_id=member_id, session_id=session.id, title="Session with Casey",
                    date=scheduled_at.date(), start_time=scheduled_at.time(),
                    end_time=(scheduled_at + timedelta(minutes=30)).time(),
                    vertical="housing", event_type="session",
                ),
            ])
        session_id = session.id
        await db.commit()
    return chw_id, member_id, session_id


async def _seed_credential(user_id, *, refresh_token: str = "refresh-tok-secret", email: str | None = None) -> None:  # noqa: S107
    async with _db_session_factory() as db:
        db.add(GoogleCalendarCredential(user_id=user_id, refresh_token=refresh_token, scope=CAL_SCOPE, google_email=email))
        await db.commit()


def _fake_service_with_ids(insert_id: str = "evt_new", patch_id: str = "evt_new") -> MagicMock:
    svc = MagicMock(name="calendar_service")
    svc.events.return_value.insert.return_value.execute.return_value = {"id": insert_id}
    svc.events.return_value.patch.return_value.execute.return_value = {"id": patch_id}
    svc.events.return_value.delete.return_value.execute.return_value = {}
    return svc


# ─── /status ─────────────────────────────────────────────────────────────────


async def test_status_requires_auth(client: AsyncClient):
    res = await client.get(STATUS_URL)
    assert res.status_code in (401, 403)


async def test_status_not_connected(client: AsyncClient, member_tokens: dict):
    res = await client.get(STATUS_URL, headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
    assert res.json() == {"connected": False, "google_email": None}


async def test_status_connected_reflects_email(client: AsyncClient, member_tokens: dict):
    await _seed_credential(UUID(_sub(member_tokens)), email="morgan@gmail.com")
    res = await client.get(STATUS_URL, headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
    assert res.json() == {"connected": True, "google_email": "morgan@gmail.com"}


# ─── /connect ────────────────────────────────────────────────────────────────


async def test_connect_requires_auth(client: AsyncClient):
    res = await client.post(CONNECT_URL, json={"code": "x", "redirect_uri": "https://app/cb"})
    assert res.status_code in (401, 403)


async def test_connect_not_configured_returns_400(client: AsyncClient, member_tokens: dict, monkeypatch):
    # Flag/secret unset (default) → is_google_calendar_configured is False.
    monkeypatch.setattr(settings, "google_oauth_client_secret", "")
    res = await client.post(
        CONNECT_URL, json={"code": "x", "redirect_uri": "https://app/cb"}, headers=auth_header(member_tokens)
    )
    assert res.status_code == 400, res.text
    assert "not configured" in res.json()["detail"].lower()


async def test_connect_stores_encrypted_refresh_token(client: AsyncClient, member_tokens: dict, monkeypatch):
    _enable_sync(monkeypatch)
    raw_refresh = "1//super-secret-refresh-token-value"
    _fake_httpx(
        monkeypatch,
        token_payload={
            "access_token": "at",
            "refresh_token": raw_refresh,
            "scope": f"openid email {CAL_SCOPE}",
            "id_token": _fake_id_token("morgan@gmail.com"),
        },
    )
    res = await client.post(
        CONNECT_URL,
        json={"code": "auth-code", "redirect_uri": "https://app/cb"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json() == {"connected": True}

    member_id = UUID(_sub(member_tokens))
    async with _db_session_factory() as db:
        # ORM read decrypts → plaintext round-trips.
        cred = (
            await db.execute(select(GoogleCalendarCredential).where(GoogleCalendarCredential.user_id == member_id))
        ).scalar_one()
        assert cred.refresh_token == raw_refresh
        assert cred.google_email == "morgan@gmail.com"
        assert CAL_SCOPE in (cred.scope or "")
        # Raw column value must be ciphertext, NOT the plaintext token.
        raw_col = (
            await db.execute(
                text("SELECT refresh_token FROM google_calendar_credentials WHERE user_id = :uid"),
                {"uid": str(member_id)},
            )
        ).scalar_one()
        assert raw_col != raw_refresh
        assert raw_refresh not in raw_col

    # /status now reflects it.
    status_res = await client.get(STATUS_URL, headers=auth_header(member_tokens))
    assert status_res.json() == {"connected": True, "google_email": "morgan@gmail.com"}


async def test_connect_passes_redirect_uri_verbatim_to_token_exchange(client: AsyncClient, member_tokens: dict, monkeypatch):
    """The GIS popup auth-code flow fixes redirect_uri to the literal 'postmessage';
    /connect MUST echo it unmodified in the Google token exchange, else Google
    returns redirect_uri_mismatch."""
    _enable_sync(monkeypatch)
    captured: dict = {}

    class _FakeResp:
        status_code = 200

        def json(self) -> dict:
            return {"refresh_token": "rt", "scope": CAL_SCOPE, "id_token": _fake_id_token("m@gmail.com")}

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, data=None):
            captured["url"] = url
            captured["data"] = data
            return _FakeResp()

    monkeypatch.setattr(google_calendar.httpx, "AsyncClient", _FakeClient)
    res = await client.post(
        CONNECT_URL, json={"code": "auth-code", "redirect_uri": "postmessage"}, headers=auth_header(member_tokens)
    )
    assert res.status_code == 200, res.text
    assert captured["url"] == google_calendar.GOOGLE_TOKEN_URL
    assert captured["data"]["redirect_uri"] == "postmessage"
    assert captured["data"]["grant_type"] == "authorization_code"
    assert captured["data"]["code"] == "auth-code"


async def test_connect_missing_calendar_scope_returns_400(client: AsyncClient, member_tokens: dict, monkeypatch):
    _enable_sync(monkeypatch)
    _fake_httpx(
        monkeypatch,
        token_payload={"refresh_token": "rt", "scope": "openid email", "id_token": _fake_id_token("m@gmail.com")},
    )
    res = await client.post(
        CONNECT_URL, json={"code": "c", "redirect_uri": "https://app/cb"}, headers=auth_header(member_tokens)
    )
    assert res.status_code == 400, res.text
    assert "permission" in res.json()["detail"].lower()
    # No credential stored.
    async with _db_session_factory() as db:
        assert (await db.execute(select(GoogleCalendarCredential))).first() is None


async def test_connect_missing_refresh_token_returns_400(client: AsyncClient, member_tokens: dict, monkeypatch):
    _enable_sync(monkeypatch)
    _fake_httpx(monkeypatch, token_payload={"access_token": "at", "scope": f"openid {CAL_SCOPE}"})
    res = await client.post(
        CONNECT_URL, json={"code": "c", "redirect_uri": "https://app/cb"}, headers=auth_header(member_tokens)
    )
    assert res.status_code == 400, res.text
    assert "refresh token" in res.json()["detail"].lower()


async def test_connect_exchange_http_failure_returns_400(client: AsyncClient, member_tokens: dict, monkeypatch):
    _enable_sync(monkeypatch)
    _fake_httpx(monkeypatch, token_payload={"error": "invalid_grant"}, status_code=400)
    res = await client.post(
        CONNECT_URL, json={"code": "bad", "redirect_uri": "https://app/cb"}, headers=auth_header(member_tokens)
    )
    assert res.status_code == 400, res.text
    assert "exchange" in res.json()["detail"].lower()


async def test_connect_reconnect_upserts_single_row(client: AsyncClient, member_tokens: dict, monkeypatch):
    _enable_sync(monkeypatch)
    member_id = UUID(_sub(member_tokens))
    await _seed_credential(member_id, refresh_token="old", email="old@gmail.com")
    _fake_httpx(
        monkeypatch,
        token_payload={
            "refresh_token": "new-token",
            "scope": f"openid {CAL_SCOPE}",
            "id_token": _fake_id_token("new@gmail.com"),
        },
    )
    res = await client.post(
        CONNECT_URL, json={"code": "c", "redirect_uri": "https://app/cb"}, headers=auth_header(member_tokens)
    )
    assert res.status_code == 200, res.text
    async with _db_session_factory() as db:
        rows = (await db.execute(select(GoogleCalendarCredential).where(GoogleCalendarCredential.user_id == member_id))).scalars().all()
        assert len(rows) == 1
        assert rows[0].refresh_token == "new-token"
        assert rows[0].google_email == "new@gmail.com"


# ─── /disconnect ─────────────────────────────────────────────────────────────


async def test_disconnect_requires_auth(client: AsyncClient):
    res = await client.post(DISCONNECT_URL)
    assert res.status_code in (401, 403)


async def test_disconnect_deletes_credential(client: AsyncClient, member_tokens: dict, monkeypatch):
    member_id = UUID(_sub(member_tokens))
    await _seed_credential(member_id, email="m@gmail.com")
    _fake_httpx(monkeypatch, token_payload={})  # revoke POST mocked
    res = await client.post(DISCONNECT_URL, headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
    assert res.json() == {"connected": False}
    async with _db_session_factory() as db:
        assert (await db.execute(select(GoogleCalendarCredential).where(GoogleCalendarCredential.user_id == member_id))).first() is None


async def test_disconnect_idempotent_when_not_connected(client: AsyncClient, member_tokens: dict):
    res = await client.post(DISCONNECT_URL, headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
    assert res.json() == {"connected": False}


# ─── email_from_id_token unit ────────────────────────────────────────────────


def test_email_from_id_token_extracts_claim():
    assert google_calendar.email_from_id_token(_fake_id_token("A@Gmail.com")) == "a@gmail.com"


def test_email_from_id_token_handles_bad_input():
    assert google_calendar.email_from_id_token(None) is None
    assert google_calendar.email_from_id_token("") is None
    assert google_calendar.email_from_id_token("not-a-jwt") is None
    assert google_calendar.email_from_id_token("a.b.c") is None  # non-base64 payload


# ─── push_session_event ──────────────────────────────────────────────────────


async def test_push_creates_then_updates_and_stores_event_id(monkeypatch):
    _enable_sync(monkeypatch)
    chw_id, member_id, session_id = await _seed_session()  # no CalendarEvent row → find-or-create
    await _seed_credential(chw_id)
    fake_service = _fake_service_with_ids(insert_id="evt_123")
    monkeypatch.setattr(google_calendar, "_build_calendar_service", lambda rt: fake_service)

    async with _db_session_factory() as db:
        session = await db.get(Session, session_id)
        await google_calendar.push_session_event(db, session=session, user_id=chw_id)

    # Inserted (created), stored google_event_id on a (created) CalendarEvent row.
    fake_service.events.return_value.insert.assert_called_once()
    fake_service.events.return_value.patch.assert_not_called()
    async with _db_session_factory() as db:
        row = (
            await db.execute(select(CalendarEvent).where(CalendarEvent.user_id == chw_id, CalendarEvent.session_id == session_id))
        ).scalar_one()
        assert row.google_event_id == "evt_123"
        assert row.google_synced_at is not None

    # Second push → PATCH the existing event, not insert again.
    fake_service.events.reset_mock()
    async with _db_session_factory() as db:
        session = await db.get(Session, session_id)
        await google_calendar.push_session_event(db, session=session, user_id=chw_id)
    fake_service.events.return_value.patch.assert_called_once()
    _, kwargs = fake_service.events.return_value.patch.call_args
    assert kwargs["eventId"] == "evt_123"
    fake_service.events.return_value.insert.assert_not_called()


async def test_push_updates_existing_calendar_event_row_in_place(monkeypatch):
    _enable_sync(monkeypatch)
    chw_id, member_id, session_id = await _seed_session(with_calendar_events=True)
    await _seed_credential(member_id)
    fake_service = _fake_service_with_ids(insert_id="evt_abc")
    monkeypatch.setattr(google_calendar, "_build_calendar_service", lambda rt: fake_service)

    async with _db_session_factory() as db:
        session = await db.get(Session, session_id)
        await google_calendar.push_session_event(db, session=session, user_id=member_id)

    async with _db_session_factory() as db:
        rows = (
            await db.execute(select(CalendarEvent).where(CalendarEvent.user_id == member_id, CalendarEvent.session_id == session_id))
        ).scalars().all()
        assert len(rows) == 1  # no duplicate row created
        assert rows[0].google_event_id == "evt_abc"


async def test_push_is_noop_when_flag_off(monkeypatch):
    # Configured but master flag OFF → client never built.
    monkeypatch.setattr(settings, "google_calendar_sync_enabled", False)
    monkeypatch.setattr(settings, "google_oauth_client_id", "cid")
    monkeypatch.setattr(settings, "google_oauth_client_secret", "sec")
    chw_id, member_id, session_id = await _seed_session()
    await _seed_credential(chw_id)
    build_spy = MagicMock()
    monkeypatch.setattr(google_calendar, "_build_calendar_service", build_spy)
    async with _db_session_factory() as db:
        session = await db.get(Session, session_id)
        await google_calendar.push_session_event(db, session=session, user_id=chw_id)
    build_spy.assert_not_called()


async def test_push_is_noop_when_not_configured(monkeypatch):
    monkeypatch.setattr(settings, "google_calendar_sync_enabled", True)
    monkeypatch.setattr(settings, "google_oauth_client_secret", "")  # secret missing
    chw_id, member_id, session_id = await _seed_session()
    await _seed_credential(chw_id)
    build_spy = MagicMock()
    monkeypatch.setattr(google_calendar, "_build_calendar_service", build_spy)
    async with _db_session_factory() as db:
        session = await db.get(Session, session_id)
        await google_calendar.push_session_event(db, session=session, user_id=chw_id)
    build_spy.assert_not_called()


async def test_push_is_noop_without_credential(monkeypatch):
    _enable_sync(monkeypatch)
    chw_id, member_id, session_id = await _seed_session()  # no credential seeded
    build_spy = MagicMock()
    monkeypatch.setattr(google_calendar, "_build_calendar_service", build_spy)
    async with _db_session_factory() as db:
        session = await db.get(Session, session_id)
        await google_calendar.push_session_event(db, session=session, user_id=chw_id)
    build_spy.assert_not_called()


async def test_push_swallows_raising_google_client(monkeypatch):
    _enable_sync(monkeypatch)
    chw_id, member_id, session_id = await _seed_session()
    await _seed_credential(chw_id)

    def _boom(rt):
        raise RuntimeError("google down")

    monkeypatch.setattr(google_calendar, "_build_calendar_service", _boom)
    async with _db_session_factory() as db:
        session = await db.get(Session, session_id)
        # Must not raise.
        await google_calendar.push_session_event(db, session=session, user_id=chw_id)


# ─── delete_session_event ────────────────────────────────────────────────────


async def test_delete_clears_stored_event_id(monkeypatch):
    _enable_sync(monkeypatch)
    chw_id, member_id, session_id = await _seed_session(with_calendar_events=True)
    await _seed_credential(chw_id)
    # Pre-store a google_event_id on the chw's calendar row.
    async with _db_session_factory() as db:
        row = (
            await db.execute(select(CalendarEvent).where(CalendarEvent.user_id == chw_id, CalendarEvent.session_id == session_id))
        ).scalar_one()
        row.google_event_id = "evt_del"
        row.google_synced_at = datetime.now(UTC)
        await db.commit()

    fake_service = _fake_service_with_ids()
    monkeypatch.setattr(google_calendar, "_build_calendar_service", lambda rt: fake_service)
    async with _db_session_factory() as db:
        session = await db.get(Session, session_id)
        await google_calendar.delete_session_event(db, session=session, user_id=chw_id)

    fake_service.events.return_value.delete.assert_called_once()
    _, kwargs = fake_service.events.return_value.delete.call_args
    assert kwargs["eventId"] == "evt_del"
    async with _db_session_factory() as db:
        row = (
            await db.execute(select(CalendarEvent).where(CalendarEvent.user_id == chw_id, CalendarEvent.session_id == session_id))
        ).scalar_one()
        assert row.google_event_id is None
        assert row.google_synced_at is None


async def test_delete_is_noop_without_stored_event_id(monkeypatch):
    _enable_sync(monkeypatch)
    chw_id, member_id, session_id = await _seed_session(with_calendar_events=True)
    await _seed_credential(chw_id)
    build_spy = MagicMock()
    monkeypatch.setattr(google_calendar, "_build_calendar_service", build_spy)
    async with _db_session_factory() as db:
        session = await db.get(Session, session_id)
        await google_calendar.delete_session_event(db, session=session, user_id=chw_id)
    build_spy.assert_not_called()


async def test_delete_swallows_raising_google_client_and_still_clears(monkeypatch):
    _enable_sync(monkeypatch)
    chw_id, member_id, session_id = await _seed_session(with_calendar_events=True)
    await _seed_credential(chw_id)
    async with _db_session_factory() as db:
        row = (
            await db.execute(select(CalendarEvent).where(CalendarEvent.user_id == chw_id, CalendarEvent.session_id == session_id))
        ).scalar_one()
        row.google_event_id = "evt_x"
        await db.commit()

    def _boom(rt):
        raise RuntimeError("google down")

    monkeypatch.setattr(google_calendar, "_build_calendar_service", _boom)
    async with _db_session_factory() as db:
        session = await db.get(Session, session_id)
        await google_calendar.delete_session_event(db, session=session, user_id=chw_id)  # must not raise
    async with _db_session_factory() as db:
        row = (
            await db.execute(select(CalendarEvent).where(CalendarEvent.user_id == chw_id, CalendarEvent.session_id == session_id))
        ).scalar_one()
        assert row.google_event_id is None  # cleared locally despite revoke failure


# ─── Best-effort lifecycle hooks (end-to-end) ────────────────────────────────


async def _establish_relationship(client: AsyncClient, member_tokens: dict, chw_tokens: dict) -> str:
    res = await client.post(
        "/api/v1/requests/",
        json={"vertical": "housing", "urgency": "routine", "description": "help", "preferred_mode": "phone"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]
    res = await client.patch(f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens))
    assert res.status_code == 200, res.text
    return res.json()["session_id"]


async def test_accept_request_succeeds_when_google_client_raises(client: AsyncClient, member_tokens: dict, chw_tokens: dict, monkeypatch):
    _enable_sync(monkeypatch)
    await _seed_credential(UUID(_sub(member_tokens)))
    await _seed_credential(UUID(_sub(chw_tokens)))

    def _boom(rt):
        raise RuntimeError("google down")

    monkeypatch.setattr(google_calendar, "_build_calendar_service", _boom)
    # accept happens inside — the raising push hook must not fail it.
    session_id = await _establish_relationship(client, member_tokens, chw_tokens)
    assert session_id


async def test_accept_request_flag_off_never_builds_client(client: AsyncClient, member_tokens: dict, chw_tokens: dict, monkeypatch):
    # Flag OFF by default. Seed credentials anyway; the hook must still no-op.
    await _seed_credential(UUID(_sub(member_tokens)))
    await _seed_credential(UUID(_sub(chw_tokens)))
    build_spy = MagicMock()
    monkeypatch.setattr(google_calendar, "_build_calendar_service", build_spy)
    await _establish_relationship(client, member_tokens, chw_tokens)
    build_spy.assert_not_called()


async def test_cancel_session_succeeds_when_google_client_raises(client: AsyncClient, member_tokens: dict, chw_tokens: dict, monkeypatch):
    session_id = await _establish_relationship(client, member_tokens, chw_tokens)
    _enable_sync(monkeypatch)
    await _seed_credential(UUID(_sub(member_tokens)))

    def _boom(rt):
        raise RuntimeError("google down")

    monkeypatch.setattr(google_calendar, "_build_calendar_service", _boom)
    res = await client.patch(f"/api/v1/sessions/{session_id}/cancel", headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text


async def test_confirm_session_succeeds_when_google_client_raises(client: AsyncClient, member_tokens: dict, chw_tokens: dict, monkeypatch):
    session_id = await _establish_relationship(client, member_tokens, chw_tokens)
    _enable_sync(monkeypatch)
    await _seed_credential(UUID(_sub(chw_tokens)))

    def _boom(rt):
        raise RuntimeError("google down")

    monkeypatch.setattr(google_calendar, "_build_calendar_service", _boom)
    # accept leaves proposed_by=None → the CHW may confirm a legacy-null session.
    res = await client.patch(f"/api/v1/sessions/{session_id}/confirm", headers=auth_header(chw_tokens))
    assert res.status_code == 200, res.text


async def test_schedule_session_pushes_to_google(client: AsyncClient, member_tokens: dict, chw_tokens: dict, monkeypatch):
    """The CHW 'Propose New Time' / schedule flow triggers a Google push for both
    participants (create-or-update path)."""
    await _establish_relationship(client, member_tokens, chw_tokens)
    _enable_sync(monkeypatch)
    chw_id = UUID(_sub(chw_tokens))
    await _seed_credential(chw_id)
    fake_service = _fake_service_with_ids(insert_id="evt_sched")
    monkeypatch.setattr(google_calendar, "_build_calendar_service", lambda rt: fake_service)

    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": _sub(member_tokens),
            "scheduled_at": (datetime.now(UTC) + timedelta(days=2)).isoformat(),
            "mode": "phone",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    # The CHW has a connected calendar → the event was created for them.
    fake_service.events.return_value.insert.assert_called()
    new_session_id = res.json()["id"]
    async with _db_session_factory() as db:
        row = (
            await db.execute(
                select(CalendarEvent).where(
                    CalendarEvent.user_id == chw_id, CalendarEvent.session_id == UUID(new_session_id)
                )
            )
        ).scalar_one()
        assert row.google_event_id == "evt_sched"


async def test_no_show_deletes_google_event(client: AsyncClient, member_tokens: dict, chw_tokens: dict, monkeypatch):
    """Marking a session no-show removes the mirrored Google event for both parties."""
    from tests.test_sessions import _create_in_progress_session

    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)
    _enable_sync(monkeypatch)
    chw_id = UUID(_sub(chw_tokens))
    await _seed_credential(chw_id)
    # Seed a CalendarEvent w/ a stored google id for the CHW on this session.
    async with _db_session_factory() as db:
        db.add(
            CalendarEvent(
                user_id=chw_id, session_id=UUID(session_id), title="Session",
                date=datetime.now(UTC).date(), event_type="session",
                google_event_id="evt_noshow",
            )
        )
        await db.commit()
    fake_service = _fake_service_with_ids()
    monkeypatch.setattr(google_calendar, "_build_calendar_service", lambda rt: fake_service)

    res = await client.patch(f"/api/v1/sessions/{session_id}/no-show", headers=auth_header(chw_tokens))
    assert res.status_code == 200, res.text
    fake_service.events.return_value.delete.assert_called_once()
    async with _db_session_factory() as db:
        row = (
            await db.execute(
                select(CalendarEvent).where(
                    CalendarEvent.user_id == chw_id, CalendarEvent.session_id == UUID(session_id)
                )
            )
        ).scalar_one()
        assert row.google_event_id is None


async def test_hook_except_branch_swallows_push_error(client: AsyncClient, member_tokens: dict, chw_tokens: dict, monkeypatch):
    """If push_session_event itself raises, the accept hook's guard swallows it —
    covers the hook's own except branch, not just the service's."""
    _enable_sync(monkeypatch)

    async def _raise(*a, **k):
        raise RuntimeError("unexpected push failure")

    monkeypatch.setattr(google_calendar, "push_session_event", _raise)
    session_id = await _establish_relationship(client, member_tokens, chw_tokens)
    assert session_id


async def test_hook_except_branch_swallows_delete_error(client: AsyncClient, member_tokens: dict, chw_tokens: dict, monkeypatch):
    """If delete_session_event raises, the cancel hook's guard swallows it."""
    session_id = await _establish_relationship(client, member_tokens, chw_tokens)
    _enable_sync(monkeypatch)

    async def _raise(*a, **k):
        raise RuntimeError("unexpected delete failure")

    monkeypatch.setattr(google_calendar, "delete_session_event", _raise)
    res = await client.patch(f"/api/v1/sessions/{session_id}/cancel", headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
