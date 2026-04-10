"""add communication_sessions table

Revision ID: b4e2c3d5f6a7
Revises: a3f1b2c4d5e6
Create Date: 2026-04-10 08:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


# revision identifiers, used by Alembic.
revision: str = 'b4e2c3d5f6a7'
down_revision: Union[str, None] = 'a3f1b2c4d5e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'communication_sessions',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('session_id', UUID(as_uuid=True), sa.ForeignKey('sessions.id'), nullable=False, index=True),
        sa.Column('provider', sa.String(50), nullable=False),
        sa.Column('provider_session_id', sa.String(255), nullable=False),
        sa.Column('proxy_number', sa.String(20), nullable=False),
        sa.Column('status', sa.String(20), server_default='active'),
        sa.Column('recording_url', sa.String(500)),
        sa.Column('recording_duration_seconds', sa.Integer()),
        sa.Column('provider_recording_id', sa.String(255)),
        sa.Column('transcript_text', sa.Text()),
        sa.Column('transcript_confidence', sa.Float()),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('closed_at', sa.DateTime(timezone=True)),
    )


def downgrade() -> None:
    op.drop_table('communication_sessions')
