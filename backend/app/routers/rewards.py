"""Rewards router — wellness-points redemption catalog.

Route map
---------
Public (any authenticated user):
  GET  /api/v1/rewards/catalog
      List all active catalog items.

Member-scoped (relationship gate on every {member_id} endpoint):
  GET  /api/v1/members/{member_id}/rewards/balance
      Computed balance: current, lifetime earned, lifetime redeemed,
      next-unlock item + points needed.

  GET  /api/v1/members/{member_id}/rewards/redemptions
      Paginated redemption history, newest first.

  POST /api/v1/members/{member_id}/rewards/redemptions
      Request a redemption. Validates points balance, active/inventory
      status, decrements inventory, writes WellnessPointsLedger entry if
      the Journeys model is available.

Admin / CHW fulfillment:
  PATCH /api/v1/rewards/redemptions/{redemption_id}
      Mark a redemption as fulfilled/failed/cancelled. Members may not
      fulfill their own redemptions.

Relationship gate
-----------------
Every ``{member_id}`` endpoint calls ``_assert_member_access`` which
enforces:
  - Members can only access their own data.
  - CHWs must share at least one session with the member
    (mirrors the ``_assert_shared_session`` gate in communication.py).
  - Admins pass unconditionally.

WellnessPointsLedger integration
---------------------------------
POST /redemptions attempts to import WellnessPointsLedger from
``app.models.journeys`` (owned by the Journeys agent). If the model is
not yet available (ImportError / AttributeError), the redemption still
succeeds but returns HTTP 503 for the ledger write step.

# TODO(journeys-integration): remove the ImportError guard once the Journeys
# agent lands WellnessPointsLedger in app.models.journeys and the migration
# is applied. Link: compass#TBD
"""

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_role
from app.models.rewards import RewardCatalogItem, RewardRedemption
from app.models.user import MemberProfile
from app.schemas.rewards import (
    RewardCatalogItemResponse,
    RewardRedemptionFulfillRequest,
    RewardRedemptionRequest,
    RewardRedemptionResponse,
    WellnessPointsBalanceResponse,
)

# WellnessPointsLedger is owned by the Journeys agent (app.models.journeys).
# Import at module level so SQLAlchemy's Base.metadata discovers the table for
# schema creation (test setup calls Base.metadata.create_all which scans all
# imported subclasses of Base). The try/except guard below is belt-and-suspenders
# for the rare case where the module is missing in a stripped environment.
#
# TODO(journeys-integration): remove the guard once Journeys is confirmed
# deployed in all environments. Link: compass#TBD
try:
    from app.models.journeys import WellnessPointsLedger as _WellnessPointsLedger

    _LEDGER_AVAILABLE = True
except (ImportError, AttributeError):
    _WellnessPointsLedger = None  # type: ignore[assignment,misc]
    _LEDGER_AVAILABLE = False

logger = logging.getLogger("compass.rewards")

router = APIRouter(prefix="/api/v1", tags=["rewards"])


# ─── Helpers ─────────────────────────────────────────────────────────────────


async def _assert_member_access(
    member_id: UUID,
    current_user,
    db: AsyncSession,
) -> None:
    """Enforce the relationship gate for member-scoped reward endpoints.

    Rules:
    - admin: always allowed.
    - member: only their own data (member_id must equal current_user.id).
    - chw: must share at least one session with the member.
    """
    role = current_user.role

    if role == "admin":
        return

    if role == "member":
        if current_user.id != member_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Members may only access their own rewards data.",
            )
        return

    if role == "chw":
        # Mirror the shared-session gate from communication.py.
        from app.models.session import Session

        result = await db.execute(
            select(Session.id)
            .where(
                Session.chw_id == current_user.id,
                Session.member_id == member_id,
            )
            .limit(1)
        )
        if result.scalar_one_or_none() is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "CHWs may only access rewards data for members with whom "
                    "a shared session exists."
                ),
            )
        return

    # Unknown role — deny by default.
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Insufficient permissions.",
    )


async def _get_member_profile_or_404(member_id: UUID, db: AsyncSession) -> MemberProfile:
    """Fetch MemberProfile by user_id or raise 404."""
    result = await db.execute(
        select(MemberProfile).where(MemberProfile.user_id == member_id)
    )
    profile = result.scalar_one_or_none()
    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Member profile not found.",
        )
    return profile


# ─── GET /rewards/catalog ─────────────────────────────────────────────────────


@router.get(
    "/rewards/catalog",
    response_model=list[RewardCatalogItemResponse],
    summary="List active reward catalog items",
)
async def list_catalog(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[RewardCatalogItemResponse]:
    """Return all active catalog items ordered by ascending cost_points.

    Accessible to any authenticated user (member, CHW, admin). Inactive
    items are excluded so members never see unavailable rewards.
    """
    result = await db.execute(
        select(RewardCatalogItem)
        .where(RewardCatalogItem.is_active.is_(True))
        .order_by(RewardCatalogItem.cost_points.asc())
    )
    items = result.scalars().all()
    return [RewardCatalogItemResponse.model_validate(item) for item in items]


# ─── GET /members/{member_id}/rewards/balance ─────────────────────────────────


@router.get(
    "/members/{member_id}/rewards/balance",
    response_model=WellnessPointsBalanceResponse,
    summary="Get member's wellness points balance",
)
async def get_balance(
    member_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WellnessPointsBalanceResponse:
    """Return current balance, lifetime stats, and the next-unlock item.

    ``earned_lifetime`` and ``redeemed_lifetime`` are computed from
    ``MemberProfile.rewards_balance`` and the sum of fulfilled redemptions.
    We use the member_profiles.rewards_balance as the source of truth for
    the current balance (it is updated atomically during redemption).

    ``next_unlock_item`` is the cheapest active item the member cannot yet
    afford. ``points_to_next`` is how many more points are needed.
    """
    await _assert_member_access(member_id, current_user, db)

    profile = await _get_member_profile_or_404(member_id, db)
    current_balance: int = profile.rewards_balance

    # Lifetime redeemed = sum of cost_points_at_redemption across non-failed,
    # non-cancelled redemptions. A single aggregation avoids N+1.
    from sqlalchemy import func as sa_func

    redeemed_result = await db.execute(
        select(sa_func.coalesce(sa_func.sum(RewardRedemption.cost_points_at_redemption), 0))
        .where(
            RewardRedemption.member_id == member_id,
            RewardRedemption.status.in_(["pending", "fulfilled"]),
        )
    )
    redeemed_lifetime: int = redeemed_result.scalar_one()

    # Lifetime earned = current balance + total redeemed (balance starts at 0).
    earned_lifetime: int = current_balance + redeemed_lifetime

    # Next unlock: cheapest item the member cannot yet afford.
    next_result = await db.execute(
        select(RewardCatalogItem)
        .where(
            RewardCatalogItem.is_active.is_(True),
            RewardCatalogItem.cost_points > current_balance,
        )
        .order_by(RewardCatalogItem.cost_points.asc())
        .limit(1)
    )
    next_item_orm = next_result.scalar_one_or_none()
    next_unlock_item = (
        RewardCatalogItemResponse.model_validate(next_item_orm)
        if next_item_orm is not None
        else None
    )
    points_to_next = (
        next_item_orm.cost_points - current_balance
        if next_item_orm is not None
        else 0
    )

    return WellnessPointsBalanceResponse(
        member_id=member_id,
        current_balance=current_balance,
        earned_lifetime=earned_lifetime,
        redeemed_lifetime=redeemed_lifetime,
        next_unlock_item=next_unlock_item,
        points_to_next=points_to_next,
    )


# ─── GET /members/{member_id}/rewards/redemptions ────────────────────────────


@router.get(
    "/members/{member_id}/rewards/redemptions",
    response_model=list[RewardRedemptionResponse],
    summary="List member's redemption history",
)
async def list_redemptions(
    member_id: UUID,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[RewardRedemptionResponse]:
    """Return the member's redemption history, newest first.

    Offset-based pagination. The composite index on
    (member_id, created_at DESC) makes this query efficient.
    """
    await _assert_member_access(member_id, current_user, db)

    result = await db.execute(
        select(RewardRedemption)
        .where(RewardRedemption.member_id == member_id)
        .order_by(desc(RewardRedemption.created_at))
        .limit(limit)
        .offset(offset)
    )
    redemptions = result.scalars().all()
    return [RewardRedemptionResponse.model_validate(r) for r in redemptions]


# ─── POST /members/{member_id}/rewards/redemptions ───────────────────────────


@router.post(
    "/members/{member_id}/rewards/redemptions",
    response_model=RewardRedemptionResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Request a reward redemption",
)
async def create_redemption(
    member_id: UUID,
    body: RewardRedemptionRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RewardRedemptionResponse:
    """Redeem wellness points for a catalog item.

    Validations (in order):
    1. Relationship gate — member can only redeem for themselves.
    2. Catalog item must exist and be active.
    3. Inventory must be available (inventory_remaining > 0 or None).
    4. Member's current points balance must cover the cost.

    On success:
    - Creates a RewardRedemption with status='pending'.
    - Decrements RewardCatalogItem.inventory_remaining if not None.
    - Deducts points from MemberProfile.rewards_balance.
    - Attempts to write a WellnessPointsLedger row (Journeys model).
      If WellnessPointsLedger is not yet deployed, logs a warning and
      returns the redemption anyway with status 201 (ledger write deferred).

    HTTP status codes:
    - 201: redemption created
    - 402: insufficient points balance
    - 404: catalog item not found
    - 409: inventory exhausted
    - 503: WellnessPointsLedger unavailable (Journeys not yet integrated)
    """
    await _assert_member_access(member_id, current_user, db)

    # 1. Fetch catalog item.
    catalog_item = await db.get(RewardCatalogItem, body.catalog_item_id)
    if catalog_item is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Catalog item not found.",
        )

    # 2. Item must be active.
    if not catalog_item.is_active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="This reward is no longer available.",
        )

    # 3. Inventory check.
    if (
        catalog_item.inventory_remaining is not None
        and catalog_item.inventory_remaining <= 0
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This reward is out of stock.",
        )

    # 4. Points balance check.
    profile = await _get_member_profile_or_404(member_id, db)
    if profile.rewards_balance < catalog_item.cost_points:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=(
                f"Insufficient points. "
                f"Required: {catalog_item.cost_points}, "
                f"available: {profile.rewards_balance}."
            ),
        )

    # All checks passed — create the redemption record.
    redemption = RewardRedemption(
        member_id=member_id,
        catalog_item_id=catalog_item.id,
        cost_points_at_redemption=catalog_item.cost_points,
        status="pending",
        requested_at=datetime.now(UTC),
    )
    db.add(redemption)

    # Decrement inventory atomically within this transaction.
    if catalog_item.inventory_remaining is not None:
        catalog_item.inventory_remaining -= 1

    # Deduct points from MemberProfile balance.
    profile.rewards_balance -= catalog_item.cost_points

    # Attempt WellnessPointsLedger write (Journeys-owned model).
    # _LEDGER_AVAILABLE is set at module import time — True when the Journeys
    # model is present in the environment.
    #
    # TODO(journeys-integration): remove the _LEDGER_AVAILABLE guard once
    # Journeys is confirmed deployed in all environments. Link: compass#TBD
    ledger_available = _LEDGER_AVAILABLE
    if ledger_available and _WellnessPointsLedger is not None:
        ledger_entry = _WellnessPointsLedger(
            member_id=member_id,
            points=-catalog_item.cost_points,
            reason="redemption",
            related_id=redemption.id,
        )
        db.add(ledger_entry)
    else:
        logger.warning(
            "rewards: WellnessPointsLedger not available — skipping ledger entry "
            "(member_id=%s, item_sku=%s). "
            "TODO(journeys-integration): integrate when Journeys model lands.",
            member_id,
            catalog_item.sku,
        )

    await db.commit()
    await db.refresh(redemption)

    if not ledger_available:
        # The redemption was created but the ledger write was skipped.
        # Return 503 so the caller knows the integration is incomplete.
        # The row is committed so the admin can see and manually reconcile.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Redemption created but wellness points ledger is unavailable. "
                "Points were deducted from balance. "
                "TODO(journeys-integration): ledger entry will be written "
                "once the Journeys backend is deployed."
            ),
        )

    logger.info(
        "rewards: redemption created id=%s member_id=%s sku=%s points=%d",
        redemption.id,
        member_id,
        catalog_item.sku,
        catalog_item.cost_points,
    )
    return RewardRedemptionResponse.model_validate(redemption)


# ─── PATCH /rewards/redemptions/{redemption_id} ───────────────────────────────


@router.patch(
    "/rewards/redemptions/{redemption_id}",
    response_model=RewardRedemptionResponse,
    summary="Fulfill or update a redemption (CHW / admin only)",
)
async def fulfill_redemption(
    redemption_id: UUID,
    body: RewardRedemptionFulfillRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RewardRedemptionResponse:
    """Mark a redemption as fulfilled, failed, or cancelled.

    Only CHWs and admins may call this endpoint. Members cannot fulfill
    their own redemptions (prevents self-service status manipulation).

    Allowed target statuses: 'fulfilled', 'cancelled', 'failed'.
    When status='failed', a failure_reason must be provided.
    """
    # Role gate: CHW or admin only.
    if current_user.role not in ("chw", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only CHWs and admins may fulfill redemptions.",
        )

    allowed_statuses = {"fulfilled", "cancelled", "failed"}
    if body.status not in allowed_statuses:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid status. Must be one of: {', '.join(sorted(allowed_statuses))}.",
        )

    if body.status == "failed" and not body.failure_reason:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="failure_reason is required when status is 'failed'.",
        )

    redemption = await db.get(RewardRedemption, redemption_id)
    if redemption is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Redemption not found.",
        )

    if redemption.status not in ("pending",):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot transition from '{redemption.status}' to '{body.status}'.",
        )

    redemption.status = body.status
    redemption.fulfillment_reference = body.fulfillment_reference
    if body.status == "fulfilled":
        redemption.fulfilled_at = datetime.now(UTC)
    if body.failure_reason:
        redemption.failure_reason = body.failure_reason

    await db.commit()
    await db.refresh(redemption)

    logger.info(
        "rewards: redemption %s marked %s by %s (role=%s)",
        redemption_id,
        body.status,
        current_user.id,
        current_user.role,
    )
    return RewardRedemptionResponse.model_validate(redemption)
