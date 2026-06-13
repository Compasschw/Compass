"""add performance indexes — session_transcripts + billing_claims

Revision ID: m5n6o7p8q9r0
Revises:     k1b2c3d4e5f7
Create Date: 2026-06-13

Audit 2026-06-12 item #15. The audit named three indexes; on inspection only
two are warranted:

  1. session_transcripts (session_id, started_at_ms)
     The summarizer (services/summary_generation.py) loads a session's
     final chunks with ``WHERE session_id = :id ORDER BY started_at_ms ASC``.
     The existing ix_session_transcripts_session_id_created indexes
     (session_id, created_at) — insertion order, NOT playback order — so the
     planner sorts by started_at_ms on every summary. This covering index
     removes that sort. Grows with transcript length, so created CONCURRENTLY.

  2. billing_claims (pear_suite_claim_id) WHERE pear_suite_claim_id IS NOT NULL
     Partial index over the claims that carry a Pear id. Serves the
     ``pear_suite_claim_id IS NOT NULL`` predicate in poll_pear_claim_status
     (scheduler.py, every 30 min) and the lookup-by-claim-id the Pear webhook
     will perform once its contract lands (routers/pear_webhook.py).
     Left NON-UNIQUE deliberately: a UNIQUE partial index is the correct
     end state (one Pear claim ↔ one BillingClaim, guarding against
     double-payout) but UNIQUE + CONCURRENTLY leaves an INVALID index if any
     duplicate exists, which would block a deploy. Promote to UNIQUE alongside
     the webhook work, after a one-time dup check on prod.

  NOT added: the sessions CHW-inbox index. The audit listed it as missing, but
  ix_sessions_chw_inbox already exists (migration b2c3d4e5f6a7) as
  (chw_id, pinned_at, created_at) WHERE deleted_at IS NULL. The only gap is
  ASC vs the query's DESC NULLS LAST ordering — a micro-optimization not worth
  a CONCURRENTLY rebuild at pilot scale.

CONCURRENTLY requires running outside a transaction, so each create/drop is
wrapped in an autocommit block.
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "m5n6o7p8q9r0"
down_revision = "k1b2c3d4e5f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.create_index(
            "ix_session_transcripts_session_started",
            "session_transcripts",
            ["session_id", "started_at_ms"],
            unique=False,
            postgresql_concurrently=True,
            if_not_exists=True,
        )
        op.create_index(
            "ix_billing_claims_pear_claim_id",
            "billing_claims",
            ["pear_suite_claim_id"],
            unique=False,
            postgresql_concurrently=True,
            postgresql_where="pear_suite_claim_id IS NOT NULL",
            if_not_exists=True,
        )


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.drop_index(
            "ix_billing_claims_pear_claim_id",
            table_name="billing_claims",
            postgresql_concurrently=True,
            if_exists=True,
        )
        op.drop_index(
            "ix_session_transcripts_session_started",
            table_name="session_transcripts",
            postgresql_concurrently=True,
            if_exists=True,
        )
