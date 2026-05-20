import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import ARRAY, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PearSuiteTemplateMap(Base):
    """Mapping from CPT/HCPCS procedure code to Pear Suite activity template ID.

    Rows are populated at migration time (T1016 seed) and may be supplemented
    via the Pear Suite dashboard as additional procedure codes are contracted.
    The template_id must be obtained from the Pear Suite dashboard and is
    stored here so the API layer never needs to hard-code Pear internals.

    There is one row per procedure code billed through Pear Suite. Additional
    columns (modifier, description) are informational only — Pear Suite's own
    template carries the authoritative billing configuration.
    """

    __tablename__ = "pear_suite_template_map"

    # CPT or HCPCS procedure code — e.g. "T1016", "G0511"
    cpt_code: Mapped[str] = mapped_column(String(20), primary_key=True)
    # Activity template ID from Pear Suite dashboard — required before claims can be submitted.
    # Stored as empty string if not yet configured; the claim orchestrator will 400 if blank.
    template_id: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    # Billing modifier — e.g. "U2" for CHW services under Medi-Cal
    modifier: Mapped[str | None] = mapped_column(String(10), nullable=True)
    # Human-readable label for admin tooling — not sent to Pear Suite
    description: Mapped[str | None] = mapped_column(Text, nullable=True)


class BillingClaim(Base):
    __tablename__ = "billing_claims"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sessions.id"), nullable=False)
    chw_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    diagnosis_codes: Mapped[list | None] = mapped_column(ARRAY(String))
    procedure_code: Mapped[str] = mapped_column(String(10), nullable=False)
    modifier: Mapped[str] = mapped_column(String(5), default="U2")
    units: Mapped[int] = mapped_column(Integer, nullable=False)
    gross_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    platform_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    pear_suite_fee: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    net_payout: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    pear_suite_claim_id: Mapped[str | None] = mapped_column(String(100))
    # service_date = the calendar date the service was delivered. This is what Medi-Cal
    # uses for daily/yearly unit caps — NOT the timestamp the claim was created.
    # A session that ran from 11:45 PM to 12:15 AM should count toward the day it started.
    service_date: Mapped[date | None] = mapped_column(Date, index=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    adjudicated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    rejection_reason: Mapped[str | None] = mapped_column(String(500))
    # CMS-1500 box 24B Place of Service. "02"=Telehealth (most phone/web
    # sessions), "11"=Office, "12"=Home, etc. Set at documentation-submit
    # time from session.mode unless the CHW overrides. Required by Pear's
    # bulk-upload CSV in "NN - Label" form (the CSV writer reformats).
    place_of_service_code: Mapped[str] = mapped_column(
        String(5), nullable=False, server_default="02"
    )
    # Stripe transfer that moved the CHW's net share from platform balance to
    # their connected account. Populated after successful payout; null while
    # awaiting Medi-Cal adjudication via Pear Suite.
    stripe_transfer_id: Mapped[str | None] = mapped_column(String(100))
    paid_to_chw_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
