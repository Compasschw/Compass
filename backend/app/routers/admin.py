"""Admin dashboard — cookie-protected HTML page to view waitlist submissions.

Flow:
- GET /admin/waitlist  → shows login form OR data page based on httpOnly cookie
- POST /admin/waitlist/login (form data: key) → validates, sets httpOnly cookie, redirects
- POST /admin/waitlist/logout → clears cookie

The admin key lives in config (env var ADMIN_KEY) with a 16-char minimum enforced at startup.
Once authenticated, the cookie is HttpOnly + Secure + SameSite=Strict — the key never
appears in URLs, logs, or browser history.
"""

from datetime import UTC, timedelta, timezone

from fastapi import APIRouter, Cookie, Depends, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.waitlist import WaitlistEntry

PT = timezone(timedelta(hours=-7))  # Pacific Daylight Time (UTC-7)
COOKIE_NAME = "compass_admin"
COOKIE_MAX_AGE = 60 * 60 * 4  # 4 hours

router = APIRouter(prefix="/admin", tags=["admin"])


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
                <form method="POST" action="/admin/waitlist/login">
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

    response = RedirectResponse(url="/admin/waitlist", status_code=303)
    response.set_cookie(
        key=COOKIE_NAME,
        value=settings.admin_key,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=True,
        samesite="strict",
        path="/admin",
    )
    return response


@router.post("/waitlist/logout")
async def admin_logout() -> RedirectResponse:
    response = RedirectResponse(url="/admin/waitlist", status_code=303)
    response.delete_cookie(key=COOKIE_NAME, path="/admin")
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
                <a href="/admin/waitlist" class="refresh">Refresh</a>
                <form class="inline" method="POST" action="/admin/waitlist/logout">
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
