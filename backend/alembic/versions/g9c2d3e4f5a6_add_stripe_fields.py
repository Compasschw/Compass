"""add stripe connect fields

Adds Stripe Connect Express account fields to chw_profiles and
transfer tracking to billing_claims.

Revision ID: g9c2d3e4f5a6
Revises: f8b1c2d3e4f5
Create Date: 2026-04-19 23:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'g9c2d3e4f5a6'
down_revision: Union[str, None] = 'f8b1c2d3e4f5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # CHWProfile — add Stripe Connect fields
    op.add_column('chw_profiles', sa.Column('stripe_connected_account_id', sa.String(100), nullable=True))
    op.add_column('chw_profiles', sa.Column('stripe_payouts_enabled', sa.Boolean(), server_default=sa.false()))
    op.add_column('chw_profiles', sa.Column('stripe_details_submitted', sa.Boolean(), server_default=sa.false()))
    op.create_index(
        'ix_chw_profiles_stripe_account',
        'chw_profiles',
        ['stripe_connected_account_id'],
        unique=True,
        postgresql_where=sa.text('stripe_connected_account_id IS NOT NULL'),
    )

    # BillingClaim — add transfer tracking
    op.add_column('billing_claims', sa.Column('stripe_transfer_id', sa.String(100), nullable=True))
    op.add_column('billing_claims', sa.Column('paid_to_chw_at', sa.DateTime(timezone=True), nullable=True))
    op.create_index('ix_billing_claims_stripe_transfer', 'billing_claims', ['stripe_transfer_id'])


def downgrade() -> None:
    op.drop_index('ix_billing_claims_stripe_transfer', table_name='billing_claims')
    op.drop_column('billing_claims', 'paid_to_chw_at')
    op.drop_column('billing_claims', 'stripe_transfer_id')

    op.drop_index('ix_chw_profiles_stripe_account', table_name='chw_profiles')
    op.drop_column('chw_profiles', 'stripe_details_submitted')
    op.drop_column('chw_profiles', 'stripe_payouts_enabled')
    op.drop_column('chw_profiles', 'stripe_connected_account_id')
