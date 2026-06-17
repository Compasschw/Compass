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
    # Non-null once the user completes an SMS OTP challenge for this number.
    # Reset to NULL if the user starts a new phone-change flow (before
    # confirmation) so the old verified number stays valid during the window.
    phone_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
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

    # Pear Suite user ID provisioned via their dashboard (no Create User API).
    # Must be set manually by Jemal before demo claims can be submitted.
    # Indexed for fast lookup during claim orchestration.
    pear_suite_user_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)

    # National Provider Identifier (10-digit CMS-issued ID for billing). Not
    # in Pear's bulk-upload CSV template today, but required for Medi-Cal
    # billing audit + future Pear API submissions. Nullable until the CHW
    # provides it during onboarding / admin sets it via the admin endpoint.
    npi: Mapped[str | None] = mapped_column(String(10), nullable=True)

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

    # ── Expanded signup fields (member RegisterScreen) ───────────────────
    # Captured at signup OR later via profile-edit; all nullable so a
    # half-complete profile doesn't block account creation.  Only DOB +
    # gender are required for the curated Pear Suite member-create payload
    # (see app.services.pear_suite_member_sync._build_member_payload).
    date_of_birth: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Maps to Pear Suite's ``sex`` enum: "Male" | "Female" | "Other".
    gender: Mapped[str | None] = mapped_column(String(32), nullable=True)
    address_line1: Mapped[str | None] = mapped_column(String(160), nullable=True)
    address_line2: Mapped[str | None] = mapped_column(String(160), nullable=True)
    city: Mapped[str | None] = mapped_column(String(80), nullable=True)
    state: Mapped[str | None] = mapped_column(String(2), nullable=True)
    # Curated 6-carrier dropdown value from the signup form.  Used by
    # pear_cost_ids.resolve_cost_id to pick the per-carrier costId at claim
    # submission.  Keeps ``insurance_provider`` (free-text legacy column)
    # untouched so older intake data still works.
    insurance_company: Mapped[str | None] = mapped_column(String(80), nullable=True)

    # Pear Suite member ID returned by POST /api/beta/members. Null until the
    # member has been synced. Indexed for fast existence check in ensure_member_synced.
    pear_suite_member_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)

    # Pear bulk-upload Member-Import CSV idempotency stamp. Set to NOW()
    # by auth/register (and the backfill script) after a successful row
    # is written to s3_bucket_member_csv. The writer has no in-CSV marker
    # column (Pear's Member template is 12 cols, no Notes), so retries
    # must be gated on this column or they produce duplicate rows.
    # NULL = "never exported"; non-NULL = "exported at this UTC moment".
    member_csv_exported_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # ── Services Consent (T03) ───────────────────────────────────────────────
    # Member-controlled toggle that gates ALL CHW↔member communication on the
    # platform. Two values:
    #   "consent_to_services"  — default; communication enabled
    #   "refuse_services"      — member opt-out; call-bridge, messages, and
    #                            new session acceptance all return 403
    #
    # When a member flips to "refuse_services" after a confirm modal:
    #   - ALL CHWs cannot call them (call-bridge 403)
    #   - ALL CHWs cannot message them (message-send 403)
    #   - No new sessions can be accepted for this member
    #   - Existing in-flight sessions complete normally (not killed)
    #   - Reverting to "consent_to_services" re-enables everything immediately
    #
    # changed_at + changed_by provide an audit trail — required for
    # compliance (consent record must be timestamped and attributed).
    services_consent: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="consent_to_services"
    )
    services_consent_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    services_consent_changed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    # ── Billing eligibility (billable / non-billable) ────────────────────────
    # CHW-controlled toggle on the Member Profile. Default true (billable).
    # When false, the member is marked non-billable: their completed sessions
    # should be excluded from Pear Suite billing submission. changed_at +
    # changed_by give the compliance audit trail (who flipped it, when),
    # mirroring the services_consent pattern above.
    is_billable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="true"
    )
    billing_status_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    billing_status_changed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    # Member's chosen/preferred name (what they go by), distinct from the legal
    # name stored on User.name. Nullable — falls back to first name in the UI.
    preferred_name: Mapped[str | None] = mapped_column(String(100), nullable=True)

    rewards_balance: Mapped[int] = mapped_column(Integer, default=0)
    preferred_mode: Mapped[str | None] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
