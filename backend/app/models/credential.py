import uuid
from datetime import date, datetime

from sqlalchemy import ARRAY, Boolean, Date, DateTime, Float, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Credential(Base):
    __tablename__ = "credentials"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    chw_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String(50), nullable=False)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    s3_key: Mapped[str | None] = mapped_column(String(500))
    file_name: Mapped[str | None] = mapped_column(String(255))
    upload_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expiration_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    credit_hours: Mapped[float | None] = mapped_column(Float)
    verified_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class CHWCredentialValidation(Base):
    __tablename__ = "chw_credential_validations"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    chw_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    institution_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("institution_registry.id"), nullable=False)
    program_name: Mapped[str] = mapped_column(String(255), nullable=False)
    certificate_number: Mapped[str | None] = mapped_column(String(100))
    graduation_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    uploaded_certificate_s3_key: Mapped[str | None] = mapped_column(String(500))
    # Document uploaded directly by the CHW after the native client completes
    # the S3 presigned-PUT.  Stores path-only, e.g. credentials/<chw_id>/<uuid>.pdf
    document_s3_key: Mapped[str | None] = mapped_column(String(500))
    # Credential expiry date — used by the daily scheduler to fire renewal warnings
    expiry_date: Mapped[date | None] = mapped_column(Date)
    # Last date a "credential expiring" notification was sent; prevents duplicate
    # daily warnings.  NULL means never warned.  In-memory dedup is used at
    # runtime; this column ensures durability across process restarts and is
    # required for multi-instance correctness.
    last_warned_date: Mapped[date | None] = mapped_column(Date)
    validation_status: Mapped[str] = mapped_column(String(20), default="pending")
    validated_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    institution_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    institution_confirmation_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class InstitutionRegistry(Base):
    __tablename__ = "institution_registry"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    address: Mapped[str | None] = mapped_column(Text)
    contact_email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(20))
    accreditation_status: Mapped[str | None] = mapped_column(String(50))
    programs_offered: Mapped[list | None] = mapped_column(ARRAY(String))
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
