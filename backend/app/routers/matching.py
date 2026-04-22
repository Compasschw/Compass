"""CHW match endpoints — find CHWs suited to a member's request."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.services.matching_service import find_matching_chws

router = APIRouter(prefix="/api/v1/matching", tags=["matching"])


@router.get("/chws")
async def find_chws(
    vertical: str = Query(..., description="Service vertical (housing, rehab, food, mental_health, healthcare)."),
    lat: float = Query(default=34.0522),
    lng: float = Query(default=-118.2437),
    language: str = Query(default="English"),
    limit: int = Query(default=10, le=50),
    mode: str | None = Query(default=None, description="in_person | remote | hybrid"),
    urgency: str | None = Query(default=None, description="routine | soon | urgent"),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Rank available CHWs for the given request.

    Pass the optional `mode` and `urgency` params to get intake-aware
    matching (language fluency, specialization, modality preference, home-
    visit comfort, urgent-outreach availability) layered on top of the
    baseline profile scoring.
    """
    results = await find_matching_chws(
        db,
        vertical=vertical,
        member_lat=lat,
        member_lng=lng,
        member_language=language,
        limit=limit,
        mode=mode,
        urgency=urgency,
    )
    return {
        "matches": [
            {
                "chw_id": str(r["chw"].user_id),
                "score": r["score"],
                "distance_miles": r["distance_miles"],
                "match_reasons": r["match_reasons"],
            }
            for r in results
        ]
    }
