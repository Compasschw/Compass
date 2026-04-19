from uuid import UUID

from pydantic import BaseModel, ConfigDict


class CHWProfileCreate(BaseModel):
    specializations: list[str] = []
    languages: list[str] = []
    bio: str | None = None
    zip_code: str | None = None
    phone: str | None = None

class CHWProfileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    user_id: UUID
    specializations: list[str]
    languages: list[str]
    rating: float
    years_experience: int
    total_sessions: int
    is_available: bool
    bio: str | None
    zip_code: str | None

class CHWProfileUpdate(BaseModel):
    specializations: list[str] | None = None
    languages: list[str] | None = None
    bio: str | None = None
    zip_code: str | None = None
    is_available: bool | None = None

class MemberProfileCreate(BaseModel):
    zip_code: str | None = None
    primary_language: str = "English"
    primary_need: str | None = None
    insurance_provider: str | None = None

class MemberProfileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    user_id: UUID
    zip_code: str | None
    primary_language: str
    primary_need: str | None
    rewards_balance: int

class MemberProfileUpdate(BaseModel):
    zip_code: str | None = None
    primary_language: str | None = None
    primary_need: str | None = None
    insurance_provider: str | None = None
    preferred_mode: str | None = None
