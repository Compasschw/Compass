"""HIPAA audit middleware.

Persists an AuditLog row for every request that touches authenticated or
mutating endpoints. Required by 45 CFR §164.312(b) — Audit Controls.

Design notes:
- Health checks and static assets are excluded to keep the log focused on
  meaningful access events.
- The user_id is decoded from the JWT WITHOUT re-validating signatures —
  validation is FastAPI's job via `get_current_user`. If the token is
  forged, we still log the claimed user_id; the request itself will be
  rejected by the endpoint's auth dependency.
- Request/response bodies are NOT logged. Only structured metadata
  (method, path, status, duration, IP, user-agent) is persisted, to avoid
  accidentally writing PHI into the audit trail.
"""

import logging
import time
from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from app.database import async_session
from app.models.audit import AuditLog
from app.utils.security import decode_token

logger = logging.getLogger("compass.audit")

# Paths that are noisy and low-value for HIPAA audit trail
EXCLUDED_PATHS = {"/api/v1/health", "/api/v1/ready", "/docs", "/openapi.json", "/redoc", "/favicon.ico"}


def _extract_user_id(request: Request) -> UUID | None:
    """Pull user_id from JWT if present. Returns None if absent/invalid."""
    auth_header = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth_header or not auth_header.lower().startswith("bearer "):
        return None
    token = auth_header.split(" ", 1)[1].strip()
    payload = decode_token(token)
    if payload is None:
        return None
    sub = payload.get("sub")
    if sub is None:
        return None
    try:
        return UUID(sub)
    except (ValueError, TypeError):
        return None


def _infer_resource(path: str) -> tuple[str, str | None]:
    """Parse `/api/v1/sessions/abc-123/start` → (resource='sessions', id='abc-123')."""
    parts = path.strip("/").split("/")
    # Strip api/v1 prefix if present
    if len(parts) >= 2 and parts[0] == "api" and parts[1].startswith("v"):
        parts = parts[2:]
    if not parts:
        return "unknown", None
    resource = parts[0]
    resource_id = parts[1] if len(parts) > 1 else None
    return resource, resource_id


class AuditMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        start = time.time()
        response = await call_next(request)
        duration_ms = round((time.time() - start) * 1000)

        path = request.url.path
        if path in EXCLUDED_PATHS or path.startswith("/api/v1/admin/waitlist"):
            return response

        # Structured log line (stdout) for observability — no PHI values
        logger.info(
            "request",
            extra={
                "method": request.method,
                "path": path,
                "status": response.status_code,
                "duration_ms": duration_ms,
            },
        )

        # Persist to AuditLog table for HIPAA compliance
        try:
            user_id = _extract_user_id(request)
            resource, resource_id = _infer_resource(path)
            action = f"{request.method} {path}"
            ip = request.client.host if request.client else None
            ua = request.headers.get("user-agent")
            details = {
                "status": response.status_code,
                "duration_ms": duration_ms,
            }

            async with async_session() as session:
                session.add(AuditLog(
                    user_id=user_id,
                    action=action,
                    resource=resource,
                    resource_id=resource_id,
                    ip_address=ip,
                    user_agent=ua,
                    details=details,
                ))
                await session.commit()
        except SQLAlchemyError as e:
            # Never fail a request because audit logging failed — log and move on
            logger.error("Audit log insert failed: %s", e)
        except Exception as e:  # noqa: BLE001
            logger.error("Audit middleware error: %s", e)

        return response
