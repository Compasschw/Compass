"""delivery-status columns on messages + alembic head merge

SMS Output (Spec 1) §4 — per-message delivery-status tracking. Adds two nullable
columns to ``messages`` that the Vonage delivery-status webhook
(``POST /api/v1/communication/sms/status``) stamps for outbound SMS rows:

    delivery_status         String(16)  NULL  — 'delivered' | 'failed' (null = no status yet)
    delivery_failed_reason  String(64)  NULL  — failure reason when status == 'failed'

Both are nullable with no backfill: every pre-existing row (and every in-app
message) legitimately has no delivery status. Status is advisory — late or
unmatched Vonage callbacks are dropped, so a NULL is always a valid state.

Head merge
----------
This is the SMS Output plan's ONLY migration and doubles as the alembic MERGE
revision. At authoring time the branch carried two heads:

    casenote0715   (case-notes status; branched off smsnotif0714)
    stopprompt0715 (member_profiles.last_stop_prompt_at; off cinhash0715 → phoneidx0715 → smsnotif0714)

Merging both into a single ``down_revision`` collapses the tree back to ONE head
(``smsdlv0715``) so ``alembic upgrade head`` is unambiguous in every environment.
The ``member_profiles.last_stop_prompt_at`` column shipped with its own migration
(``stopprompt0715``, PR-2) — it is NOT re-added here; this migration only reaches
it through the merged lineage.

Revision ID: smsdlv0715
Revises: casenote0715, stopprompt0715
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "smsdlv0715"
# Merge the two current heads into one. Both parents are reachable from
# smsnotif0714; this collapses them so there is exactly one head afterwards.
down_revision = ("casenote0715", "stopprompt0715")
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("delivery_status", sa.String(16), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("delivery_failed_reason", sa.String(64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("messages", "delivery_failed_reason")
    op.drop_column("messages", "delivery_status")
