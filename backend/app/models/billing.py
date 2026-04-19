import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import ARRAY, Date, DateTime, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
