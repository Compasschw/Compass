"""encrypt medi_cal_id — expand column to hold ciphertext

Revision ID: d6f9a0b1c2d3
Revises: c5e8d9f1a2b3
Create Date: 2026-04-18 20:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd6f9a0b1c2d3'
down_revision: Union[str, None] = 'c5e8d9f1a2b3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Expand medi_cal_id column from VARCHAR(50) to VARCHAR(512) to hold base64
    # AES-256-GCM ciphertext (nonce + ciphertext + tag). Existing plaintext rows
    # will continue to work via the EncryptedString legacy-fallback path until
    # they're migrated via a separate data migration script.
    op.alter_column(
        'member_profiles',
        'medi_cal_id',
        existing_type=sa.String(50),
        type_=sa.String(512),
        existing_nullable=True,
    )


def downgrade() -> None:
    # Data will be lost if any encrypted values exceed 50 chars. Truncation
    # is intentional — downgrading means reverting to plaintext, which should
    # only happen in emergency rollback with a clean DB.
    op.alter_column(
        'member_profiles',
        'medi_cal_id',
        existing_type=sa.String(512),
        type_=sa.String(50),
        existing_nullable=True,
    )
