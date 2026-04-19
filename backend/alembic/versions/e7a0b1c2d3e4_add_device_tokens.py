"""add device_tokens table

Revision ID: e7a0b1c2d3e4
Revises: d6f9a0b1c2d3
Create Date: 2026-04-18 22:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


# revision identifiers, used by Alembic.
revision: str = 'e7a0b1c2d3e4'
down_revision: Union[str, None] = 'd6f9a0b1c2d3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'device_tokens',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('token', sa.String(255), nullable=False),
        sa.Column('platform', sa.String(20), nullable=False),
        sa.Column('provider', sa.String(20), server_default='expo'),
        sa.Column('is_active', sa.Boolean(), server_default=sa.true()),
        sa.Column('last_used_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint('token', name='uq_device_tokens_token'),
    )
    op.create_index('ix_device_tokens_user_id', 'device_tokens', ['user_id'])


def downgrade() -> None:
    op.drop_index('ix_device_tokens_user_id', table_name='device_tokens')
    op.drop_table('device_tokens')
