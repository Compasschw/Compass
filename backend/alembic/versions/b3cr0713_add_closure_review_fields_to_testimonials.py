"""add_closure_review_fields_to_testimonials

Epic B3 — post-close-account review capture.

Adds two columns to the existing ``testimonials`` table so a single model
can represent both the original session-scoped rating flow AND a new
CHW-facilitated "parting feedback" flow captured when a CHW closes a
member's case (POST /chw/members/{member_id}/closure-review):

- ``source`` VARCHAR(20) NOT NULL DEFAULT 'session' — origin discriminator,
  'session' | 'account_closure'. The server default backfills every
  pre-existing row to 'session' with zero data-migration risk (that is
  exactly what every prior row is).
- ``rating`` becomes NULLABLE — account_closure-sourced reviews are
  text-only (no star rating collected in that flow); the session-scoped
  POST /sessions/{id}/testimonials endpoint continues to REQUIRE rating at
  the Pydantic schema layer (TestimonialCreate is unchanged), so this is a
  DB-level relaxation only, not a behavior change for the existing path.

The rating CHECK constraint is redefined to allow NULL while still
enforcing the 1..5 range whenever a rating IS present. A new CHECK
constraint guards the `source` column the same way `status` is guarded.

This migration is purely additive (new nullable/defaulted columns, relaxed
constraint) — no existing column is dropped or narrowed, no existing row
is rewritten (the source default handles backfill in-column).

Revision ID: b3cr0713
Revises:     sdohskip0713
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b3cr0713"
down_revision: str | None = "sdohskip0713"
branch_labels = None
depends_on = None

_TESTIMONIAL_SOURCES = ("session", "account_closure")


def upgrade() -> None:
    # 1. Add `source`, defaulting existing + new rows to 'session'.
    op.add_column(
        "testimonials",
        sa.Column(
            "source",
            sa.String(20),
            nullable=False,
            server_default="session",
        ),
    )
    op.create_check_constraint(
        "ck_testimonials_source",
        "testimonials",
        f"source IN ({', '.join(repr(s) for s in _TESTIMONIAL_SOURCES)})",
    )
    op.create_index(
        "ix_testimonials_source",
        "testimonials",
        ["source"],
    )

    # 2. Relax `rating` to nullable for closure-review (text-only) rows.
    op.alter_column(
        "testimonials",
        "rating",
        existing_type=sa.Integer(),
        nullable=True,
    )

    # 3. Redefine the rating-range CHECK to allow NULL (existing constraint
    #    required rating NOT NULL implicitly via the column, but explicitly
    #    re-express the range check to be NULL-safe now that NULL is legal).
    op.drop_constraint(
        "ck_testimonials_rating_range", "testimonials", type_="check"
    )
    op.create_check_constraint(
        "ck_testimonials_rating_range",
        "testimonials",
        "rating IS NULL OR (rating >= 1 AND rating <= 5)",
    )


def downgrade() -> None:
    # Reverse order: constraints/rating first, then source.
    op.drop_constraint(
        "ck_testimonials_rating_range", "testimonials", type_="check"
    )
    op.create_check_constraint(
        "ck_testimonials_rating_range",
        "testimonials",
        "rating >= 1 AND rating <= 5",
    )

    # NOTE: downgrading with existing NULL ratings (any account_closure rows)
    # would violate the restored NOT NULL constraint. This is expected and
    # intentional — a downgrade past this point requires the operator to
    # first delete/backfill account_closure rows, matching how other
    # backfill-dependent downgrades in this codebase are handled.
    op.alter_column(
        "testimonials",
        "rating",
        existing_type=sa.Integer(),
        nullable=False,
    )

    op.drop_index("ix_testimonials_source", table_name="testimonials")
    op.drop_constraint("ck_testimonials_source", "testimonials", type_="check")
    op.drop_column("testimonials", "source")
