# Google Calendar sync — design + go-live runbook

**Status:** Backend shipped, flagged OFF. External Google Cloud config + flag flip pending.
**Date:** 2026-07-21
**Scope:** Backend only (`backend/`). Frontend connect UI ships separately (PR #247).

## Summary

One-way, server-side push of Compass session events into each connected user's
**primary Google Calendar**. Compass stores a per-user encrypted Google OAuth
**refresh token**, mints access tokens from it on demand, and creates / updates /
deletes a calendar event as the session's lifecycle changes. Sync is **best-effort**
— a Google failure never fails the underlying session mutation — and the whole
feature is a **silent no-op** until it is fully configured and the flag is flipped.

Direction is Compass → Google only. Changes made directly in Google Calendar are
NOT read back.

## Why server-side push (vs. read/2-way)

- Members and CHWs want their Compass appointments to show up on the calendar they
  already live in, with reminders. That only needs write access.
- 2-way sync (watching Google for edits) adds webhooks, channel renewals, and
  conflict resolution for little MVP value.
- Server-side (a stored refresh token) means events appear even when the app isn't
  open, and it reuses the existing Google OAuth client already used for sign-in.

## Data model

**New table `google_calendar_credentials`** (one row per user, `UNIQUE user_id`,
`ON DELETE CASCADE`):

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `user_id` | uuid FK users.id, UNIQUE, NOT NULL | at most one connected calendar per user |
| `refresh_token` | `EncryptedString` (String(512)) NOT NULL | AES-256-GCM at rest |
| `scope` | String(255) | granted scopes (space-delimited) |
| `google_email` | String(255) NULL | connected Google account, for the "Connected as…" UI |
| `connected_at` | timestamptz | |
| `updated_at` | timestamptz | |

**`calendar_events` new columns** (both nullable, no backfill):
- `google_event_id String(255)` — the id of the mirrored event on the user's
  primary Google calendar (used to PATCH/DELETE it).
- `google_synced_at timestamptz` — last successful push.

**Migration:** `gcalsync0721` (down_revision `chw2fa0715`). Single head afterward.

## Config (`app/config.py`)

- `google_oauth_client_secret: str = ""` — Web OAuth client secret (needed for the
  code exchange and refresh-token → access-token mint). Separate from Apple's key.
- `google_calendar_sync_enabled: bool = False` — master kill-switch.
- `is_google_calendar_configured` (property) — `bool(client_id and client_secret)`.

App boot is **never** gated on these — an unset secret just keeps the feature inert.

## API contract (`/api/v1/integrations/google-calendar`)

All three require an authenticated Compass user (member or CHW); unauthenticated →
401.

- `GET /status` → `{ "connected": bool, "google_email": string | null }`
- `POST /connect` body `{ "code": string, "redirect_uri": string }` →
  `{ "connected": true }`
  - Exchanges `code` at `https://oauth2.googleapis.com/token` (grant_type=
    authorization_code), passing `redirect_uri` **verbatim** (the GIS popup
    auth-code flow fixes it to the literal string `"postmessage"` — do NOT
    normalize it, or Google returns `redirect_uri_mismatch`).
  - Requires the granted `scope` to include
    `https://www.googleapis.com/auth/calendar.events`.
  - Requires a `refresh_token` in the response (frontend must request
    `access_type=offline` + consent).
  - Upserts the credential (encrypted refresh token + `google_email` from the
    id_token). Returns 400 if not configured / exchange fails / missing calendar
    scope / no refresh token.
- `POST /disconnect` → `{ "connected": false }`
  - Best-effort revoke at `https://oauth2.googleapis.com/revoke`, then deletes the
    credential row. Idempotent.

## Sync service (`app/services/google_calendar.py`)

- `push_session_event(db, *, session, user_id)` — create-or-update. Reads the
  user's `CalendarEvent` for the session; PATCHes if `google_event_id` is set,
  else INSERTs and stores the id + `google_synced_at`. When no `CalendarEvent`
  row exists (e.g. the `POST /sessions/schedule` path), one is created to hold the
  id (`calendar_events` is not rendered directly, so this is invisible).
- `delete_session_event(db, *, session, user_id)` — deletes the Google event when
  an id is stored and clears the local id.

Event shape (no PHI beyond a first name):
- summary: `Compass session with {other party first name}` + ` (pending)` until
  `scheduling_status == "confirmed"`.
- start/end: `session.scheduled_at` → `scheduled_end_at` (or +30 min).
- description: a static "Compass CHW session, managed by the app" note.

Every call is gated on `google_calendar_sync_enabled AND is_google_calendar_configured
AND the user having a credential`; otherwise it returns before building any Google
client or touching the network. The synchronous google-api-python-client runs in a
threadpool (`asyncio.to_thread`). Nothing raises — the network call happens before
any DB write, so a Google failure never rolls back the caller's transaction.

## Lifecycle hooks (all best-effort, mirror the SMS/notify fan-out)

| Handler | Action |
| --- | --- |
| `requests.py accept_request` | push for CHW + member (after the two CalendarEvent rows) |
| `sessions.py confirm_session` | push for both (title flips to confirmed) |
| `sessions.py schedule_session` | push for both (reschedule / "Propose New Time") |
| `sessions.py cancel_session` | delete for both |
| `sessions.py mark_session_no_show` | delete for both |

Each is wrapped in `try/except` and never fails the mutation.

## External go-live runbook (Akram — do these to turn it on)

1. **Google Cloud Console → APIs & Services → OAuth consent screen**
   - Add the scope `https://www.googleapis.com/auth/calendar.events` (a
     sensitive scope) to the consent screen.
   - **PUBLISH** the consent screen (moving it out of "Testing"). Sensitive scopes
     on an unpublished app only work for test users; a published app may require
     Google verification for the sensitive scope — start that review early.
   - Enable the **Google Calendar API** for the project (APIs & Services → Library).
2. **Credentials**: on the existing **Web application** OAuth 2.0 Client, copy the
   **client secret**. (The client id is already `GOOGLE_OAUTH_CLIENT_ID`.)
3. **Backend env / SSM**: set `GOOGLE_OAUTH_CLIENT_SECRET=<the secret>` in the
   backend `.env` (and prod SSM). At this point `is_google_calendar_configured`
   becomes true but sync is still OFF.
4. **Flip the flag**: set `GOOGLE_CALENDAR_SYNC_ENABLED=true`. Sync now runs for any
   user who has connected their calendar.
5. **Verify**: connect a test account via the frontend, accept/schedule a session,
   confirm the event appears on that Google Calendar; cancel it and confirm the
   event is removed.

Rollback: set `GOOGLE_CALENDAR_SYNC_ENABLED=false` (all hooks immediately no-op);
existing Google events are left in place. No migration rollback needed.

## Security notes

- Only the refresh token is persisted, encrypted (AES-256-GCM via `EncryptedString`).
  Access tokens are minted on demand and never stored.
- The token endpoint response body is never logged verbatim (it echoes the code /
  tokens); only HTTP status is logged on failure.
- No PHI beyond the other participant's first name is written to Google.
- `disconnect` best-effort revokes the token at Google before deleting the row.
