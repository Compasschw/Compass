from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.waitlist import WaitlistEntry
from app.schemas.waitlist import WaitlistCreate, WaitlistResponse

router = APIRouter(prefix="/api/v1/waitlist", tags=["waitlist"])


@router.post("/", response_model=WaitlistResponse, status_code=201)
async def create_waitlist_entry(
    data: WaitlistCreate, db: AsyncSession = Depends(get_db)
) -> WaitlistEntry:
    """Public endpoint -- no auth required."""
    existing = await db.execute(
        select(WaitlistEntry).where(WaitlistEntry.email == data.email)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=409, detail="This email is already on the waitlist"
        )

    entry = WaitlistEntry(
        first_name=data.first_name,
        last_name=data.last_name,
        email=data.email,
        role=data.role,
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return entry


# NOTE: the admin-facing list endpoint moved to GET /api/v1/admin/waitlist/entries
# (routers/admin.py). It is gated by admin_key + 2FA token, matching the rest of
# the admin JSON API. The previous list endpoint here required only admin_key,
# which created an unprotected path around the 2FA gate.


@router.get("/count")
async def waitlist_count(
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    """Public endpoint -- returns total waitlist count."""
    result = await db.execute(select(func.count()).select_from(WaitlistEntry))
    count = result.scalar() or 0
    return {"count": count}
