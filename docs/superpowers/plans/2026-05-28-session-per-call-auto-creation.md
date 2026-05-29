# Session-per-Call Auto-Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every CHW↔member call automatically create a new billable Session, so a single chat thread can host multiple billable calls over its lifetime instead of being locked to one Session forever (and Reassigning being the only way to start a new Session).

**Architecture:** Promote `Conversation` from a per-Session 1:1 sidecar into the canonical long-lived chat thread between a (chw, member) pair. Each call creates a new Session that belongs to that Conversation. The frontend's "End Session" / "Submit Documentation" buttons key off the conversation's *currently active* Session (if any), not the originally-clicked one. Roll out behind a settings flag (`session_per_call_enabled`) so call-bridge's new-session-creation behavior can be toggled per-environment.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.x async, Alembic, PostgreSQL 17, React Native (Expo) + TypeScript, TanStack Query.

---

## Design Decisions

These trade-offs are locked in. Don't relitigate during execution unless reality contradicts them.

1. **Conversation becomes the thread, not the Session.** Drop `UniqueConstraint("session_id")` on `conversations`. Add `Session.conversation_id` (FK → conversations.id, indexed). Each new call → new Session row sharing the conversation_id.
2. **`Session.request_id` stays NOT NULL.** Carry the originating `ServiceRequest.id` forward on every new Session in the same conversation. Preserves billing lineage; ServiceRequest is the audit anchor for "why this CHW met this member."
3. **"Active session" = the conversation's most recent Session with `status='in_progress'`.** If none, the conversation has no active session — End Session / Submit Doc buttons are hidden.
4. **At most one in_progress Session per conversation.** The existing "one active session per CHW" guard in `start_session` stays; we extend it to also reject creating a second in_progress Session for the same conversation.
5. **Documentation is per-Session, unchanged.** `SessionDocumentation.session_id UNIQUE` stays — each Session has one doc, each call gets its own doc.
6. **Billing claims are per-Session, unchanged.** One BillingClaim per Session; multiple calls in a thread → multiple claims.
7. **Flagged rollout.** `settings.session_per_call_enabled` gates the auto-create-on-call-bridge code path. Off → current behavior (call-bridge attaches CommunicationSession to the existing Session, no new Session created). On → call-bridge creates a fresh Session for any bridge after the prior Session is `completed`.
8. **No data is destroyed.** Backfill `Session.conversation_id` from the existing `Conversation.session_id` link; never drop or rewrite historical Sessions.
9. **`conversation.session_id` is preserved (deprecated, not removed).** Repurposed as "the originating Session" so we don't break code that still reads it during the rollout. Removal is a follow-up after the flag is on in prod.

---

## File Map

**Backend files to create:**
- `backend/alembic/versions/f6a7b8c9d0e1_session_per_call_conversation_link.py` — migration: drop unique constraint, add Session.conversation_id, backfill
- `backend/app/services/session_lookup.py` — helper module: `get_active_session_for_conversation`, `find_or_create_conversation_for_session`, `create_session_for_call_bridge`
- `backend/tests/test_session_per_call.py` — integration tests for the multi-call lifecycle

**Backend files to modify:**
- `backend/app/config.py` — add `session_per_call_enabled: bool = False`
- `backend/app/models/session.py` — add `conversation_id` mapped column to `Session`
- `backend/app/models/conversation.py` — drop `UniqueConstraint("session_id")` from `__table_args__`
- `backend/app/routers/communication.py` — call-bridge: when flag on and no active session, create a new Session
- `backend/app/routers/sessions.py` — extend `_get_or_create_session_conversation` to look up by (chw, member); extend `start_session` guard; surface `active_session_id` in conversation/thread responses
- `backend/app/routers/chw.py` — wherever the CHW inbox/thread list is served, include `active_session_id` per row
- `backend/app/schemas/session.py` (or similar) — add `active_session_id: UUID | None` to the response model the CHW inbox uses
- `backend/tests/test_call_bridge.py` (or `test_communication.py`) — extend with multi-call test cases

**Frontend files to modify:**
- `native/src/api/sessions.ts` — extend the session/thread response type with `active_session_id`
- `native/src/screens/chw/CHWMessagesScreen.tsx` — switch End Session / Submit Doc buttons to key off `active_session_id` (fall back to current session.id when null for backward compat during rollout)
- `native/src/screens/chw/CHWConversationsScreen.tsx` (or inbox) — read `active_session_id` for the active badge; key navigation off conversation_id when present
- `native/src/hooks/useSubmitDocumentation.ts` — accept session_id arg (already does); no logical change but verify

**Ops:**
- `backend/scripts/audit_session_per_call_readiness.py` — pre-deploy check: count Conversations with multiple Sessions (should be 0 before backfill), Sessions without a conversation_id (should be 0 after backfill), in_progress Sessions per conversation (should be ≤1).

---

## Pre-flight (before any code change)

- [ ] **Confirm Docker is running for tests**

  ```bash
  docker ps
  ```
  Expected: lists the compass-postgres, compass-api containers. If not running:
  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker compose up -d postgres
  ```

- [ ] **Confirm the test DB exists and migrations are current**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api alembic current
  ```
  Expected: latest revision is `e5f6a7b8c9d0` (add_npi_pos_for_billing_csv) or newer.

- [ ] **Run the full backend test suite as a baseline**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api pytest -q
  ```
  Expected: all pass. Note the count so you can confirm nothing regresses.

---

## Phase 1 — Schema + Model

### Task 1: Add `session_per_call_enabled` settings flag

**Files:**
- Modify: `backend/app/config.py`

- [ ] **Step 1: Add the field to `Settings`**

  Open `backend/app/config.py` and find the `Settings` class. Add this field alongside other feature flags (look for `billing_csv_enabled` and group it nearby):

  ```python
  # When True, /communication/call-bridge auto-creates a fresh Session row
  # for any bridge after the conversation's prior Session has been completed.
  # When False (default), call-bridge attaches the CommunicationSession to the
  # existing Session — i.e., the original 1-Session-per-conversation behavior.
  # Roll out by flipping to True in sandbox first, verify, then prod.
  session_per_call_enabled: bool = False
  ```

- [ ] **Step 2: Verify the setting loads**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && source .venv/bin/activate && \
    ADMIN_KEY=test-admin-key-for-pytest-1234 \
    SECRET_KEY=test-secret-key-for-pytest-runner-placeholder-AABBCCDD \
    python -c "from app.config import settings; print('flag =', settings.session_per_call_enabled)"
  ```
  Expected output: `flag = False`

- [ ] **Step 3: Commit**

  ```bash
  git add backend/app/config.py
  git commit -m "chore(config): add session_per_call_enabled flag (default off)"
  ```

### Task 2: Update the ORM models

**Files:**
- Modify: `backend/app/models/session.py` (add `conversation_id` mapped column)
- Modify: `backend/app/models/conversation.py` (drop UniqueConstraint, keep `session_id` field as deprecated)

- [ ] **Step 1: Add `conversation_id` to Session**

  Open `backend/app/models/session.py`. The `Session` class is defined around line 26-71. Add this field right after `member_id` (keep all the ID fields grouped):

  ```python
      # Long-lived chat thread between this CHW and member. Multiple Sessions
      # share a conversation_id when each Session represents one billable call
      # within the same ongoing relationship. Nullable for legacy rows from
      # before the session-per-call refactor; new rows are NOT NULL via the
      # service-layer create path (see app.services.session_lookup).
      conversation_id: Mapped[uuid.UUID | None] = mapped_column(
          UUID(as_uuid=True),
          ForeignKey("conversations.id"),
          nullable=True,
          index=True,
      )
  ```

- [ ] **Step 2: Drop the UniqueConstraint on Conversation.session_id**

  Open `backend/app/models/conversation.py`. Find `__table_args__` (around line 38-42) and replace:

  ```python
  __table_args__ = (
      UniqueConstraint("session_id", name="uq_conversations_session_id"),
  )
  ```

  with:

  ```python
  # NOTE: the uq_conversations_session_id UNIQUE constraint that lived here
  # was dropped in migration f6a7b8c9d0e1 (session-per-call refactor) so a
  # Conversation can host multiple Sessions over its lifetime. The session_id
  # column is kept temporarily as "the originating Session" for backward
  # compat while the rollout flag flips; remove it in a follow-up once the
  # flag is on in prod and no caller reads it.
  ```

  Also remove the `UniqueConstraint` import if it's now unused (search the file for other uses; if none, remove from the import line at the top).

- [ ] **Step 3: Verify the models import cleanly**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && source .venv/bin/activate && \
    ADMIN_KEY=test-admin-key-for-pytest-1234 \
    SECRET_KEY=test-secret-key-for-pytest-runner-placeholder-AABBCCDD \
    python -c "from app.models.session import Session; from app.models.conversation import Conversation; print('OK', Session.__table__.c.conversation_id, 'conv UCs:', [c.name for c in Conversation.__table__.constraints if hasattr(c, 'name') and c.name])"
  ```
  Expected: prints the conversation_id column type and the conversation table's constraint names should NOT include `uq_conversations_session_id`.

- [ ] **Step 4: Do NOT commit yet** — the model change without the migration will break alembic. Commit after Task 3.

### Task 3: Write the alembic migration

**Files:**
- Create: `backend/alembic/versions/f6a7b8c9d0e1_session_per_call_conversation_link.py`

- [ ] **Step 1: Find the current head revision**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && ls -lt alembic/versions/ | head -5
  ```
  Read the topmost (most recent by mtime). Inside that file, the line `revision: str = "..."` is the value you'll use as `down_revision` below. Most likely it's `e5f6a7b8c9d0` (from the audit) unless a newer one has landed.

- [ ] **Step 2: Create the migration file**

  Create `backend/alembic/versions/f6a7b8c9d0e1_session_per_call_conversation_link.py` with this content (substitute the actual `down_revision` you found in Step 1):

  ```python
  """session-per-call: drop conv UC + add session.conversation_id

  Revision ID: f6a7b8c9d0e1
  Revises: e5f6a7b8c9d0
  Create Date: 2026-05-28 00:00:00.000000
  """
  from alembic import op
  import sqlalchemy as sa
  from sqlalchemy.dialects.postgresql import UUID


  revision: str = "f6a7b8c9d0e1"
  down_revision: str | None = "e5f6a7b8c9d0"  # <-- replace if newer head exists
  branch_labels = None
  depends_on = None


  def upgrade() -> None:
      # 1. Drop the 1-session-per-conversation unique constraint.
      op.drop_constraint(
          "uq_conversations_session_id",
          "conversations",
          type_="unique",
      )

      # 2. Add Session.conversation_id (nullable so we can backfill safely).
      op.add_column(
          "sessions",
          sa.Column(
              "conversation_id",
              UUID(as_uuid=True),
              sa.ForeignKey("conversations.id"),
              nullable=True,
          ),
      )
      op.create_index(
          "ix_sessions_conversation_id",
          "sessions",
          ["conversation_id"],
          unique=False,
      )

      # 3. Backfill: each existing Conversation has at most one Session via
      #    Conversation.session_id (UC just dropped, but the rows still
      #    encode the 1:1 link). Copy that link onto Session.conversation_id.
      op.execute(
          """
          UPDATE sessions s
          SET conversation_id = c.id
          FROM conversations c
          WHERE c.session_id = s.id
            AND s.conversation_id IS NULL
          """
      )


  def downgrade() -> None:
      # 1. Drop the index + column from sessions.
      op.drop_index("ix_sessions_conversation_id", table_name="sessions")
      op.drop_column("sessions", "conversation_id")

      # 2. Restore the UC on conversations.session_id.
      # Will fail if any conversation now points to a session shared with
      # another conversation — that's intentional: downgrade is only safe
      # before any second-call session lands.
      op.create_unique_constraint(
          "uq_conversations_session_id",
          "conversations",
          ["session_id"],
      )
  ```

- [ ] **Step 3: Run the migration against the test DB**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api alembic upgrade head
  ```
  Expected: applies `f6a7b8c9d0e1` and reports `Running upgrade e5f6a7b8c9d0 -> f6a7b8c9d0e1, session-per-call: ...`.

- [ ] **Step 4: Verify the schema in the DB**

  ```bash
  docker exec -w /code compass-api psql "$DATABASE_URL" -c "\d sessions" | grep conversation_id
  docker exec -w /code compass-api psql "$DATABASE_URL" -c "\d conversations" | grep -i unique
  ```
  Expected: `conversation_id` column shown on `sessions`; no `uq_conversations_session_id` listed under `conversations`.

- [ ] **Step 5: Test the downgrade path**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api alembic downgrade -1 && docker exec -w /code compass-api alembic upgrade head
  ```
  Expected: both succeed. Downgrade should drop the column + index and restore the UC; upgrade should re-add and re-backfill.

- [ ] **Step 6: Commit the model + migration together**

  ```bash
  git add backend/app/models/session.py backend/app/models/conversation.py \
          backend/alembic/versions/f6a7b8c9d0e1_session_per_call_conversation_link.py
  git commit -m "feat(schema): add Session.conversation_id + drop Conversation UC for session-per-call"
  ```

---

## Phase 2 — Service-layer helpers

### Task 4: Create `session_lookup.py` with `get_active_session_for_conversation`

**Files:**
- Create: `backend/app/services/session_lookup.py`
- Create: `backend/tests/test_session_lookup.py`

- [ ] **Step 1: Write the failing test**

  Create `backend/tests/test_session_lookup.py`:

  ```python
  """Tests for app.services.session_lookup helpers (#193)."""
  from __future__ import annotations
  from uuid import uuid4

  import pytest
  from sqlalchemy.ext.asyncio import AsyncSession
  from sqlalchemy import select

  from app.models.conversation import Conversation
  from app.models.session import Session
  from app.services.session_lookup import get_active_session_for_conversation


  @pytest.mark.asyncio
  async def test_active_session_returns_in_progress_session(
      db_session: AsyncSession, chw_user, member_user, service_request,
  ):
      """When a conversation has one in_progress and one completed Session,
      the in_progress one is returned."""
      conv = Conversation(chw_id=chw_user.id, member_id=member_user.id)
      db_session.add(conv)
      await db_session.flush()

      completed = Session(
          request_id=service_request.id, chw_id=chw_user.id,
          member_id=member_user.id, vertical="medi_cal_chw", mode="phone",
          status="completed", conversation_id=conv.id,
      )
      active = Session(
          request_id=service_request.id, chw_id=chw_user.id,
          member_id=member_user.id, vertical="medi_cal_chw", mode="phone",
          status="in_progress", conversation_id=conv.id,
      )
      db_session.add_all([completed, active])
      await db_session.flush()

      result = await get_active_session_for_conversation(db_session, conv.id)
      assert result is not None
      assert result.id == active.id


  @pytest.mark.asyncio
  async def test_active_session_returns_none_when_no_in_progress(
      db_session: AsyncSession, chw_user, member_user, service_request,
  ):
      """No active session → None (caller can hide End/Doc buttons)."""
      conv = Conversation(chw_id=chw_user.id, member_id=member_user.id)
      db_session.add(conv)
      await db_session.flush()

      completed = Session(
          request_id=service_request.id, chw_id=chw_user.id,
          member_id=member_user.id, vertical="medi_cal_chw", mode="phone",
          status="completed", conversation_id=conv.id,
      )
      db_session.add(completed)
      await db_session.flush()

      result = await get_active_session_for_conversation(db_session, conv.id)
      assert result is None


  @pytest.mark.asyncio
  async def test_active_session_picks_most_recent_when_tied(
      db_session: AsyncSession, chw_user, member_user, service_request,
  ):
      """Defensive: if data corruption leads to two in_progress, return the
      newest by created_at so the UI shows the freshest call."""
      conv = Conversation(chw_id=chw_user.id, member_id=member_user.id)
      db_session.add(conv)
      await db_session.flush()

      from datetime import datetime, timezone, timedelta
      older = Session(
          request_id=service_request.id, chw_id=chw_user.id,
          member_id=member_user.id, vertical="medi_cal_chw", mode="phone",
          status="in_progress", conversation_id=conv.id,
          created_at=datetime.now(timezone.utc) - timedelta(hours=1),
      )
      newer = Session(
          request_id=service_request.id, chw_id=chw_user.id,
          member_id=member_user.id, vertical="medi_cal_chw", mode="phone",
          status="in_progress", conversation_id=conv.id,
      )
      db_session.add_all([older, newer])
      await db_session.flush()

      result = await get_active_session_for_conversation(db_session, conv.id)
      assert result is not None
      assert result.id == newer.id
  ```

  Note on fixtures: this assumes `db_session`, `chw_user`, `member_user`, `service_request` fixtures exist (they're standard in `tests/conftest.py`). If any are missing, look up the existing patterns in `tests/test_chw_member_profile.py` or `tests/test_call_bridge.py` and adapt.

- [ ] **Step 2: Run the test to verify it fails**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api pytest tests/test_session_lookup.py -v
  ```
  Expected: ImportError because `app.services.session_lookup` doesn't exist yet.

- [ ] **Step 3: Create `session_lookup.py` with the minimal helper**

  Create `backend/app/services/session_lookup.py`:

  ```python
  """Service helpers for the session-per-call refactor (#193).

  Owns the "which Session is active for this conversation" lookup and the
  factory that mints a new Session row when a call bridges into a
  conversation that has no in_progress Session.

  Keep this thin — these helpers are called from the call-bridge hot path
  and from the CHW inbox endpoint, both of which are latency-sensitive.
  """
  from __future__ import annotations

  from uuid import UUID

  from sqlalchemy import select
  from sqlalchemy.ext.asyncio import AsyncSession

  from app.models.session import Session


  async def get_active_session_for_conversation(
      db: AsyncSession,
      conversation_id: UUID,
  ) -> Session | None:
      """Return the conversation's currently in_progress Session, if any.

      "Active" = status='in_progress'. Picks the most recent by created_at
      if (defensively) there's more than one — the data model is supposed
      to permit only one but we don't enforce it at the DB level today.

      Returns None when the conversation has no in_progress Session, which
      is the signal the FE uses to hide the End Session / Submit Doc
      buttons and the call-bridge endpoint uses to know "mint a fresh
      Session for this bridge."
      """
      result = await db.execute(
          select(Session)
          .where(
              Session.conversation_id == conversation_id,
              Session.status == "in_progress",
          )
          .order_by(Session.created_at.desc())
          .limit(1)
      )
      return result.scalar_one_or_none()
  ```

- [ ] **Step 4: Run the tests — should now pass**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api pytest tests/test_session_lookup.py -v
  ```
  Expected: 3 passed.

- [ ] **Step 5: Commit**

  ```bash
  git add backend/app/services/session_lookup.py backend/tests/test_session_lookup.py
  git commit -m "feat(services): add get_active_session_for_conversation helper (#193)"
  ```

### Task 5: Add `find_or_create_conversation_for_session` helper

The current `_get_or_create_session_conversation` in `app/routers/sessions.py` keys off the Session, which is exactly the 1:1 binding we're breaking. We need a sibling that keys off (chw_id, member_id) and creates the Conversation once per pair.

**Files:**
- Modify: `backend/app/services/session_lookup.py` (add the helper)
- Modify: `backend/tests/test_session_lookup.py` (add tests)

- [ ] **Step 1: Write the failing tests**

  Append to `backend/tests/test_session_lookup.py`:

  ```python
  from app.services.session_lookup import find_or_create_conversation_for_pair


  @pytest.mark.asyncio
  async def test_find_or_create_returns_existing_conversation(
      db_session: AsyncSession, chw_user, member_user,
  ):
      """Don't create a duplicate Conversation when one already exists
      for the (chw, member) pair."""
      existing = Conversation(chw_id=chw_user.id, member_id=member_user.id)
      db_session.add(existing)
      await db_session.flush()

      result = await find_or_create_conversation_for_pair(
          db_session, chw_id=chw_user.id, member_id=member_user.id,
      )
      assert result.id == existing.id


  @pytest.mark.asyncio
  async def test_find_or_create_creates_when_absent(
      db_session: AsyncSession, chw_user, member_user,
  ):
      """First call between this pair → mint a fresh Conversation."""
      existing = await db_session.execute(
          select(Conversation).where(
              Conversation.chw_id == chw_user.id,
              Conversation.member_id == member_user.id,
          )
      )
      assert existing.scalar_one_or_none() is None

      result = await find_or_create_conversation_for_pair(
          db_session, chw_id=chw_user.id, member_id=member_user.id,
      )
      assert result.id is not None
      assert result.chw_id == chw_user.id
      assert result.member_id == member_user.id
  ```

- [ ] **Step 2: Run them — should fail with ImportError**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api pytest tests/test_session_lookup.py::test_find_or_create_returns_existing_conversation -v
  ```
  Expected: ImportError for `find_or_create_conversation_for_pair`.

- [ ] **Step 3: Add the helper**

  Append to `backend/app/services/session_lookup.py`:

  ```python
  from app.models.conversation import Conversation


  async def find_or_create_conversation_for_pair(
      db: AsyncSession,
      *,
      chw_id: UUID,
      member_id: UUID,
  ) -> Conversation:
      """Return the long-lived chat-thread Conversation for this (chw, member)
      pair, creating one if it doesn't exist yet.

      Pre-refactor code keyed Conversation off Session (1:1). Post-refactor,
      Conversation is the long-lived thread and many Sessions belong to it.
      This helper centralizes the lookup so the call-bridge path, the CHW
      inbox endpoint, and any future thread-anchored feature all agree on
      "which Conversation."
      """
      result = await db.execute(
          select(Conversation).where(
              Conversation.chw_id == chw_id,
              Conversation.member_id == member_id,
          )
      )
      conv = result.scalar_one_or_none()
      if conv is not None:
          return conv

      conv = Conversation(chw_id=chw_id, member_id=member_id)
      db.add(conv)
      await db.flush()
      return conv
  ```

- [ ] **Step 4: Run the tests — should now pass**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api pytest tests/test_session_lookup.py -v
  ```
  Expected: 5 passed (the 3 from Task 4 + 2 here).

- [ ] **Step 5: Commit**

  ```bash
  git add backend/app/services/session_lookup.py backend/tests/test_session_lookup.py
  git commit -m "feat(services): add find_or_create_conversation_for_pair helper (#193)"
  ```

### Task 6: Add `create_followup_session` factory

The third helper: build a new Session row for a CHW↔member call when the conversation has no in_progress Session. Copies request_id/vertical/mode from the most recent prior Session in the conversation so billing lineage is preserved.

**Files:**
- Modify: `backend/app/services/session_lookup.py`
- Modify: `backend/tests/test_session_lookup.py`

- [ ] **Step 1: Write the failing test**

  Append to `backend/tests/test_session_lookup.py`:

  ```python
  from app.services.session_lookup import create_followup_session


  @pytest.mark.asyncio
  async def test_create_followup_session_clones_billing_lineage(
      db_session: AsyncSession, chw_user, member_user, service_request,
  ):
      """A new Session for a followup call inherits request_id, vertical,
      mode from the most recent Session in the conversation so billing
      audits can still trace to the original ServiceRequest."""
      conv = Conversation(chw_id=chw_user.id, member_id=member_user.id)
      db_session.add(conv)
      await db_session.flush()

      prior = Session(
          request_id=service_request.id, chw_id=chw_user.id,
          member_id=member_user.id, vertical="medi_cal_chw", mode="phone",
          status="completed", conversation_id=conv.id,
      )
      db_session.add(prior)
      await db_session.flush()

      new_session = await create_followup_session(
          db_session,
          conversation=conv,
          chw_user=chw_user,
          member_user=member_user,
      )
      assert new_session.id != prior.id
      assert new_session.request_id == prior.request_id
      assert new_session.vertical == prior.vertical
      assert new_session.mode == prior.mode
      assert new_session.conversation_id == conv.id
      assert new_session.status == "in_progress"
      assert new_session.started_at is not None


  @pytest.mark.asyncio
  async def test_create_followup_session_rejects_when_active_exists(
      db_session: AsyncSession, chw_user, member_user, service_request,
  ):
      """Guard the "at most one in_progress Session per conversation"
      invariant — don't mint a second active row."""
      conv = Conversation(chw_id=chw_user.id, member_id=member_user.id)
      db_session.add(conv)
      await db_session.flush()

      active = Session(
          request_id=service_request.id, chw_id=chw_user.id,
          member_id=member_user.id, vertical="medi_cal_chw", mode="phone",
          status="in_progress", conversation_id=conv.id,
      )
      db_session.add(active)
      await db_session.flush()

      with pytest.raises(ValueError, match="already has an active session"):
          await create_followup_session(
              db_session,
              conversation=conv,
              chw_user=chw_user,
              member_user=member_user,
          )
  ```

- [ ] **Step 2: Run the test — should fail with ImportError**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api pytest tests/test_session_lookup.py::test_create_followup_session_clones_billing_lineage -v
  ```
  Expected: ImportError for `create_followup_session`.

- [ ] **Step 3: Implement the factory**

  Append to `backend/app/services/session_lookup.py`:

  ```python
  from datetime import UTC, datetime


  async def create_followup_session(
      db: AsyncSession,
      *,
      conversation: Conversation,
      chw_user,
      member_user,
  ) -> Session:
      """Mint a new in_progress Session for a fresh call in an existing
      conversation, cloning billing lineage (request_id, vertical, mode)
      from the most recent prior Session.

      Raises ``ValueError`` if the conversation already has an in_progress
      Session — the caller (call-bridge) should call
      ``get_active_session_for_conversation`` first and reuse that row.

      The new Session starts in ``in_progress`` with ``started_at`` now,
      mirroring what ``PATCH /sessions/{id}/start`` does for the first call.
      """
      active = await get_active_session_for_conversation(db, conversation.id)
      if active is not None:
          raise ValueError(
              f"Conversation {conversation.id} already has an active session "
              f"({active.id}); reuse it instead of creating a duplicate."
          )

      prior_result = await db.execute(
          select(Session)
          .where(Session.conversation_id == conversation.id)
          .order_by(Session.created_at.desc())
          .limit(1)
      )
      prior = prior_result.scalar_one_or_none()
      if prior is None:
          raise ValueError(
              f"Conversation {conversation.id} has no prior Session to clone "
              "lineage from; create the first Session via the normal "
              "ServiceRequest→accept→start flow instead."
          )

      new_session = Session(
          request_id=prior.request_id,
          chw_id=chw_user.id,
          member_id=member_user.id,
          vertical=prior.vertical,
          mode=prior.mode,
          status="in_progress",
          started_at=datetime.now(UTC),
          conversation_id=conversation.id,
      )
      db.add(new_session)
      await db.flush()
      return new_session
  ```

- [ ] **Step 4: Run the tests — should pass**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api pytest tests/test_session_lookup.py -v
  ```
  Expected: 7 passed.

- [ ] **Step 5: Commit**

  ```bash
  git add backend/app/services/session_lookup.py backend/tests/test_session_lookup.py
  git commit -m "feat(services): add create_followup_session factory (#193)"
  ```

---

## Phase 3 — Wire call-bridge to auto-create Sessions

### Task 7: Backfill `conversation_id` on Conversation-create paths

Before flipping call-bridge, every freshly-created Session needs a `conversation_id` so the lookups in Phase 2 can find it. There are two creation sites:
1. `_get_or_create_session_conversation` in `app/routers/sessions.py` (creates a Conversation FROM a Session — legacy path)
2. `start_session` in `app/routers/sessions.py` line 304-377 (creates a Session via the ServiceRequest accept flow)

The cleanest fix: ensure that wherever a Session is created today, we also create-or-find its Conversation and stamp `Session.conversation_id`.

**Files:**
- Modify: `backend/app/routers/sessions.py`

- [ ] **Step 1: Read the existing Session-creation code path**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && grep -n "Session(" app/routers/sessions.py | head -10
  ```
  Identify each `Session(...)` constructor call. For each, the surrounding code already has `chw_id` and `member_id` in scope (or trivially derivable).

- [ ] **Step 2: At each Session-creation site, link the Conversation**

  Pattern to apply at every site:

  ```python
  from app.services.session_lookup import find_or_create_conversation_for_pair

  conversation = await find_or_create_conversation_for_pair(
      db, chw_id=session.chw_id, member_id=session.member_id,
  )
  session.conversation_id = conversation.id
  ```

  Place the call AFTER the Session has been added/flushed (so `session.chw_id` is set) and BEFORE the final commit. For `start_session` specifically (~line 304), insert right before the `await db.commit()` at the end of the handler.

  Also patch the legacy `_get_or_create_session_conversation` helper so that when it creates a fresh Conversation for a Session, it also stamps the Session's conversation_id:

  ```python
  # Inside _get_or_create_session_conversation, when creating a new Conversation:
  conv = Conversation(
      chw_id=session.chw_id, member_id=session.member_id, session_id=session.id,
  )
  db.add(conv)
  await db.flush()
  # NEW: stamp the back-link so future lookups via Session.conversation_id work.
  session.conversation_id = conv.id
  ```

- [ ] **Step 3: Run the existing session tests to make sure nothing broke**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api pytest tests/test_journeys.py tests/test_bidirectional_comms.py -v
  ```
  Expected: all pass. These exercise the start_session → message → end_session flow.

- [ ] **Step 4: Commit**

  ```bash
  git add backend/app/routers/sessions.py
  git commit -m "feat(sessions): stamp Session.conversation_id on every create path (#193)"
  ```

### Task 8: Auto-create a Session in call-bridge (flagged)

**Files:**
- Modify: `backend/app/routers/communication.py` (the `/call-bridge` endpoint, lines 373-450)
- Create: `backend/tests/test_call_bridge_session_per_call.py`

- [ ] **Step 1: Write the failing tests**

  Create `backend/tests/test_call_bridge_session_per_call.py`:

  ```python
  """Integration tests for the session-per-call flag in /communication/call-bridge (#193)."""
  from __future__ import annotations
  from uuid import UUID

  import pytest
  from httpx import AsyncClient
  from sqlalchemy import select
  from sqlalchemy.ext.asyncio import AsyncSession

  from app.models.session import Session
  from app.models.conversation import Conversation


  @pytest.mark.asyncio
  async def test_call_bridge_reuses_active_session_when_flag_on(
      client: AsyncClient, chw_tokens, completed_session_with_conv,
      monkeypatch,
  ):
      """If the conversation already has an in_progress Session, call-bridge
      should attach the CommunicationSession to it (not mint a new one)."""
      from app.config import settings
      monkeypatch.setattr(settings, "session_per_call_enabled", True)

      # ... full body to be written by the implementer; see Task 9 below for
      # the helper fixture that builds completed_session_with_conv. ...


  @pytest.mark.asyncio
  async def test_call_bridge_creates_new_session_when_prior_is_completed(
      client: AsyncClient, chw_tokens, completed_session_with_conv,
      monkeypatch, db_session: AsyncSession,
  ):
      """Second call into the same conversation → fresh in_progress Session."""
      from app.config import settings
      monkeypatch.setattr(settings, "session_per_call_enabled", True)

      conv_id = completed_session_with_conv.conversation_id
      original_session_id = completed_session_with_conv.id

      # Hit call-bridge without a session_id so the endpoint resolves it.
      response = await client.post(
          "/api/v1/communication/call-bridge",
          headers={"Authorization": f"Bearer {chw_tokens['access_token']}"},
          json={
              "member_id": str(completed_session_with_conv.member_id),
              "conversation_id": str(conv_id),
          },
      )
      assert response.status_code == 200
      body = response.json()
      assert body["session_id"] != str(original_session_id)

      # DB now has 2 sessions on the same conversation; the new one is in_progress.
      sessions = (await db_session.execute(
          select(Session).where(Session.conversation_id == conv_id)
      )).scalars().all()
      assert len(sessions) == 2
      active = [s for s in sessions if s.status == "in_progress"]
      assert len(active) == 1
      assert active[0].id == UUID(body["session_id"])


  @pytest.mark.asyncio
  async def test_call_bridge_flag_off_keeps_legacy_behavior(
      client: AsyncClient, chw_tokens, completed_session_with_conv,
      monkeypatch, db_session: AsyncSession,
  ):
      """With the flag off, call-bridge does NOT create a new Session even
      when the conversation has no active one — preserves current behavior."""
      from app.config import settings
      monkeypatch.setattr(settings, "session_per_call_enabled", False)

      conv_id = completed_session_with_conv.conversation_id

      response = await client.post(
          "/api/v1/communication/call-bridge",
          headers={"Authorization": f"Bearer {chw_tokens['access_token']}"},
          json={
              "session_id": str(completed_session_with_conv.id),
              "member_id": str(completed_session_with_conv.member_id),
          },
      )
      # Legacy: attaches to the existing (completed) Session.
      assert response.status_code == 200
      sessions = (await db_session.execute(
          select(Session).where(Session.conversation_id == conv_id)
      )).scalars().all()
      assert len(sessions) == 1  # no new Session created
  ```

  **Fixture to add to `tests/conftest.py`** if `completed_session_with_conv` doesn't already exist (check first; if it does, use the existing one):

  ```python
  @pytest.fixture
  async def completed_session_with_conv(
      db_session, chw_user, member_user, service_request,
  ):
      """A conversation with one completed Session — the typical "after first
      call, before second call" state."""
      conv = Conversation(chw_id=chw_user.id, member_id=member_user.id)
      db_session.add(conv)
      await db_session.flush()
      session = Session(
          request_id=service_request.id,
          chw_id=chw_user.id, member_id=member_user.id,
          vertical="medi_cal_chw", mode="phone",
          status="completed", conversation_id=conv.id,
      )
      db_session.add(session)
      await db_session.commit()
      return session
  ```

- [ ] **Step 2: Run the tests — should fail (call-bridge doesn't honor the flag yet)**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api pytest tests/test_call_bridge_session_per_call.py -v
  ```
  Expected: 2 failures (flag-on tests fail) + 1 pass (flag-off test passes since current behavior matches).

- [ ] **Step 3: Modify `/call-bridge` to honor the flag**

  Open `backend/app/routers/communication.py` around line 373. Locate where the handler reads `body.session_id` and writes the `CommunicationSession`. Refactor to:

  ```python
  from app.config import settings
  from app.services.session_lookup import (
      get_active_session_for_conversation,
      find_or_create_conversation_for_pair,
      create_followup_session,
  )

  # Resolve the target Session, honoring the session-per-call flag.
  target_session_id: UUID | None = body.session_id
  if settings.session_per_call_enabled:
      # Look up the Conversation for this (chw, member) pair.
      conversation = await find_or_create_conversation_for_pair(
          db,
          chw_id=current_user.id,
          member_id=body.member_id,
      )
      # If there's an active Session, reuse it. Otherwise mint a fresh one.
      active = await get_active_session_for_conversation(db, conversation.id)
      if active is not None:
          target_session_id = active.id
      else:
          # Need the member User object for create_followup_session.
          member_user = await db.get(User, body.member_id)
          new_session = await create_followup_session(
              db,
              conversation=conversation,
              chw_user=current_user,
              member_user=member_user,
          )
          target_session_id = new_session.id

  # Existing CommunicationSession creation logic, now keyed off target_session_id:
  if target_session_id is not None:
      db.add(
          CommunicationSession(
              session_id=target_session_id,
              provider=proxy.provider,
              provider_session_id=proxy.provider_session_id,
              proxy_number=proxy.proxy_number,
          )
      )
  await db.commit()
  ```

  Update the response model `CallBridgeResponse` to include `session_id: UUID | None` so the FE can pick up the (possibly new) Session ID. If it already returns session_id, just confirm it now reflects `target_session_id`.

- [ ] **Step 4: Re-run the tests**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api pytest tests/test_call_bridge_session_per_call.py -v
  ```
  Expected: all 3 pass.

- [ ] **Step 5: Run the full test suite to catch regressions**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api pytest -q
  ```
  Expected: same pass count as the baseline from Pre-flight Step 3 plus the new tests.

- [ ] **Step 6: Commit**

  ```bash
  git add backend/app/routers/communication.py backend/tests/test_call_bridge_session_per_call.py backend/tests/conftest.py
  git commit -m "feat(call-bridge): auto-create Session per call when flag is on (#193)"
  ```

---

## Phase 4 — Expose `active_session_id` to the frontend

### Task 9: Add `active_session_id` to the CHW thread response

The CHW inbox/messages endpoint needs to return which Session is currently active so the FE can drive End Session / Submit Doc buttons off it (instead of off the originally-clicked Session, which may now be `completed`).

**Files:**
- Modify: `backend/app/routers/sessions.py` (the `list_session_messages` endpoint around line 1456, or a sibling endpoint that returns the thread metadata)
- Modify: `backend/app/schemas/session.py` (or wherever the response schema lives)

- [ ] **Step 1: Locate the FE-facing thread endpoint**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && grep -n "active_session\|thread\|conversation" app/routers/sessions.py app/routers/chw.py app/routers/messages.py 2>/dev/null | head -20
  ```
  Identify the endpoint(s) the FE calls when it opens a thread. The audit pinpointed `GET /sessions/{session_id}/messages` (sessions.py:1456). The thread-list (CHW inbox) endpoint is typically `GET /chw/threads` or `GET /chw/conversations` — find it.

- [ ] **Step 2: Extend the response schema**

  Find the response model used by the thread-list endpoint. Add:

  ```python
  active_session_id: UUID | None = Field(
      default=None,
      description=(
          "The conversation's currently in_progress Session, if any. The CHW "
          "Messages screen reads this to know which Session to act on for "
          "End Session / Submit Documentation. None when the conversation has "
          "no active Session (e.g., all prior calls are completed)."
      ),
  )
  ```

  Also add `conversation_id: UUID | None` to the same model — the FE will key navigation off it.

- [ ] **Step 3: Populate the new fields in the endpoint**

  In the endpoint handler, after loading each thread, call:

  ```python
  from app.services.session_lookup import get_active_session_for_conversation

  active = await get_active_session_for_conversation(db, conversation.id)
  thread_response.active_session_id = active.id if active else None
  thread_response.conversation_id = conversation.id
  ```

  If the endpoint returns a list, do this per row (N+1 is acceptable here; CHW inboxes are small).

- [ ] **Step 4: Write a smoke test**

  Add to `backend/tests/test_session_per_call.py` (create the file if it doesn't exist; mirror the test style of `test_chw_member_profile.py`):

  ```python
  @pytest.mark.asyncio
  async def test_chw_thread_list_returns_active_session_id(
      client, chw_tokens, db_session, chw_user, member_user, service_request,
  ):
      """The thread-list endpoint surfaces active_session_id so the FE can
      drive End Session / Submit Doc off the right ID."""
      conv = Conversation(chw_id=chw_user.id, member_id=member_user.id)
      db_session.add(conv)
      active = Session(
          request_id=service_request.id, chw_id=chw_user.id,
          member_id=member_user.id, vertical="medi_cal_chw", mode="phone",
          status="in_progress", conversation_id=conv.id,
      )
      db_session.add(active)
      await db_session.commit()

      response = await client.get(
          "/api/v1/chw/threads",  # <-- adjust to the real endpoint path
          headers={"Authorization": f"Bearer {chw_tokens['access_token']}"},
      )
      assert response.status_code == 200
      threads = response.json()
      assert len(threads) >= 1
      mine = next(t for t in threads if t["conversation_id"] == str(conv.id))
      assert mine["active_session_id"] == str(active.id)
  ```

- [ ] **Step 5: Run the test — make sure it passes**

  ```bash
  cd ~/Desktop/Projects/Compass/backend && docker exec -w /code compass-api pytest tests/test_session_per_call.py -v
  ```
  Expected: passes.

- [ ] **Step 6: Commit**

  ```bash
  git add backend/app/routers/sessions.py backend/app/schemas/session.py backend/tests/test_session_per_call.py
  git commit -m "feat(api): expose conversation_id + active_session_id on CHW threads (#193)"
  ```

### Task 10: Update the React Native types

**Files:**
- Modify: `native/src/api/sessions.ts` (or wherever the thread response type lives)

- [ ] **Step 1: Locate the response type**

  ```bash
  cd ~/Desktop/Projects/Compass/native && grep -rn "active_session_id\|conversation_id" src/api src/types 2>/dev/null | head
  cd ~/Desktop/Projects/Compass/native && grep -rn "chw/threads\|/sessions/.*messages" src/api 2>/dev/null | head
  ```
  Identify the TypeScript interface for the thread/inbox row.

- [ ] **Step 2: Extend the type**

  Add the two optional fields:

  ```typescript
  export interface CHWThreadResponse {
    // ... existing fields ...
    conversation_id?: string | null;
    active_session_id?: string | null;
  }
  ```

  Optional (`?`) so the type stays compatible with sandbox responses that pre-date this change (defensive during rollout).

- [ ] **Step 3: Verify no TS errors in dependent files**

  ```bash
  cd ~/Desktop/Projects/Compass/native && node --stack-size=8000 ./node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -E "src/api/sessions|src/screens/chw" | head
  ```
  Expected: no new errors.

- [ ] **Step 4: Commit**

  ```bash
  git add native/src/api/sessions.ts
  git commit -m "feat(types): add active_session_id + conversation_id to thread response (#193)"
  ```

### Task 11: Drive End Session / Submit Doc off `active_session_id`

**Files:**
- Modify: `native/src/screens/chw/CHWMessagesScreen.tsx` (the audit pinpointed lines 859 + 862-885)

- [ ] **Step 1: Find the state that holds the Session ID for documentation**

  Open `native/src/screens/chw/CHWMessagesScreen.tsx` and find:

  ```typescript
  setDocumentingSessionId(session.id);
  ```

  And the submitDocumentation call:

  ```typescript
  await submitDocumentation.mutateAsync({
    sessionId: documentingSessionId,
    data: data as unknown as Record<string, unknown>,
  });
  ```

- [ ] **Step 2: Source the Session ID from the thread response, not the clicked Session**

  Replace `session.id` in the documentation-trigger flow with a derived value:

  ```typescript
  // Prefer the thread's active Session (the one auto-created by call-bridge).
  // Fall back to session.id during rollout so the flow still works when the
  // backend hasn't started populating active_session_id yet.
  const sessionIdToDocument = thread.active_session_id ?? session.id;
  setDocumentingSessionId(sessionIdToDocument);
  ```

  Similarly for the End Session button — call `endSession.mutateAsync(thread.active_session_id ?? session.id)`.

- [ ] **Step 3: Hide the buttons when there is no active session**

  Wrap the buttons:

  ```tsx
  {(thread.active_session_id ?? session.status === 'in_progress' ? session.id : null) && (
    <>
      <SubmitDocButton ... />
      <EndSessionButton ... />
    </>
  )}
  ```

  The exact JSX wrapping depends on how the existing render tree is structured; the principle is: don't render the buttons when there's no active Session for the thread.

- [ ] **Step 4: Manual smoke test in the simulator**

  Run the Expo dev server, open the CHW Messages screen for a thread, verify:
  - With backend flag off: behavior is unchanged (buttons reflect the originally-clicked Session).
  - With backend flag on (in sandbox): completing a session and then placing a new call shows the End Session / Submit Doc buttons keyed off the *new* Session ID.

  ```bash
  cd ~/Desktop/Projects/Compass/native && npm run start
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add native/src/screens/chw/CHWMessagesScreen.tsx
  git commit -m "feat(chw-messages): key End Session/Submit Doc off active_session_id (#193)"
  ```

### Task 12: Update CHW inbox to navigate by Conversation when available

The CHW conversation list currently anchors navigation on Session ID. With session-per-call, the same conversation can have many Sessions over time — the inbox row should represent the conversation, not the latest Session.

**Files:**
- Modify: `native/src/screens/chw/CHWConversationsScreen.tsx` (or whatever the inbox screen is)

- [ ] **Step 1: Find the inbox screen and its navigation**

  ```bash
  cd ~/Desktop/Projects/Compass/native && grep -rn "navigate.*session\|navigate.*Messages" src/screens/chw 2>/dev/null | head
  ```

- [ ] **Step 2: Pass conversation_id forward when present**

  When tapping a row, pass `{ conversation_id, session_id }` as nav params. The receiving CHWMessagesScreen prefers `conversation_id` for re-fetching the thread; `session_id` is the originally-clicked Session for backward compat.

  Implementation depends on existing nav setup. The minimum is: include `conversation_id` in the route params and read it on the other side.

- [ ] **Step 3: Commit**

  ```bash
  git add native/src/screens/chw/CHWConversationsScreen.tsx
  git commit -m "feat(chw-inbox): navigate by conversation_id when present (#193)"
  ```

---

## Phase 5 — Rollout

### Task 13: Pre-deploy readiness audit script

**Files:**
- Create: `backend/scripts/audit_session_per_call_readiness.py`

- [ ] **Step 1: Write the script**

  ```python
  """Pre-deploy audit: confirm the DB is in a state where session-per-call is safe to enable.

  Checks:
    1. Every Session has a non-null conversation_id (backfill completed).
    2. No conversation has more than one in_progress Session (invariant).
    3. Every Conversation that has Sessions has the conversation_id back-link populated.

  Exit codes: 0 = ready; 1 = unresolved issues printed.

  Usage:
      docker exec -w /code compass-api python -m scripts.audit_session_per_call_readiness
  """
  from __future__ import annotations
  import asyncio, logging, sys
  from sqlalchemy import func, select
  from app.database import async_session
  from app.models.session import Session
  from app.models.conversation import Conversation

  logger = logging.getLogger("compass.audit_session_per_call_readiness")
  logging.basicConfig(level=logging.INFO, format="%(message)s")


  async def main() -> int:
      exit_code = 0
      async with async_session() as db:
          orphans = (await db.execute(
              select(func.count()).select_from(Session)
              .where(Session.conversation_id.is_(None))
          )).scalar_one()
          logger.info("Sessions without conversation_id: %d", orphans)
          if orphans > 0:
              exit_code = 1

          dup_active = (await db.execute(
              select(Session.conversation_id, func.count())
              .where(Session.status == "in_progress")
              .group_by(Session.conversation_id)
              .having(func.count() > 1)
          )).all()
          logger.info("Conversations with >1 in_progress Session: %d", len(dup_active))
          if dup_active:
              exit_code = 1
              for conv_id, n in dup_active:
                  logger.info("  conversation=%s active_count=%d", conv_id, n)

      if exit_code == 0:
          logger.info("✅ Ready to flip session_per_call_enabled=True.")
      else:
          logger.info("❌ Resolve the above before enabling the flag.")
      return exit_code


  if __name__ == "__main__":
      sys.exit(asyncio.run(main()))
  ```

- [ ] **Step 2: Run it against sandbox**

  ```bash
  docker exec -w /code compass-api python -m scripts.audit_session_per_call_readiness
  ```
  Expected: prints `✅ Ready` after the migration + Task 7 backfill ran.

- [ ] **Step 3: Commit**

  ```bash
  git add backend/scripts/audit_session_per_call_readiness.py
  git commit -m "chore(scripts): add session_per_call readiness audit (#193)"
  ```

### Task 14: Sandbox enable + smoke test

- [ ] **Step 1: Enable the flag in sandbox**

  ```bash
  ssh sandbox-ec2  # or however you SSH in
  # edit /etc/compass/env (or wherever the env file lives) and set:
  #   SESSION_PER_CALL_ENABLED=true
  sudo systemctl restart compass-api  # or `docker compose restart api`
  ```

- [ ] **Step 2: Place a test call**

  Use the CHW app to call a member you've already had one (completed) Session with. Verify in DB that a new Session row was created with the same conversation_id as the prior one.

  ```bash
  docker exec -w /code compass-api psql "$DATABASE_URL" -c "
    SELECT s.id, s.status, s.created_at, s.conversation_id
    FROM sessions s
    WHERE s.member_id = '<MEMBER_UUID>'
    ORDER BY s.created_at DESC
    LIMIT 5;
  "
  ```
  Expected: 2 rows for the same `conversation_id`, the newer one `in_progress`.

- [ ] **Step 3: Verify the CHW app shows the right buttons**

  In the CHW app, open the Messages thread with that member. End Session + Submit Documentation should be visible. Submit the doc — confirm it creates a SessionDocumentation + BillingClaim against the NEW Session ID, not the old completed one.

  ```bash
  docker exec -w /code compass-api psql "$DATABASE_URL" -c "
    SELECT id, session_id, submitted_at
    FROM session_documentation
    WHERE session_id IN (
      SELECT id FROM sessions WHERE conversation_id = '<CONV_UUID>'
    )
    ORDER BY submitted_at DESC;
  "
  ```

- [ ] **Step 4: Verify the CSV row**

  ```bash
  aws s3 cp s3://compass-prod-billing-csv/sandbox/v2/2026-05.csv - | tail -3
  ```
  Expected: the latest row shows the new Session's claim.

### Task 15: Prod enable + monitor

- [ ] **Step 1: Run the readiness audit against prod**

  ```bash
  ssh prod-ec2
  docker exec -w /code compass-api python -m scripts.audit_session_per_call_readiness
  ```
  Expected: `✅ Ready`.

- [ ] **Step 2: Enable the flag in prod**

  ```bash
  # Same as sandbox: set SESSION_PER_CALL_ENABLED=true, restart api.
  ```

- [ ] **Step 3: Monitor the next CHW↔member call**

  Tail the API logs and look for the call-bridge → new Session creation log line:

  ```bash
  ssh prod-ec2 'docker logs --tail 200 -f compass-api | grep -i "session"'
  ```

  Verify in the BillingClaims table that the claim's `session_id` matches the newly-created Session.

- [ ] **Step 4: Update memory**

  Record the rollout completion as a project memory:

  ```
  ~/.claude/projects/-Users-akrammahmoud/memory/project_compass_session_per_call_live.md
  ```

  Body: "2026-MM-DD: session_per_call_enabled flipped to True in prod. Each CHW↔member call now creates a new Session row sharing conversation_id."

### Task 16: Follow-up cleanup (optional, after flag has soaked 1 week)

- [ ] **Step 1: Drop the deprecated `conversations.session_id` column**

  Once no caller reads it (grep the codebase to confirm), write a migration to drop the column. Backfill any audit logs that referenced it.

- [ ] **Step 2: Remove the fallback in CHWMessagesScreen.tsx**

  Change `thread.active_session_id ?? session.id` → just `thread.active_session_id` once every prod response includes it.

- [ ] **Step 3: Document the change**

  Update `docs/ARCHITECTURE.md` (or equivalent) to describe Conversation as the long-lived chat thread and Session as the per-call billable unit.

---

## Self-review

After completing all phases, sanity-check:

- [ ] **Every existing Session has `conversation_id` populated** (audit script returns 0 orphans in prod).
- [ ] **Every BillingClaim now has a unique (session_id) pair across multi-call conversations** — no duplicate-claim-on-resubmit.
- [ ] **The CHW inbox sorts by latest activity, not by Session.created_at** — multi-call conversations should bubble to the top on every new call.
- [ ] **The legacy `_get_or_create_session_conversation` is still safe to call** — Task 7 patched it to stamp `Session.conversation_id`, so its callers don't need to know about the refactor.
- [ ] **The flag's "off" path still works** — `test_call_bridge_flag_off_keeps_legacy_behavior` passes throughout the rollout.

If any of those fail, fix before moving the flag forward.
