import math
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


def haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 3959  # Earth radius in miles
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def score_chw(chw, vertical: str, member_lat: float, member_lng: float, member_language: str) -> float:
    # Vertical match (required)
    if vertical not in (chw.specializations or []):
        return -1

    score = 0.0

    # Geographic proximity (40%)
    if chw.latitude and chw.longitude:
        dist = haversine(chw.latitude, chw.longitude, member_lat, member_lng)
        if dist <= 5:
            score += 40
        elif dist <= 15:
            score += 30
        elif dist <= 30:
            score += 15

    # Language match (25%)
    if member_language in (chw.languages or []):
        score += 25

    # Availability (20%)
    if chw.is_available:
        score += 20

    # Rating + experience (15%)
    score += (chw.rating / 5.0) * 10
    score += min(chw.years_experience, 10) * 0.5

    return score


async def find_matching_chws(db: AsyncSession, vertical: str, member_lat: float, member_lng: float, member_language: str, limit: int = 10):
    from app.models.user import CHWProfile
    result = await db.execute(select(CHWProfile).where(CHWProfile.is_available == True))
    chws = result.scalars().all()

    scored = []
    for chw in chws:
        s = score_chw(chw, vertical, member_lat, member_lng, member_language)
        if s >= 0:
            dist = haversine(chw.latitude or 0, chw.longitude or 0, member_lat, member_lng) if chw.latitude else 999
            scored.append({"chw": chw, "score": s, "distance_miles": round(dist, 1)})

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:limit]
