"""add suggested_units to sessions

Revision ID: a3f1bc209e44
Revises: 25e04ffcbdf8
Create Date: 2026-04-09 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a3f1bc209e44'
down_revision: Union[str, None] = '25e04ffcbdf8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('sessions', sa.Column('suggested_units', sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column('sessions', 'suggested_units')
