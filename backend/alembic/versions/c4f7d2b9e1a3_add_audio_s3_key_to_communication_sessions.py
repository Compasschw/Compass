"""add audio_s3_key to communication_sessions

Revision ID: c4f7d2b9e1a3
Revises:     ab1c2d3e4f5a
Create Date: 2026-06-09

Schema notes
------------
communication_sessions.audio_s3_key
  - VARCHAR(500), nullable.  NULL = audio not yet uploaded to S3 (or upload
    failed).  Use ``audio_s3_key IS NULL`` as the "needs backfill" filter in
    the backfill_recent_recordings script.
  - Path schema: ``prod/v1/{year}/{month}/{session_id}.mp3``
  - Populated by recording_finalizer after a successful PUT to the
    compass-prod-call-recordings S3 bucket.  The recording_finalizer continues
    transcription even if the S3 PUT fails — S3 is an audit-trail layer, not
    a prerequisite for the clinical workflow.
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "c4f7d2b9e1a3"
down_revision = "ab1c2d3e4f5a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "communication_sessions",
        sa.Column("audio_s3_key", sa.String(length=500), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("communication_sessions", "audio_s3_key")
