"""add service_date to billing_claims

Revision ID: c5e8d9f1a2b3
Revises: b4e2c3d5f6a7
Create Date: 2026-04-18 20:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c5e8d9f1a2b3'
down_revision: Union[str, None] = 'b4e2c3d5f6a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('billing_claims', sa.Column('service_date', sa.Date(), nullable=True))
    op.create_index('ix_billing_claims_service_date', 'billing_claims', ['service_date'])
    # Backfill existing rows: use the date portion of created_at
    op.execute("UPDATE billing_claims SET service_date = created_at::date WHERE service_date IS NULL")


def downgrade() -> None:
    op.drop_index('ix_billing_claims_service_date', table_name='billing_claims')
    op.drop_column('billing_claims', 'service_date')
