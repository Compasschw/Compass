"""MemberDocument model — PHI file attachments owned by a member.

Files are stored in the private S3 bucket ``S3_MEMBER_DOCUMENTS_BUCKET``
(``compass-prod-member-documents``).  The s3_url column stores the full S3
object URL; presigned GET URLs are generated on demand by the download-url
endpoint.

HIPAA notes:
  - s3_url is PHI-adjacent (it encodes the member UUID and document type).
    Never log it.
  - deleted_at provides a soft-delete so audit trail foreign-key references
    remain valid for the HIPAA 6-year retention window.
  - AuditLog rows are written by every CRUD endpoint; see the router.
"""

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class MemberDocument(Base):
    """A document uploaded by or on behalf of a member.

    ``uploaded_by`` may be the member themselves (self-upload) or a CHW
    uploading on the member's behalf within an active care relationship.
    """

    __tablename__ = "member_documents"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
        index=True,
    )
    # e.g. 'id', 'income', 'address', 'medical', 'other'
    document_type: Mapped[str] = mapped_column(String(50), nullable=False)
    # Original filename from the client — used for display only, never for S3 key routing.
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    # Full s3 object URL: s3://<bucket>/<key>  or  https://<bucket>.s3.<region>.amazonaws.com/<key>
    # NEVER log this field.
    s3_url: Mapped[str] = mapped_column(String(1000), nullable=False)
    # S3 object key extracted from s3_url — stored separately so download-url
    # endpoint can call generate_presigned_url without parsing the URL.
    s3_key: Mapped[str] = mapped_column(String(500), nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    uploaded_by: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Soft-delete: NULL = active; timestamp = deleted.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        # Primary list query: active documents for a member, newest first.
        Index("ix_member_documents_member_active", "member_id", "deleted_at"),
        # Uploader-scoped queries (CHW viewing their own uploads).
        Index("ix_member_documents_uploaded_by", "uploaded_by"),
    )
