"""Pydantic response models for admin dashboard endpoints.

HIPAA guardrails enforced at schema level:
- No medi_cal_id on MemberAdminItem
- No diagnosis_codes on ClaimAdminItem or SessionAdminItem
- No session notes / summary / documentation text on any response
- No session transcript or recording data
"""

from datetime import date, datetime
from typing import Generic, TypeVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict

T = TypeVar("T")


class PaginatedResponse(BaseModel, Generic[T]):
    """Uniform pagination envelope for admin list endpoints.

    `total` reflects the full filtered row count (ignoring limit/offset), so
    clients can render "Showing 50 of 342" and drive next/prev pagination.
    """

    items: list[T]
    total: int


class AdminStats(BaseModel):
    """Aggregate marketplace statistics. No PHI — counts and dollar amounts only."""

    total_chws: int
    total_members: int
    open_requests: int
    sessions_this_week: int
    claims_pending: int
    claims_paid_this_month: int
    total_earnings_this_month: float
    total_sessions_all_time: int


class CHWAdminItem(BaseModel):
    """Summary of a single CHW for the admin CHW list. No clinical data."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    name: str
    email: str
    phone: str | None
    specializations: list[str]
    languages: list[str]
    zip_code: str | None
    rating: float
    years_experience: int
    is_available: bool
    total_sessions: int
    created_at: datetime


class MemberAdminItem(BaseModel):
    """Summary of a single member for the admin member list.

    Deliberately excludes medi_cal_id (HIPAA PHI — principle of least exposure).
    Insurance provider is also excluded as it can be used to re-identify.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    name: str
    email: str
    phone: str | None
    zip_code: str | None
    primary_language: str
    primary_need: str | None
    rewards_balance: int
    created_at: datetime


class RequestAdminItem(BaseModel):
    """Summary of a service request with denormalized member/CHW names."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    member_name: str | None
    matched_chw_name: str | None
    vertical: str
    urgency: str
    # `description` removed — was free-text PHI member-supplied narrative.
    # Admin dashboard exposes vertical + urgency + status only.
    preferred_mode: str
    status: str
    estimated_units: int
    created_at: datetime


class SessionAdminItem(BaseModel):
    """Session summary for admin view.

    Excludes: notes, gross_amount, session documentation (summary, diagnosis codes,
    resources, member goals) — admin sees operational/financial data only.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    chw_name: str | None
    member_name: str | None
    vertical: str
    status: str
    mode: str
    scheduled_at: datetime | None
    started_at: datetime | None
    ended_at: datetime | None
    duration_minutes: int | None
    units_billed: int | None
    net_amount: float | None
    created_at: datetime


class ClaimAdminItem(BaseModel):
    """Billing claim summary for admin view.

    Excludes diagnosis_codes (PHI), rejection_reason is omitted to prevent
    inadvertent clinical disclosure through error messages.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    chw_name: str | None
    member_name: str | None
    procedure_code: str
    units: int
    gross_amount: float
    platform_fee: float
    pear_suite_fee: float | None
    net_payout: float
    status: str
    service_date: date | None
    submitted_at: datetime | None
    paid_at: datetime | None
