"""Member Documents router.

Endpoints:
  POST   /api/v1/members/{member_id}/documents
  GET    /api/v1/members/{member_id}/documents
  DELETE /api/v1/documents/{doc_id}
  GET    /api/v1/documents/{doc_id}/download-url

Authorization:
  - Members can only access their own documents.
  - CHWs can access documents for members they have an active care relationship
    with (mirrors the relationship gate in journeys.py).
  - On delete: uploader OR the member who owns the document.

PHI:
  - AuditLog row written on every CRUD operation.
  - s3_url is never logged or returned to clients; presigned download URL is
    issued on-demand with a 15-minute expiry.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session, get_db
from app.dependencies import get_current_user
from app.models.member_document import MemberDocument
from app.schemas.member_document import (
    MemberDocumentCreate,
    MemberDocumentResponse,
    PresignedDownloadUrlResponse,
)
from app.schemas.pagination import PaginatedResponse, pagination, PaginationParams
from app.services.s3_service import generate_presigned_download_url

logger = logging.getLogger("compass.member_documents")

# ─── Routers ──────────────────────────────────────────────────────────────────

# member-scoped routes (path: /api/v1/members/{member_id}/documents)
members_router = APIRouter(prefix="/api/v1/members", tags=["member_documents"])

# document-scoped routes (path: /api/v1/documents/{doc_id}/...)
documents_router = APIRouter(prefix="/api/v1/documents", tags=["member_documents"])

# ─── Relationship gate (copied from journeys.py for locality) ─────────────────


async def _assert_member_access(
    requesting_user_id: uuid.UUID,
    requesting_role: str,
    target_member_id: uuid.UUID,
    db: AsyncSession,
) -> None:
    """Raise 403 unless the requester may access the target member's documents.

    Rules:
      - role=member: must be accessing their own documents.
      - role=chw: must have at least one Session or matched ServiceRequest
        with the target member (same gate as journeys / case notes).
      - role=admin: always allowed (falls through silently).
    """
    if requesting_role == "admin":
        return

    if requesting_role == "member":
        if requesting_user_id != target_member_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Members may only access their own documents.",
            )
        return

    if requesting_role == "chw":
        from app.models.request import ServiceRequest
        from app.models.session import Session

        session_count = await db.scalar(
            select(func.count())
            .select_from(Session)
            .where(Session.chw_id == requesting_user_id)
            .where(Session.member_id == target_member_id)
        )
        if (session_count or 0) > 0:
            return

        request_count = await db.scalar(
            select(func.count())
            .select_from(ServiceRequest)
            .where(ServiceRequest.matched_chw_id == requesting_user_id)
            .where(ServiceRequest.member_id == target_member_id)
        )
        if (request_count or 0) > 0:
            return

        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have an active relationship with this member.",
        )

    # Unknown role — deny by default.
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Insufficient permissions.",
    )


# ─── Audit helper ─────────────────────────────────────────────────────────────


async def _write_audit_log(
    actor_id: uuid.UUID | None,
    action: str,
    resource_id: str,
    details: dict,
) -> None:
    """Write an AuditLog row in an independent session.

    Uses an independent session (same pattern as AuditMiddleware and the
    CHW phi_read audit in chw.py) so the commit is guaranteed regardless
    of the endpoint session state.  Never raises — exceptions are logged
    and swallowed to prevent audit failure from breaking the main request.
    """
    from app.models.audit import AuditLog

    try:
        async with async_session() as audit_db:
            audit_db.add(AuditLog(
                user_id=actor_id,
                action=action,
                resource="member_document",
                resource_id=resource_id,
                details=details,
            ))
            await audit_db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "audit_log insert failed for member_document %s action=%s: %s",
            resource_id,
            action,
            exc,
        )


# ─── POST /members/{member_id}/documents ──────────────────────────────────────


@members_router.post(
    "/{member_id}/documents",
    response_model=MemberDocumentResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Record a member document after a successful presigned-URL upload",
)
async def create_member_document(
    member_id: uuid.UUID,
    data: MemberDocumentCreate,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MemberDocumentResponse:
    """Create a MemberDocument row after the client has uploaded the file to S3.

    The client must:
      1. Call POST /upload/presigned-url with purpose=member_document.
      2. PUT the file to the returned upload_url.
      3. Call this endpoint with the resulting s3_url / s3_key.

    The endpoint validates the relationship gate, persists the metadata row,
    and writes a PHI-create audit log.
    """
    role: str = current_user.role

    await _assert_member_access(current_user.id, role, member_id, db)

    # Guard: target member must exist (return 404 not 403 to surface mis-typed UUIDs).
    from app.models.user import User
    member_user = await db.scalar(
        select(User).where(User.id == member_id).where(User.role == "member")
    )
    if member_user is None:
        raise HTTPException(status_code=404, detail="Member not found.")

    doc = MemberDocument(
        member_id=member_id,
        document_type=data.document_type,
        filename=data.filename,
        s3_url=data.s3_url,
        s3_key=data.s3_key,
        content_type=data.content_type,
        size_bytes=data.size_bytes,
        uploaded_by=current_user.id,
    )
    db.add(doc)
    await db.commit()
    await db.refresh(doc)

    await _write_audit_log(
        actor_id=current_user.id,
        action="phi_create",
        resource_id=str(doc.id),
        details={
            "actor_role": role,
            "member_id": str(member_id),
            "document_type": data.document_type,
            "content_type": data.content_type,
            "size_bytes": data.size_bytes,
        },
    )

    return MemberDocumentResponse.model_validate(doc)


# ─── GET /members/{member_id}/documents ───────────────────────────────────────


@members_router.get(
    "/{member_id}/documents",
    response_model=PaginatedResponse[MemberDocumentResponse],
    summary="List active documents for a member, most-recent first",
)
async def list_member_documents(
    member_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    params: PaginationParams = Depends(pagination),
) -> PaginatedResponse[MemberDocumentResponse]:
    """Return paginated, soft-delete-filtered documents for a member.

    Access is relationship-gated; see _assert_member_access.
    """
    role: str = current_user.role

    await _assert_member_access(current_user.id, role, member_id, db)

    base_filter = (
        MemberDocument.member_id == member_id,
        MemberDocument.deleted_at.is_(None),
    )

    total = await db.scalar(
        select(func.count())
        .select_from(MemberDocument)
        .where(*base_filter)
    ) or 0

    result = await db.execute(
        select(MemberDocument)
        .where(*base_filter)
        .order_by(MemberDocument.uploaded_at.desc())
        .offset(params.offset)
        .limit(params.page_size)
    )
    docs = result.scalars().all()

    await _write_audit_log(
        actor_id=current_user.id,
        action="phi_read",
        resource_id=str(member_id),
        details={
            "actor_role": role,
            "list_count": len(docs),
            "page": params.page,
        },
    )

    return PaginatedResponse(
        items=[MemberDocumentResponse.model_validate(d) for d in docs],
        total=total,
        page=params.page,
        page_size=params.page_size,
    )


# ─── DELETE /documents/{doc_id} ───────────────────────────────────────────────


@documents_router.delete(
    "/{doc_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Soft-delete a member document",
)
async def delete_member_document(
    doc_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Soft-delete a document.

    Allowed callers:
      - The original uploader (uploaded_by == current_user.id).
      - The member who owns the document (member_id == current_user.id AND role=member).
      - Admin.

    Returns 404 when the document is not found (including already-deleted).
    Returns 403 when the caller does not have delete rights.
    """
    result = await db.execute(
        select(MemberDocument)
        .where(MemberDocument.id == doc_id)
        .where(MemberDocument.deleted_at.is_(None))
    )
    doc = result.scalar_one_or_none()

    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    role: str = current_user.role

    if role != "admin":
        is_uploader = doc.uploaded_by == current_user.id
        is_owner = (role == "member") and (doc.member_id == current_user.id)
        if not (is_uploader or is_owner):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You do not have permission to delete this document.",
            )

    doc.deleted_at = datetime.now(tz=UTC)
    await db.commit()

    await _write_audit_log(
        actor_id=current_user.id,
        action="phi_delete",
        resource_id=str(doc_id),
        details={
            "actor_role": role,
            "member_id": str(doc.member_id),
            "document_type": doc.document_type,
        },
    )


# ─── GET /documents/{doc_id}/download-url ─────────────────────────────────────

DOWNLOAD_URL_EXPIRY_SECONDS = 900  # 15 minutes


@documents_router.get(
    "/{doc_id}/download-url",
    response_model=PresignedDownloadUrlResponse,
    summary="Get a short-lived presigned GET URL for a member document",
)
async def get_document_download_url(
    doc_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PresignedDownloadUrlResponse:
    """Return a 15-minute presigned S3 GET URL for the given document.

    The relationship gate is applied: the caller must be the member themselves,
    an admin, or a CHW with an active care relationship.

    KNOWN FOLLOW-UP: the s3_url stored at upload time points to a private S3
    bucket; access MUST be obtained via this endpoint.  Direct S3 URL access
    is blocked at the bucket policy level (DenyNonTLS + no public access).
    """
    result = await db.execute(
        select(MemberDocument)
        .where(MemberDocument.id == doc_id)
        .where(MemberDocument.deleted_at.is_(None))
    )
    doc = result.scalar_one_or_none()

    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    await _assert_member_access(
        current_user.id, current_user.role, doc.member_id, db
    )

    presigned_url = generate_presigned_download_url(
        bucket=settings.s3_member_documents_bucket,
        key=doc.s3_key,
        expires_in=DOWNLOAD_URL_EXPIRY_SECONDS,
    )

    await _write_audit_log(
        actor_id=current_user.id,
        action="phi_read",
        resource_id=str(doc_id),
        details={
            "actor_role": current_user.role,
            "member_id": str(doc.member_id),
            "action_detail": "presigned_download_url_issued",
        },
    )

    return PresignedDownloadUrlResponse(
        download_url=presigned_url,
        expires_in_seconds=DOWNLOAD_URL_EXPIRY_SECONDS,
    )
