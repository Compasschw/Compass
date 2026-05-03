"""add_session_recording_consent

Adds ``recording_consent_given_at`` to the ``sessions`` table — a nullable
timestamp set when the member affirmatively consents to call recording (DTMF
"1" on the IVR for phone calls; explicit consent button for chat sessions).

The column is denormalized from the ``member_consents`` table for fast
joinless lookups during billing claim creation. The authoritative consent
record (with audit fields like ip_address, user_agent, typed_signature)
remains in member_consents.

The legal driver is California Civil Code §632 (two-party consent law).
Without a recorded affirmative consent, audio recording cannot proceed,
which means the IVR consent gate must fire BEFORE Vonage starts recording.

Revision ID: p8l1m2n3o4p5
Revises: o7k0l1m2n3o4
Create Date: 2026-05-03 00:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "p8l1m2n3o4p5"
down_revision: Union[str, None] = "o7k0l1m2n3o4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column(
            "recording_consent_given_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("sessions", "recording_consent_given_at")
