"""add_consent_requests

Two-party in-app consent request table for HIPAA + California §632 compliance.

Background
----------
California Penal Code §632 requires *all* parties to a confidential
communication to consent before it may be recorded.  The existing
``member_consents`` table is used for CHW verbal attestations (CHW attests that
the member verbally agreed on the call), which is acceptable for phone-only
sessions but does not capture a genuine in-app member tap.

This migration introduces ``consent_requests`` — a lifecycle row created by the
CHW that the member's app polls for and responds to.  On approval, the existing
``member_consents`` table receives a row with ``member_id = <member's own user
UUID>`` (not the CHW's), providing an immutable audit trail of:

  1. CHW created the request (consent_requests.chw_id, requested_at)
  2. Member affirmatively approved (consent_requests.member_id, responded_at,
     status = 'approved') → and a member_consents row with the member's own
     identity, typed signature, IP address, and user-agent.

Both records together satisfy:
  - HIPAA 45 CFR §164.508: "individual authorization" signed by the member
  - California §632: both CHW (tapped Mic) and member (tapped Approve) consent
  - Minimum-necessary disclosure: the approval modal text specifies what is
    recorded, where stored, and how the member can revoke consent

New table: consent_requests
---------------------------
id              UUID PK
session_id      UUID FK sessions.id ON DELETE CASCADE, indexed
chw_id          UUID FK users.id (who created the request)
member_id       UUID FK users.id (who must respond), indexed
consent_type    VARCHAR(50) — "ai_transcription" for v1
status          VARCHAR(20) — pending | approved | denied | cancelled | expired
requested_at    TIMESTAMPTZ not null, default now()
responded_at    TIMESTAMPTZ nullable (set when member or CHW acts)
expires_at      TIMESTAMPTZ not null (default: requested_at + 5 min)

Composite index (session_id, status): accelerates the "find all pending
consent requests for this session" query that runs every 3 seconds while
members are in an active session.

Expiry strategy
---------------
No background job is required.  The ``is_expired()`` method on the model
checks ``status == 'pending' and now() >= expires_at`` at read time.
Endpoints that return pending rows lazily flip expired rows to
``status = 'expired'`` and commit.  This avoids clock skew issues while
keeping the DB consistent.

Revision ID: u4q7r8s9t0u1
Revises: t3p6q7r8s9t0
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "u4q7r8s9t0u1"
down_revision: str | None = "t3p6q7r8s9t0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "consent_requests",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "chw_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "member_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("consent_type", sa.String(50), nullable=False),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "requested_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "responded_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "expires_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
    )

    # Individual column indexes
    op.create_index(
        "ix_consent_requests_session_id",
        "consent_requests",
        ["session_id"],
    )
    op.create_index(
        "ix_consent_requests_member_id",
        "consent_requests",
        ["member_id"],
    )
    op.create_index(
        "ix_consent_requests_status",
        "consent_requests",
        ["status"],
    )

    # Composite index: the primary hot-path query filters by both session_id
    # and status simultaneously ("pending requests for this session").
    op.create_index(
        "ix_consent_requests_session_status",
        "consent_requests",
        ["session_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_consent_requests_session_status", table_name="consent_requests")
    op.drop_index("ix_consent_requests_status", table_name="consent_requests")
    op.drop_index("ix_consent_requests_member_id", table_name="consent_requests")
    op.drop_index("ix_consent_requests_session_id", table_name="consent_requests")
    op.drop_table("consent_requests")
