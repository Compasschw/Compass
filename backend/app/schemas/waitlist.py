from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class WaitlistCreate(BaseModel):
    """Payload for joining the waitlist."""

    first_name: str = Field(..., min_length=1, max_length=100)
    last_name: str = Field(..., min_length=1, max_length=100)
    email: EmailStr
    role: str = Field(..., pattern="^(member|chw|organization|other)$")


class WaitlistResponse(BaseModel):
    """Serialised waitlist entry returned to the client."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    first_name: str
    last_name: str
    email: str
    role: str
    created_at: datetime
