"""add_session_transcripts

Adds the ``session_transcripts`` table that persists final transcript chunks
for every AI-transcribed session.  Also serves as the HIPAA audit trail for
real-time transcription access.

Only ``is_final = TRUE`` rows are inserted by the application layer — partial
chunks are deliberately excluded to keep volume manageable.

Revision ID: l4h7i8j9k0l1
Revises: k3g6h7i8j9k0
Create Date: 2026-04-22 14:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "l4h7i8j9k0l1"
down_revision: Union[str, None] = "k3g6h7i8j9k0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "session_transcripts",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "session_id",
            UUID(as_uuid=True),
            sa.ForeignKey(
                "sessions.id",
                ondelete="CASCADE",
                name="fk_session_transcripts_session_id",
            ),
            nullable=False,
        ),
        # "A" or "B" — diarisation label from the transcription provider.
        sa.Column("speaker_label", sa.String(10), nullable=True),
        # chw | member | unknown — resolved by the hub from audio-source attribution.
        sa.Column("speaker_role", sa.String(20), nullable=True),
        # Only populated when the speaker role is positively resolved to a user.
        sa.Column(
            "speaker_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", name="fk_session_transcripts_speaker_user_id"),
            nullable=True,
        ),
        # PHI — encrypted at rest by the database-level encryption policy.
        sa.Column("text", sa.Text, nullable=False),
        sa.Column("is_final", sa.Boolean, nullable=False),
        sa.Column("confidence", sa.Float, nullable=True),
        # Millisecond offsets from session start supplied by the provider.
        sa.Column("started_at_ms", sa.BigInteger, nullable=True),
        sa.Column("ended_at_ms", sa.BigInteger, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    # Composite index used by the replay and follow-up extraction queries:
    #   SELECT * FROM session_transcripts
    #   WHERE session_id = $1
    #   ORDER BY created_at;
    op.create_index(
        "ix_session_transcripts_session_id_created",
        "session_transcripts",
        ["session_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_session_transcripts_session_id_created",
        table_name="session_transcripts",
    )
    op.drop_table("session_transcripts")
