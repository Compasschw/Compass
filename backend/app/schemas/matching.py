from pydantic import BaseModel

from app.schemas.user import CHWProfileResponse


class MatchResult(BaseModel):
    chw: CHWProfileResponse
    score: float
    distance_miles: float
