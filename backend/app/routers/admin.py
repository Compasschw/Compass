"""Admin dashboard — cookie-protected HTML page to view waitlist submissions,
plus read-only JSON API endpoints for live marketplace monitoring.

HTML flow (cookie-auth):
- GET  /api/v1/admin/waitlist          → login form OR data page
- POST /api/v1/admin/waitlist/login    → validates key, sets httpOnly cookie, redirects
- POST /api/v1/admin/waitlist/logout   → clears cookie

JSON API (Bearer-key auth via require_admin_key):
- GET /api/v1/admin/stats
- GET /api/v1/admin/chws
- GET /api/v1/admin/members
- GET /api/v1/admin/requests
- GET /api/v1/admin/sessions
- GET /api/v1/admin/claims

The admin key lives in config (env var ADMIN_KEY) with a 16-char minimum enforced at startup.
Once authenticated, the HTML cookie is HttpOnly + Secure + SameSite=Strict — the key never
appears in URLs, logs, or browser history.

HIPAA guardrails: JSON responses never include medi_cal_id, diagnosis_codes, session notes,
session documentation text, or recording transcripts.
"""

from datetime import UTC, datetime, timedelta, timezone

from fastapi import APIRouter, Cookie, Depends, Form, Query
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.config import settings
from app.database import get_db
from app.dependencies import require_admin_key
from app.models.billing import BillingClaim
from app.models.request import ServiceRequest
from app.models.session import Session
from app.models.user import CHWProfile, MemberProfile, User
from app.models.waitlist import WaitlistEntry
from app.schemas.admin import (
    AdminStats,
    CHWAdminItem,
    ClaimAdminItem,
    MemberAdminItem,
    PaginatedResponse,
    RequestAdminItem,
    SessionAdminItem,
)

PT = timezone(timedelta(hours=-7))  # Pacific Daylight Time (UTC-7)
COOKIE_NAME = "compass_admin"
COOKIE_MAX_AGE = 60 * 60 * 4  # 4 hours
_ADMIN_PREFIX = "/api/v1/admin"

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


def _is_authenticated(cookie_value: str | None) -> bool:
    """Constant-time compare of cookie value against configured admin key."""
    if not cookie_value:
        return False
    import hmac
    return hmac.compare_digest(cookie_value, settings.admin_key)


def _login_page(error: str = "") -> HTMLResponse:
    error_html = f'<p style="color:#C44;font-size:13px;margin-bottom:16px;">{error}</p>' if error else ""
    return HTMLResponse(
        content=f"""
        <!DOCTYPE html>
        <html>
        <head><title>Compass Admin</title>
        <style>
            body {{ font-family: 'Inter', system-ui, sans-serif; background: #F4F1ED; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }}
            .card {{ background: white; border-radius: 20px; padding: 40px; max-width: 400px; width: 100%; box-shadow: 0 4px 24px rgba(61,90,62,0.1); text-align: center; }}
            h1 {{ color: #1E3320; font-size: 24px; margin-bottom: 8px; }}
            p {{ color: #6B7A6B; font-size: 14px; margin-bottom: 24px; }}
            form {{ display: flex; flex-direction: column; gap: 12px; }}
            input {{ padding: 14px 16px; border: 1px solid #DDD6CC; border-radius: 12px; font-size: 14px; outline: none; }}
            input:focus {{ border-color: #3D5A3E; }}
            button {{ background: #3D5A3E; color: white; border: none; padding: 14px; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; }}
            button:hover {{ background: #2C4A2E; }}
        </style>
        </head>
        <body>
            <div class="card">
                <h1>CompassCHW Admin</h1>
                <p>Enter admin password to view waitlist submissions.</p>
                {error_html}
                <form method="POST" action="/api/v1/admin/waitlist/login">
                    <input type="password" name="key" placeholder="Admin password" required autofocus />
                    <button type="submit">View Submissions</button>
                </form>
            </div>
        </body>
        </html>
        """,
        status_code=200,
    )


@router.post("/waitlist/login")
async def admin_login(key: str = Form(...)) -> RedirectResponse:
    """Validate admin key and set httpOnly cookie. Key never appears in URL."""
    import hmac
    if not hmac.compare_digest(key, settings.admin_key):
        # Don't leak timing or specifics — just re-render the login page with a generic error
        return HTMLResponse(
            content=_login_page(error="Invalid password.").body,
            status_code=401,
        )

    response = RedirectResponse(url="/api/v1/admin/waitlist", status_code=303)
    response.set_cookie(
        key=COOKIE_NAME,
        value=settings.admin_key,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=True,
        samesite="strict",
        path="/api/v1/admin",
    )
    return response


@router.post("/waitlist/logout")
async def admin_logout() -> RedirectResponse:
    response = RedirectResponse(url="/api/v1/admin/waitlist", status_code=303)
    response.delete_cookie(key=COOKIE_NAME, path="/api/v1/admin")
    return response


@router.get("/waitlist", response_class=HTMLResponse)
async def admin_waitlist_page(
    db: AsyncSession = Depends(get_db),
    compass_admin: str | None = Cookie(default=None),
) -> HTMLResponse:
    """Show waitlist submissions if authenticated, otherwise show login form."""
    if not _is_authenticated(compass_admin):
        return _login_page()

    # Fetch all waitlist entries
    result = await db.execute(
        select(WaitlistEntry).order_by(WaitlistEntry.created_at.desc())
    )
    entries = list(result.scalars().all())

    # Count
    count_result = await db.execute(
        select(func.count()).select_from(WaitlistEntry)
    )
    total = count_result.scalar() or 0

    # Build table rows
    rows_html = ""
    for i, entry in enumerate(entries, 1):
        role_color = {
            "chw": "#3D5A3E",
            "member": "#7A9F5A",
            "organization": "#D4A030",
        }.get(entry.role, "#6B7A6B")

        rows_html += f"""
        <tr>
            <td>{i}</td>
            <td><strong>{entry.first_name} {entry.last_name}</strong></td>
            <td><a href="mailto:{entry.email}" style="color: #3D5A3E;">{entry.email}</a></td>
            <td><span style="background: {role_color}15; color: {role_color}; padding: 4px 10px; border-radius: 100px; font-size: 12px; font-weight: 600;">{entry.role.upper()}</span></td>
            <td>{entry.created_at.replace(tzinfo=UTC).astimezone(PT).strftime('%b %d, %Y %I:%M %p PT')}</td>
        </tr>
        """

    return HTMLResponse(content=f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Compass Admin — Waitlist ({total})</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
            * {{ box-sizing: border-box; margin: 0; padding: 0; }}
            body {{ font-family: 'Inter', system-ui, sans-serif; background: #F4F1ED; color: #1E3320; padding: 24px; }}
            .header {{ max-width: 1200px; margin: 0 auto 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }}
            h1 {{ font-size: 28px; font-weight: 700; }}
            h1 span {{ color: #7A9F5A; }}
            .badge {{ background: #3D5A3E; color: white; padding: 8px 20px; border-radius: 100px; font-size: 14px; font-weight: 600; }}
            .card {{ background: white; border-radius: 16px; max-width: 1200px; margin: 0 auto; overflow: hidden; box-shadow: 0 4px 24px rgba(61,90,62,0.08); }}
            table {{ width: 100%; border-collapse: collapse; }}
            th {{ background: #F4F1ED; text-align: left; padding: 14px 20px; font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: #6B7A6B; }}
            td {{ padding: 14px 20px; border-top: 1px solid #EDE8E0; font-size: 14px; }}
            tr:hover td {{ background: #FAFAF8; }}
            a {{ text-decoration: none; }}
            a:hover {{ text-decoration: underline; }}
            .empty {{ text-align: center; padding: 60px 20px; color: #6B7A6B; }}
            .refresh {{ color: #6B7A6B; font-size: 13px; text-decoration: none; background: none; border: none; cursor: pointer; font-family: inherit; }}
            .refresh:hover {{ color: #3D5A3E; }}
            form.inline {{ display: inline; }}
        </style>
    </head>
    <body>
        <div class="header">
            <h1>Compass<span>CHW</span> Waitlist</h1>
            <div style="display: flex; align-items: center; gap: 16px;">
                <a href="/api/v1/admin/waitlist" class="refresh">Refresh</a>
                <form class="inline" method="POST" action="/api/v1/admin/waitlist/logout">
                    <button type="submit" class="refresh">Logout</button>
                </form>
                <div class="badge">{total} submission{'s' if total != 1 else ''}</div>
            </div>
        </div>
        <div class="card">
            {'<table><thead><tr><th>#</th><th>Name</th><th>Email</th><th>Role</th><th>Signed Up</th></tr></thead><tbody>' + rows_html + '</tbody></table>' if entries else '<div class="empty">No waitlist submissions yet.</div>'}
        </div>
    </body>
    </html>
    """)


# ─── Read-only JSON API endpoints ─────────────────────────────────────────────
# All require Authorization: Bearer <ADMIN_KEY>. No PHI exposed.
# ──────────────────────────────────────────────────────────────────────────────

_MAX_LIMIT = 500
_DEFAULT_LIMIT = 50


@router.get("/stats", response_model=AdminStats, summary="Aggregate marketplace stats")
async def get_admin_stats(
    _: bool = Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> AdminStats:
    """Return a single aggregate snapshot of marketplace activity.

    Counts and dollar amounts only — no individual records, no PHI.
    """
    now = datetime.now(UTC)
    week_ago = now - timedelta(days=7)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    # CHW and member head counts
    total_chws_result = await db.execute(
        select(func.count()).select_from(User).where(User.role == "chw")
    )
    total_chws: int = total_chws_result.scalar() or 0

    total_members_result = await db.execute(
        select(func.count()).select_from(User).where(User.role == "member")
    )
    total_members: int = total_members_result.scalar() or 0

    # Open service requests
    open_requests_result = await db.execute(
        select(func.count()).select_from(ServiceRequest).where(ServiceRequest.status == "open")
    )
    open_requests: int = open_requests_result.scalar() or 0

    # Sessions completed in the last 7 days
    sessions_week_result = await db.execute(
        select(func.count())
        .select_from(Session)
        .where(Session.status == "completed")
        .where(Session.ended_at >= week_ago)
    )
    sessions_this_week: int = sessions_week_result.scalar() or 0

    # Pending billing claims
    claims_pending_result = await db.execute(
        select(func.count()).select_from(BillingClaim).where(BillingClaim.status == "pending")
    )
    claims_pending: int = claims_pending_result.scalar() or 0

    # Paid claims this calendar month
    claims_paid_result = await db.execute(
        select(func.count())
        .select_from(BillingClaim)
        .where(BillingClaim.status == "paid")
        .where(BillingClaim.paid_at >= month_start)
    )
    claims_paid_this_month: int = claims_paid_result.scalar() or 0

    # Total net earnings paid out this calendar month
    earnings_result = await db.execute(
        select(func.coalesce(func.sum(BillingClaim.net_payout), 0))
        .where(BillingClaim.status == "paid")
        .where(BillingClaim.paid_at >= month_start)
    )
    total_earnings_this_month: float = float(earnings_result.scalar() or 0)

    # All-time session count
    all_time_result = await db.execute(select(func.count()).select_from(Session))
    total_sessions_all_time: int = all_time_result.scalar() or 0

    return AdminStats(
        total_chws=total_chws,
        total_members=total_members,
        open_requests=open_requests,
        sessions_this_week=sessions_this_week,
        claims_pending=claims_pending,
        claims_paid_this_month=claims_paid_this_month,
        total_earnings_this_month=total_earnings_this_month,
        total_sessions_all_time=total_sessions_all_time,
    )


@router.get(
    "/chws",
    response_model=PaginatedResponse[CHWAdminItem],
    summary="List all CHWs (admin)",
)
async def list_admin_chws(
    limit: int = Query(default=_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    _: bool = Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[CHWAdminItem]:
    """Return paginated CHW list joined with User for name/email/phone.

    No clinical data. Ordered by CHWProfile.created_at DESC.
    """
    total_result = await db.execute(
        select(func.count()).select_from(CHWProfile)
    )
    total: int = total_result.scalar() or 0

    stmt = (
        select(
            CHWProfile.id,
            CHWProfile.user_id,
            User.name,
            User.email,
            User.phone,
            CHWProfile.specializations,
            CHWProfile.languages,
            CHWProfile.zip_code,
            CHWProfile.rating,
            CHWProfile.years_experience,
            CHWProfile.is_available,
            CHWProfile.total_sessions,
            CHWProfile.created_at,
        )
        .join(User, CHWProfile.user_id == User.id)
        .order_by(CHWProfile.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    rows = (await db.execute(stmt)).all()
    items = [
        CHWAdminItem(
            id=row.id,
            user_id=row.user_id,
            name=row.name,
            email=row.email,
            phone=row.phone,
            specializations=row.specializations or [],
            languages=row.languages or [],
            zip_code=row.zip_code,
            rating=row.rating,
            years_experience=row.years_experience,
            is_available=row.is_available,
            total_sessions=row.total_sessions,
            created_at=row.created_at,
        )
        for row in rows
    ]
    return PaginatedResponse[CHWAdminItem](items=items, total=total)


@router.get(
    "/members",
    response_model=PaginatedResponse[MemberAdminItem],
    summary="List all members (admin)",
)
async def list_admin_members(
    limit: int = Query(default=_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    _: bool = Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[MemberAdminItem]:
    """Return paginated member list joined with User for name/email/phone.

    medi_cal_id is explicitly excluded — HIPAA PHI, principle of least exposure.
    insurance_provider is also excluded to prevent re-identification.
    Ordered by MemberProfile.created_at DESC.
    """
    total_result = await db.execute(
        select(func.count()).select_from(MemberProfile)
    )
    total: int = total_result.scalar() or 0

    stmt = (
        select(
            MemberProfile.id,
            MemberProfile.user_id,
            User.name,
            User.email,
            User.phone,
            MemberProfile.zip_code,
            MemberProfile.primary_language,
            MemberProfile.primary_need,
            MemberProfile.rewards_balance,
            MemberProfile.created_at,
        )
        .join(User, MemberProfile.user_id == User.id)
        .order_by(MemberProfile.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    rows = (await db.execute(stmt)).all()
    items = [
        MemberAdminItem(
            id=row.id,
            user_id=row.user_id,
            name=row.name,
            email=row.email,
            phone=row.phone,
            zip_code=row.zip_code,
            primary_language=row.primary_language,
            primary_need=row.primary_need,
            rewards_balance=row.rewards_balance,
            created_at=row.created_at,
        )
        for row in rows
    ]
    return PaginatedResponse[MemberAdminItem](items=items, total=total)


@router.get(
    "/requests",
    response_model=PaginatedResponse[RequestAdminItem],
    summary="List service requests (admin)",
)
async def list_admin_requests(
    status: str | None = Query(default=None, description="Filter by status (open, matched, completed, cancelled)"),
    limit: int = Query(default=_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    _: bool = Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[RequestAdminItem]:
    """Return paginated service requests with denormalized member and CHW names.

    matched_chw_name is null when matched_chw_id is null.
    Ordered by ServiceRequest.created_at DESC.
    """
    MemberUser = aliased(User)
    CHWUser = aliased(User)

    count_stmt = select(func.count()).select_from(ServiceRequest)
    if status is not None:
        count_stmt = count_stmt.where(ServiceRequest.status == status)
    total: int = (await db.execute(count_stmt)).scalar() or 0

    stmt = (
        select(
            ServiceRequest.id,
            MemberUser.name.label("member_name"),
            CHWUser.name.label("matched_chw_name"),
            ServiceRequest.vertical,
            ServiceRequest.urgency,
            ServiceRequest.description,
            ServiceRequest.preferred_mode,
            ServiceRequest.status,
            ServiceRequest.estimated_units,
            ServiceRequest.created_at,
        )
        .join(MemberUser, ServiceRequest.member_id == MemberUser.id)
        .outerjoin(CHWUser, ServiceRequest.matched_chw_id == CHWUser.id)
        .order_by(ServiceRequest.created_at.desc())
    )

    if status is not None:
        stmt = stmt.where(ServiceRequest.status == status)

    stmt = stmt.limit(limit).offset(offset)
    rows = (await db.execute(stmt)).all()

    items = [
        RequestAdminItem(
            id=row.id,
            member_name=row.member_name,
            matched_chw_name=row.matched_chw_name,
            vertical=row.vertical,
            urgency=row.urgency,
            description=row.description,
            preferred_mode=row.preferred_mode,
            status=row.status,
            estimated_units=row.estimated_units,
            created_at=row.created_at,
        )
        for row in rows
    ]
    return PaginatedResponse[RequestAdminItem](items=items, total=total)


@router.get(
    "/sessions",
    response_model=PaginatedResponse[SessionAdminItem],
    summary="List sessions (admin)",
)
async def list_admin_sessions(
    status: str | None = Query(default=None, description="Filter by status (scheduled, in_progress, completed, cancelled)"),
    limit: int = Query(default=_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    _: bool = Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[SessionAdminItem]:
    """Return paginated sessions with denormalized CHW and member names.

    Uses aliased User joins (same pattern as sessions.py) to fetch both
    chw_name and member_name without an N+1 query.

    Excludes: notes, gross_amount, session documentation, transcripts.
    Ordered by Session.created_at DESC.
    """
    CHWUser = aliased(User)
    MemberUser = aliased(User)

    count_stmt = select(func.count()).select_from(Session)
    if status is not None:
        count_stmt = count_stmt.where(Session.status == status)
    total: int = (await db.execute(count_stmt)).scalar() or 0

    stmt = (
        select(
            Session.id,
            CHWUser.name.label("chw_name"),
            MemberUser.name.label("member_name"),
            Session.vertical,
            Session.status,
            Session.mode,
            Session.scheduled_at,
            Session.started_at,
            Session.ended_at,
            Session.duration_minutes,
            Session.units_billed,
            Session.net_amount,
            Session.created_at,
        )
        .join(CHWUser, Session.chw_id == CHWUser.id)
        .join(MemberUser, Session.member_id == MemberUser.id)
        .order_by(Session.created_at.desc())
    )

    if status is not None:
        stmt = stmt.where(Session.status == status)

    stmt = stmt.limit(limit).offset(offset)
    rows = (await db.execute(stmt)).all()

    items = [
        SessionAdminItem(
            id=row.id,
            chw_name=row.chw_name,
            member_name=row.member_name,
            vertical=row.vertical,
            status=row.status,
            mode=row.mode,
            scheduled_at=row.scheduled_at,
            started_at=row.started_at,
            ended_at=row.ended_at,
            duration_minutes=row.duration_minutes,
            units_billed=row.units_billed,
            net_amount=float(row.net_amount) if row.net_amount is not None else None,
            created_at=row.created_at,
        )
        for row in rows
    ]
    return PaginatedResponse[SessionAdminItem](items=items, total=total)


@router.get(
    "/claims",
    response_model=PaginatedResponse[ClaimAdminItem],
    summary="List billing claims (admin)",
)
async def list_admin_claims(
    status: str | None = Query(default=None, description="Filter by status (pending, submitted, paid, rejected)"),
    limit: int = Query(default=_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    _: bool = Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[ClaimAdminItem]:
    """Return paginated billing claims with denormalized CHW and member names.

    Uses aliased User joins for chw_name and member_name.

    Excludes: diagnosis_codes (PHI), rejection_reason, pear_suite_claim_id,
    stripe_transfer_id, adjudicated_at — admin sees billing lifecycle data only.
    Ordered by BillingClaim.created_at DESC.
    """
    CHWUser = aliased(User)
    MemberUser = aliased(User)

    count_stmt = select(func.count()).select_from(BillingClaim)
    if status is not None:
        count_stmt = count_stmt.where(BillingClaim.status == status)
    total: int = (await db.execute(count_stmt)).scalar() or 0

    stmt = (
        select(
            BillingClaim.id,
            CHWUser.name.label("chw_name"),
            MemberUser.name.label("member_name"),
            BillingClaim.procedure_code,
            BillingClaim.units,
            BillingClaim.gross_amount,
            BillingClaim.platform_fee,
            BillingClaim.pear_suite_fee,
            BillingClaim.net_payout,
            BillingClaim.status,
            BillingClaim.service_date,
            BillingClaim.submitted_at,
            BillingClaim.paid_at,
        )
        .join(CHWUser, BillingClaim.chw_id == CHWUser.id)
        .join(MemberUser, BillingClaim.member_id == MemberUser.id)
        .order_by(BillingClaim.created_at.desc())
    )

    if status is not None:
        stmt = stmt.where(BillingClaim.status == status)

    stmt = stmt.limit(limit).offset(offset)
    rows = (await db.execute(stmt)).all()

    items = [
        ClaimAdminItem(
            id=row.id,
            chw_name=row.chw_name,
            member_name=row.member_name,
            procedure_code=row.procedure_code,
            units=row.units,
            gross_amount=float(row.gross_amount),
            platform_fee=float(row.platform_fee),
            pear_suite_fee=float(row.pear_suite_fee) if row.pear_suite_fee is not None else None,
            net_payout=float(row.net_payout),
            status=row.status,
            service_date=row.service_date,
            submitted_at=row.submitted_at,
            paid_at=row.paid_at,
        )
        for row in rows
    ]
    return PaginatedResponse[ClaimAdminItem](items=items, total=total)
