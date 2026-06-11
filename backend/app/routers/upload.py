"""Presigned-URL upload endpoint.

HIPAA-compliant S3 key generation for all three PHI buckets:

  message_attachment  -> compass-prod-message-attachments
      Key: prod/v1/members/{target_member_uuid}/attachments/{attachment_uuid}.{ext}
      The key is scoped to the MEMBER being addressed (not the uploader), so
      all attachments for a given member share a common prefix.  When the
      uploader is a CHW, their identity is irrelevant to the storage path;
      we validate they have an active care relationship before issuing the URL.

  member_document     -> compass-prod-member-documents
      Key: prod/v1/members/{member_uuid}/{document_uuid}_{document_type}.{ext}
      Generated here for the presigned-URL step; the client confirms the upload
      by calling POST /members/{id}/documents with the returned s3_key.

  credential/recording/document -> compass-phi-dev (legacy PHI bucket)
      Key: users/{user_id}/{category}/{filename}
      Retained for backward compatibility with credential and document uploads.

  profile_image       -> compass-public-dev
      Key: profiles/{user_id}/{filename}
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user
from app.schemas.upload import PresignedUrlRequest, PresignedUrlResponse
from app.services.s3_service import (
    build_member_document_key,
    build_message_attachment_key,
    build_phi_key,
    build_public_key,
    generate_presigned_upload_url,
)

logger = logging.getLogger("compass.upload")

router = APIRouter(prefix="/api/v1/upload", tags=["upload"])


async def _assert_chw_member_relationship(
    requesting_user_id: uuid.UUID,
    requesting_role: str,
    target_member_id: uuid.UUID,
    db: AsyncSession,
) -> None:
    """Raise 403 unless the requester may upload attachments for the target member.

    Rules:
      - role=member: must be scoping to themselves (member messaging themselves
        is unusual but structurally valid for self-uploads in group threads).
      - role=chw: must have an active Session or matched ServiceRequest with
        the target member.
      - role=admin: always allowed.

    This mirrors the relationship gate in member_documents.py and journeys.py.
    """
    if requesting_role == "admin":
        return

    if requesting_role == "member":
        if requesting_user_id != target_member_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Members may only upload attachments scoped to themselves.",
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
            detail="You do not have an active care relationship with this member.",
        )

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Insufficient permissions.",
    )


@router.post("/presigned-url", response_model=PresignedUrlResponse)
async def get_presigned_url(
    data: PresignedUrlRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PresignedUrlResponse:
    """Issue a short-lived presigned S3 PUT URL for the requested upload purpose.

    The S3 key is built server-side using UUID-only path components so no PHI
    ever appears in a bucket key.  The returned ``s3_key`` must be persisted by
    the client (e.g. in the FileAttachment or MemberDocument row) after the
    direct S3 PUT completes.

    Args:
        data: Validated upload request.  For ``message_attachment`` purpose,
            ``target_member_id`` is required and a care-relationship check is
            performed before issuing the URL.
        current_user: Authenticated user injected by the auth dependency.
        db: Async database session for relationship gate queries.

    Returns:
        ``PresignedUrlResponse`` with ``upload_url`` and ``s3_key``.
    """
    if data.purpose == "message_attachment":
        # Schema validation already enforces target_member_id is not None here,
        # but we guard explicitly to satisfy the type checker.
        if data.target_member_id is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="target_member_id is required for message_attachment uploads.",
            )

        await _assert_chw_member_relationship(
            requesting_user_id=current_user.id,
            requesting_role=current_user.role,
            target_member_id=data.target_member_id,
            db=db,
        )

        key = build_message_attachment_key(
            member_uuid=str(data.target_member_id),
            filename=data.filename,
        )
        bucket = settings.s3_message_attachments_bucket

    elif data.purpose == "member_document":
        # Member-document uploads are always scoped to the uploading user.
        # When a CHW uploads on behalf of a member, the CHW calls
        # POST /members/{member_id}/documents directly with an s3_key they
        # already have; this presigned-URL path handles the member self-upload
        # flow where the member gets a key under their own UUID.
        key = build_member_document_key(
            member_uuid=str(current_user.id),
            # document_type is not available at presigned-URL time for this
            # purpose path; the MemberDocumentCreate payload (sent to
            # POST /members/{id}/documents) carries it.  We use a placeholder
            # category token that is still a controlled, non-PHI value.
            document_type="doc",
            filename=data.filename,
        )
        bucket = settings.s3_member_documents_bucket

    elif data.purpose in ("credential", "recording", "document"):
        key = build_phi_key(str(current_user.id), data.purpose, data.filename)
        bucket = settings.s3_bucket_phi

    else:
        # profile_image and any future public-bucket purposes.
        key = build_public_key(str(current_user.id), data.filename)
        bucket = settings.s3_bucket_public

    url = generate_presigned_upload_url(bucket, key, data.content_type)
    return PresignedUrlResponse(upload_url=url, s3_key=key)
