"""add magic_link_tokens table

Revision ID: f8b1c2d3e4f5
Revises: e7a0b1c2d3e4
Create Date: 2026-04-18 22:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


# revision identifiers, used by Alembic.
revision: str = 'f8b1c2d3e4f5'
down_revision: Union[str, None] = 'e7a0b1c2d3e4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'magic_link_tokens',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('token_hash', sa.String(128), nullable=False, unique=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('consumed_at', sa.DateTime(timezone=True)),
        sa.Column('ip_address', sa.String(45)),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index('ix_magic_link_tokens_user_id', 'magic_link_tokens', ['user_id'])
    op.create_index('ix_magic_link_tokens_token_hash', 'magic_link_tokens', ['token_hash'])
    op.create_index('ix_magic_link_tokens_expires_at', 'magic_link_tokens', ['expires_at'])


def downgrade() -> None:
    op.drop_index('ix_magic_link_tokens_expires_at', table_name='magic_link_tokens')
    op.drop_index('ix_magic_link_tokens_token_hash', table_name='magic_link_tokens')
    op.drop_index('ix_magic_link_tokens_user_id', table_name='magic_link_tokens')
    op.drop_table('magic_link_tokens')
