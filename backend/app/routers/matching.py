from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.services.matching_service import find_matching_chws

router = APIRouter(prefix="/api/v1/matching", tags=["matching"])

@router.get("/chws")
async def find_chws(
    vertical: str = Query(...),
    lat: float = Query(default=34.0522),
    lng: float = Query(default=-118.2437),
    language: str = Query(default="English"),
    limit: int = Query(default=10, le=50),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    results = await find_matching_chws(db, vertical, lat, lng, language, limit)
    return {"matches": [{"chw_id": str(r["chw"].id), "score": r["score"], "distance_miles": r["distance_miles"]} for r in results]}
