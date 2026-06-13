"""Audit-log helpers — HIPAA §164.312(b) access logging.

Centralises the ``phi_read`` audit-row pattern that was previously duplicated
inline in chw.py and member_documents.py. New PHI read endpoints should call
``record_phi_read`` rather than hand-rolling the independent-session insert.

(Consolidating the older inline call sites onto this helper is tracked as
Sprint 4 #32 — relationship/audit-gate consolidation.)
"""

from __future__ import annotations

import logging
import uuid

from app.database import async_session
from app.models.audit import AuditLog

logger = logging.getLogger("compass.audit")


async def record_phi_read(
    *,
    actor_user_id: uuid.UUID | None,
    resource: str,
    resource_id: str,
    details: dict | None = None,
) -> None:
    """Write a ``phi_read`` AuditLog row in an independent DB session.

    HIPAA 45 CFR §164.312(b) (Audit Controls) requires recording access to
    PHI. This supplements the request-level AuditMiddleware row with structured
    resource context — which member/session was read, how many records, and the
    actor's role — so an access log can answer "who read this member's data".

    Design guarantees:
    - Independent session: the row commits regardless of whether the caller's
      own transaction commits or rolls back.
    - Never raises: an audit-write hiccup must never block or fail a legitimate
      PHI read. Failures are logged at ERROR (with no PHI) and swallowed.

    Args:
        actor_user_id: The reading user's id, or None for admin-key access.
        resource: Stable resource type, e.g. "case_note", "session_transcript".
        resource_id: The id of the member/session whose PHI was read.
        details: Optional structured, PHI-FREE context (counts, actor_role,
            field names) — never the PHI content itself.
    """
    try:
        async with async_session() as audit_db:
            audit_db.add(
                AuditLog(
                    user_id=actor_user_id,
                    action="phi_read",
                    resource=resource,
                    resource_id=resource_id,
                    details=details or {},
                )
            )
            await audit_db.commit()
    except Exception as exc:  # noqa: BLE001 — audit must never break the read
        logger.error(
            "phi_read audit insert failed resource=%s resource_id=%s: %s",
            resource,
            resource_id,
            exc,
        )
