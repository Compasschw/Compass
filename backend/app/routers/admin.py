"""
Admin dashboard — password-protected HTML page to view waitlist submissions.

Access: GET /admin/waitlist?key=YOUR_ADMIN_KEY
"""

from fastapi import APIRouter, Depends, Query, HTTPException
from fastapi.responses import HTMLResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.waitlist import WaitlistEntry

router = APIRouter(prefix="/admin", tags=["admin"])

ADMIN_KEY = "CompassProd2026"


@router.get("/waitlist", response_class=HTMLResponse)
async def admin_waitlist_page(
    key: str = Query(default=""),
    db: AsyncSession = Depends(get_db),
) -> str:
    """Password-protected admin page showing all waitlist submissions."""

    if key != ADMIN_KEY:
        return HTMLResponse(
            content="""
            <!DOCTYPE html>
            <html>
            <head><title>Compass Admin</title>
            <style>
                body { font-family: 'Inter', system-ui, sans-serif; background: #F4F1ED; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
                .card { background: white; border-radius: 20px; padding: 40px; max-width: 400px; width: 100%; box-shadow: 0 4px 24px rgba(61,90,62,0.1); text-align: center; }
                h1 { color: #1E3320; font-size: 24px; margin-bottom: 8px; }
                p { color: #6B7A6B; font-size: 14px; margin-bottom: 24px; }
                form { display: flex; flex-direction: column; gap: 12px; }
                input { padding: 14px 16px; border: 1px solid #DDD6CC; border-radius: 12px; font-size: 14px; outline: none; }
                input:focus { border-color: #3D5A3E; }
                button { background: #3D5A3E; color: white; border: none; padding: 14px; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; }
                button:hover { background: #2C4A2E; }
            </style>
            </head>
            <body>
                <div class="card">
                    <h1>CompassCHW Admin</h1>
                    <p>Enter admin password to view waitlist submissions.</p>
                    <form method="GET" action="/admin/waitlist">
                        <input type="password" name="key" placeholder="Admin password" required />
                        <button type="submit">View Submissions</button>
                    </form>
                </div>
            </body>
            </html>
            """,
            status_code=200,
        )

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
            <td>{entry.created_at.strftime('%b %d, %Y %I:%M %p')}</td>
        </tr>
        """

    return f"""
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
            .refresh {{ color: #6B7A6B; font-size: 13px; text-decoration: none; }}
            .refresh:hover {{ color: #3D5A3E; }}
        </style>
    </head>
    <body>
        <div class="header">
            <h1>Compass<span>CHW</span> Waitlist</h1>
            <div style="display: flex; align-items: center; gap: 16px;">
                <a href="/admin/waitlist?key={ADMIN_KEY}" class="refresh">Refresh</a>
                <div class="badge">{total} submission{'s' if total != 1 else ''}</div>
            </div>
        </div>
        <div class="card">
            {'<table><thead><tr><th>#</th><th>Name</th><th>Email</th><th>Role</th><th>Signed Up</th></tr></thead><tbody>' + rows_html + '</tbody></table>' if entries else '<div class="empty">No waitlist submissions yet.</div>'}
        </div>
    </body>
    </html>
    """
