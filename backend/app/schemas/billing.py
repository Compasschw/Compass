from datetime import datetime
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
