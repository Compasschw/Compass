from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class ClaimResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    session_id: UUID
    diagnosis_codes: list[str] | None
    procedure_code: str
    units: int
    gross_amount: float
    platform_fee: float
    net_payout: float
    status: str
    created_at: datetime

class EarningsSummary(BaseModel):
    this_month: float
    all_time: float
    avg_rating: float
    sessions_this_week: int
    pending_payout: float
    # ── Earnings page cards (additive; default-safe for existing callers) ──────
    # earnings_this_period / paid_this_period respect the ?period= selector
    # (this_month | last_month). pending_payout is all outstanding (not period
    # scoped) — "when do I get paid" is about every unpaid claim.
    earnings_this_period: float = 0.0
    paid_this_period: float = 0.0
    # True when there's an outstanding balance moving to the CHW ("In transit").
    pending_in_transit: bool = False
    # Estimated next weekly (Friday) payout date when a balance is pending.
    next_payout_date: date | None = None
    # QA-batch #14: real, server-computed all-time earnings for the CHW
    # Dashboard's "Earnings" tile — SUM(BillingClaim.gross_amount) across every
    # claim, not paginated (GET /chw/claims caps at 200, so a client-side sum
    # would silently truncate for an active CHW). Distinct from `all_time`
    # above, which sums `net_payout` (the CHW's post-fee share) for the
    # Earnings-page "All time" card — total_earned_all_time is the GROSS
    # amount billed, matching the dashboard tile's "Earnings" label.
    total_earned_all_time: float = 0.0


class SessionEarningItem(BaseModel):
    """One completed session's earnings, for the Sessions Completed table."""

    session_id: UUID
    service_date: date | None
    # Actual session start/end timestamps (Session.started_at / ended_at).
    # Nullable: not every claim has a tracked session start/end (e.g. a
    # phone session that was never formally started, or a manually-created
    # claim). The Earnings "Session Detail" modal shows date + time when
    # present, and falls back to service_date for the start row otherwise.
    started_at: datetime | None
    ended_at: datetime | None
    member_name: str
    session_mode: str
    units: int
    amount_earned: float
    # "paid" once the net share reached the CHW, else "pending".
    payment_status: str


class PayoutItem(BaseModel):
    """One payout to the CHW, for the Recent Payouts table.

    Sourced from paid BillingClaims (no separate payout ledger today): the Stripe
    transfer that moved the CHW's net share is the payout. ``reference`` is the
    Stripe transfer id; ``method`` is a generic label (Stripe is the source of
    truth for bank details).
    """

    date: datetime | None
    amount: float
    status: str
    method: str
    reference: str | None
