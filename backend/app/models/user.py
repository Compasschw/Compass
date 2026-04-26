import uuid
from datetime import date, datetime

from sqlalchemy import ARRAY, Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.encryption import EncryptedString


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(20))
    profile_picture_url: Mapped[str | None] = mapped_column(String(500))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_onboarded: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # ── Account-deletion fields (soft-delete + HIPAA 6-year retention) ──────────
    # Populated by AccountDeletionService. A non-null deleted_at means the account
    # has been soft-deleted and all PII anonymised. The row is intentionally kept
    # so that ServiceRequest / Session / BillingClaim / AuditLog foreign-key
    # references remain valid for the HIPAA 6-year retention window.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    # Computed at deletion: deleted_at + 6 years. After this date a future scheduled
    # job may hard-delete the row.
    #
    # TODO(hard-delete-scheduler): implement a nightly APScheduler job that queries
    #   SELECT id FROM users
    #   WHERE deleted_at IS NOT NULL
    #     AND data_retention_until <= CURRENT_DATE;
    # and for each row:
    #   1. Assert no open BillingClaim rows remain (status != 'paid').
    #   2. DELETE FROM <profile_table> WHERE user_id = id  (CHWProfile / MemberProfile)
    #   3. DELETE FROM users WHERE id = id
    #   4. Write a final AuditLog row: action='hard_delete', resource='account_purge'
    # Link issue: compass#XXX
    data_retention_until: Mapped[date | None] = mapped_column(Date, nullable=True)

class CHWProfile(Base):
    __tablename__ = "chw_profiles"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), unique=True, nullable=False)
    specializations: Mapped[list] = mapped_column(ARRAY(String), default=list)
    languages: Mapped[list] = mapped_column(ARRAY(String), default=list)
    bio: Mapped[str | None] = mapped_column(Text)
    zip_code: Mapped[str | None] = mapped_column(String(10), index=True)
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    years_experience: Mapped[int] = mapped_column(Integer, default=0)
    total_sessions: Mapped[int] = mapped_column(Integer, default=0)
    rating: Mapped[float] = mapped_column(Float, default=0.0)
    rating_count: Mapped[int] = mapped_column(Integer, default=0)
    is_available: Mapped[bool] = mapped_column(Boolean, default=True)
    availability_windows: Mapped[dict | None] = mapped_column(JSONB)

    # Stripe Connect Express account for receiving payouts. Null until the CHW
    # completes the onboarding flow. The status fields are cached from the
    # account.updated webhook to avoid round-tripping to Stripe on every request.
    stripe_connected_account_id: Mapped[str | None] = mapped_column(String(100))
    stripe_payouts_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    stripe_details_submitted: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

class MemberProfile(Base):
    __tablename__ = "member_profiles"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), unique=True, nullable=False)
    zip_code: Mapped[str | None] = mapped_column(String(10), index=True)
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    primary_language: Mapped[str] = mapped_column(String(50), default="English")
    primary_need: Mapped[str | None] = mapped_column(String(50))
    additional_needs: Mapped[list | None] = mapped_column(ARRAY(String))
    insurance_provider: Mapped[str | None] = mapped_column(String(255))
    # Encrypted at rest (AES-256-GCM). PHI per HIPAA 45 CFR §164.312(a)(2)(iv).
    medi_cal_id: Mapped[str | None] = mapped_column(EncryptedString)
    rewards_balance: Mapped[int] = mapped_column(Integer, default=0)
    preferred_mode: Mapped[str | None] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
