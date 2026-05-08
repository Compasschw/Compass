"""SQLAlchemy models for the CHW Resource Folder feature.

Two tables:
  - ``resources``           — admin-curated catalog of community resources
  - ``resource_suggestions`` — CHW-submitted proposals for new resources
                               pending admin review

Design decisions
----------------
- ``ResourceCategory`` is a str-backed enum that extends the existing
  ``Vertical`` set (housing/food/mental_health/rehab/healthcare) with
  legal, transportation, and other. The frontend can reuse VERTICAL_COLOR
  for the overlapping values and fall back to neutral grey for the extras.
- ``ResourceStatus`` uses active/inactive (not deleted_at) because these
  rows are curated catalog entries, not user accounts; "inactive" is
  sufficient for admin soft-deletion without HIPAA 6-year retention
  complexity.
- ``languages`` is ARRAY(String) to match the CHWProfile / MemberProfile
  pattern in user.py.
- ``proposed_resource`` on ResourceSuggestion is JSONB (free-form) because
  CHWs submit whatever they know — partial data is intentional. Admins
  fill in the rest when they promote the suggestion to a real Resource row.
- No ``ondelete`` cascade on ``created_by_admin_id`` / ``chw_id`` / ``reviewed_by``
  because resource rows must survive user deletions (they are catalog
  entries, not user-owned PHI). The FK is nullable for safety.
"""

import uuid
from datetime import datetime

from sqlalchemy import ARRAY, DateTime, Float, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Resource(Base):
    """A curated community resource entry in the CHW Resource Folder.

    Resources are created and maintained by admins. CHWs can search,
    browse, and @-mention resources inline in chat messages and session
    documentation notes.

    Soft-deletion: set ``status = 'inactive'`` rather than deleting the
    row. This preserves referential integrity when a CHW has already
    @-mentioned the resource in a saved message or note — the token
    ``@[Name](resource:uuid)`` still resolves and the popover can show
    "This resource is no longer active."
    """

    __tablename__ = "resources"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    description: Mapped[str] = mapped_column(Text, nullable=False)

    # Category — matches existing Vertical enum plus legal/transportation/other.
    # Stored as a plain varchar so the DB doesn't need a Postgres enum type;
    # the application layer enforces valid values.
    category: Mapped[str] = mapped_column(String(50), nullable=False, index=True)

    # Contact / location
    url: Mapped[str | None] = mapped_column(String(500))
    phone: Mapped[str | None] = mapped_column(String(20))
    address: Mapped[str | None] = mapped_column(String(500))
    zip_code: Mapped[str | None] = mapped_column(String(10), index=True)
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)

    # Operational details
    hours: Mapped[str | None] = mapped_column(Text)
    eligibility: Mapped[str | None] = mapped_column(Text)
    languages: Mapped[list] = mapped_column(ARRAY(String), default=list)

    # Lifecycle
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="active", index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    # Nullable: system-seeded resources won't have a creating admin.
    created_by_admin_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )


class ResourceSuggestion(Base):
    """A CHW-submitted suggestion for a resource to add to the catalog.

    Workflow:
      1. CHW POSTs a suggestion (status=pending).
      2. Admin reviews the suggestion queue.
      3. Admin approves → a new Resource row is created, suggestion.status = 'approved'.
      4. Admin rejects → suggestion.status = 'rejected', optional notes in the suggestion body.

    ``proposed_resource`` is free-form JSONB; the CHW might know only a
    name + phone number, or might paste a full address. Admins fill in
    missing fields when promoting to a real Resource.
    """

    __tablename__ = "resource_suggestions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    chw_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )

    # Free-form JSONB. The CHW fills out whatever fields they know;
    # the object is not validated at the DB level.
    proposed_resource: Mapped[dict] = mapped_column(JSONB, nullable=False)

    # Optional CHW note explaining why this resource should be added.
    notes: Mapped[str | None] = mapped_column(Text)

    # Review lifecycle
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending", index=True
    )
    reviewed_by_admin_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
