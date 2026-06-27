"""Avatar URL signing helper.

Profile-picture URLs are stored as public-bucket virtual-hosted URLs
(``https://<bucket>.s3.<region>.amazonaws.com/<key>``), but the bucket has
Block Public Access fully enabled — any direct GET returns 403.

This module converts a stored URL into a short-lived presigned GET URL so the
client can render the avatar without making the bucket public.  All other URL
forms (already-presigned, external, data-URIs, None) pass through unchanged.

Design decisions:
- Reuses the existing ``get_s3_client()`` from ``app.services.s3_service`` so
  signing credentials, region, and SigV4 config are identical to upload paths.
- ``generate_presigned_url('get_object', ...)`` is a local cryptographic
  operation — it issues no network request — so calling it per-row in a list
  response does not cause any N+1 latency.
- ExpiresIn=604800 (7 days) keeps the URL valid well beyond any realistic
  session or page lifetime while still expiring stale links.
- Any parse or signing error is swallowed and the original stored value is
  returned so a bad avatar URL never causes a 500 on a profile fetch.
"""

from __future__ import annotations

import logging
from urllib.parse import unquote, urlparse

from app.config import settings
from app.services.s3_service import get_s3_client

logger = logging.getLogger("compass.storage.avatar_urls")

# Presigned URL expiry: 7 days.  Avatars are low-sensitivity; long TTL avoids
# broken images mid-session when a user has the profile page open for hours.
_AVATAR_PRESIGN_TTL: int = 604_800


def presigned_avatar_url(stored: str | None) -> str | None:
    """Return a presigned GET URL for a public-bucket avatar, or the original value.

    Rules:
    1. None / empty string  → return None.
    2. Already presigned    → return unchanged (guard: ``X-Amz-Signature`` in URL).
    3. Public-bucket URL    → extract the S3 key and return a presigned GET URL
                              valid for 7 days.  Matches both host forms:
                              ``https://<bucket>.s3.amazonaws.com/<key>``
                              ``https://<bucket>.s3.<region>.amazonaws.com/<key>``
    4. Any other URL        → return unchanged (external CDN, data URI, legacy
                              PHI-bucket URL, etc.).
    5. Any error            → log a warning and return the original stored value;
                              never raises, never 500s a profile endpoint.

    Args:
        stored: The raw value from ``User.profile_picture_url``.

    Returns:
        A presigned ``https://`` URL, the original stored value, or ``None``.
    """
    if not stored:
        return None

    # Pass-through: already a presigned AWS URL — don't double-sign.
    if "X-Amz-Signature" in stored:
        return stored

    try:
        parsed = urlparse(stored)
        hostname = parsed.hostname or ""

        if not _is_public_bucket_host(hostname):
            # External URL, data URI, PHI-bucket URL, etc. — pass through.
            return stored

        # Extract the S3 object key from the URL path.
        # urlparse leaves the leading "/" in path; strip it to get the bare key.
        raw_path = parsed.path.lstrip("/")
        if not raw_path:
            logger.warning(
                "presigned_avatar_url: public-bucket URL has empty path — "
                "returning stored value unchanged. stored=%r",
                stored,
            )
            return stored

        # URL-decode percent-encoded characters (e.g. spaces, unicode).
        key = unquote(raw_path)

        client = get_s3_client()
        presigned: str = client.generate_presigned_url(
            "get_object",
            Params={"Bucket": settings.s3_bucket_public, "Key": key},
            ExpiresIn=_AVATAR_PRESIGN_TTL,
        )
        return presigned

    except Exception as exc:  # pragma: no cover — defensive safety net
        logger.warning(
            "presigned_avatar_url: failed to sign avatar URL, returning stored "
            "value. stored=%r error=%r",
            stored,
            exc,
        )
        return stored


def _is_public_bucket_host(hostname: str) -> bool:
    """Return True if *hostname* belongs to the configured public bucket.

    Recognises both virtual-hosted-style endpoint forms:
    - ``<bucket>.s3.amazonaws.com``              (global / no-region)
    - ``<bucket>.s3.<region>.amazonaws.com``     (region-specific)

    Args:
        hostname: The hostname extracted from the stored URL.

    Returns:
        True when the hostname unambiguously belongs to the public bucket.
    """
    bucket = settings.s3_bucket_public
    if not bucket:
        return False

    # Both forms share the prefix "<bucket>.s3." and the suffix ".amazonaws.com".
    prefix = f"{bucket}.s3."
    suffix = ".amazonaws.com"

    return (
        hostname.startswith(prefix)
        and hostname.endswith(suffix)
        # The middle segment must be either empty (global form:
        # "<bucket>.s3.amazonaws.com" → after stripping prefix+"amazonaws.com"
        # the remainder is just ".") or a region name.  A simple startswith +
        # endswith is sufficient because no other AWS service hostname matches
        # both constraints simultaneously.
    )
