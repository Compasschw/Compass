"""S3 service helpers for Compass.

Key builders enforce the HIPAA-compliant path schemes agreed in the platform
audit (2026-06).  No PHI (names, DOBs, CINs, phone numbers, emails) may appear
in any S3 key.  Only opaque UUIDs from the database are permitted.

Path schemes (UUID-only):
  call recordings    : prod/v1/sessions/{session_uuid}/{call_uuid}.mp3
  message attachments: prod/v1/members/{member_uuid}/attachments/{attachment_uuid}.{ext}
  member documents   : prod/v1/members/{member_uuid}/{document_uuid}_{document_type}.{ext}
"""

from __future__ import annotations

import uuid as _uuid_module

import boto3

from app.config import settings

_client = None


def get_s3_client():
    """Return a module-level cached boto3 S3 client."""
    global _client
    if _client is None:
        _client = boto3.client("s3", region_name=settings.aws_region)
    return _client


def generate_presigned_upload_url(
    bucket: str, key: str, content_type: str, expires_in: int = 300
) -> str:
    """Generate a presigned PUT URL for a private S3 bucket."""
    client = get_s3_client()
    return client.generate_presigned_url(
        "put_object",
        Params={"Bucket": bucket, "Key": key, "ContentType": content_type},
        ExpiresIn=expires_in,
    )


def generate_presigned_download_url(
    bucket: str, key: str, expires_in: int = 3600
) -> str:
    """Generate a presigned GET URL for a private S3 bucket."""
    client = get_s3_client()
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=expires_in,
    )


def build_message_attachment_key(member_uuid: str, filename: str) -> str:
    """Build a PHI-safe S3 key for a message attachment.

    Path: ``prod/v1/members/{member_uuid}/attachments/{attachment_uuid}.{ext}``

    The ``member_uuid`` is the UUID of the MEMBER whose conversation this
    attachment belongs to (not the sender's UUID when the sender is a CHW).
    The filename extension is preserved so the Content-Type header set by the
    browser at PUT time can be verified by downstream readers; the basename is
    replaced with a fresh UUID so no PHI leaks through original filenames.

    Args:
        member_uuid: Opaque UUID string for the owning member.
        filename: Original filename from the client — used only to extract the
            extension; the basename is discarded and replaced with a UUID.

    Returns:
        S3 object key string with no PHI.
    """
    ext = _safe_extension(filename)
    attachment_uuid = str(_uuid_module.uuid4())
    suffix = f"{attachment_uuid}{ext}"
    return f"prod/v1/members/{member_uuid}/attachments/{suffix}"


def build_member_document_key(
    member_uuid: str, document_type: str, filename: str
) -> str:
    """Build a PHI-safe S3 key for a member-owned document.

    Path: ``prod/v1/members/{member_uuid}/{document_uuid}_{document_type}.{ext}``

    ``document_type`` is a controlled enum value (``id`` / ``income`` /
    ``address`` / ``medical`` / ``other``) and is safe to include in the key
    because it carries no identity information on its own.  It aids audit
    queries (e.g. "list all income-proof docs for member X" is a single prefix
    scan).

    Args:
        member_uuid: Opaque UUID string for the owning member.
        document_type: Controlled enum string — must be one of the allowed
            DocumentType literals (validated upstream in the schema layer).
        filename: Original filename — extension extracted; basename discarded.

    Returns:
        S3 object key string with no PHI.
    """
    ext = _safe_extension(filename)
    document_uuid = str(_uuid_module.uuid4())
    return f"prod/v1/members/{member_uuid}/{document_uuid}_{document_type}{ext}"


def _safe_extension(filename: str) -> str:
    """Extract a dot-prefixed lowercase extension from a filename, or '' if none.

    Strips the basename entirely and returns only the extension (e.g. '.pdf').
    Returns an empty string for filenames without an extension so callers can
    safely concatenate without a trailing dot.

    Never returns more than one extension segment — 'archive.tar.gz' → '.gz'.
    """
    if "." in filename:
        raw_ext = filename.rsplit(".", 1)[-1]
        # Sanitise: only alphanumeric characters allowed in extensions.
        safe = "".join(c for c in raw_ext.lower() if c.isalnum())
        return f".{safe}" if safe else ""
    return ""


def build_phi_key(user_id: str, category: str, filename: str) -> str:
    """Legacy key builder for credential / recording / document purposes.

    New purposes should use the purpose-specific builders above.  This
    function is kept for backward compatibility with the credential and
    profile-image upload paths which route to ``compass-phi-dev``.
    """
    return f"users/{user_id}/{category}/{filename}"


def build_public_key(user_id: str, filename: str) -> str:
    """Key builder for public-bucket objects (profile images, etc.)."""
    return f"profiles/{user_id}/{filename}"
