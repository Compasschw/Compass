"""Tests for upload endpoint MIME allowlist + size cap.

Apr 9 audit C2: Upload endpoint accepted any content_type and had no size limit.
This test enforces the Apr 18 fix.
"""

import os

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


def _aws_creds_available() -> bool:
    """True iff boto3 can resolve AWS credentials (env, profile, or instance role).

    The happy-path upload test calls boto3, which raises NoCredentialsError
    on CI runners without AWS credentials configured. The validation tests
    below don't reach boto3 (they fail before the S3 call).
    """
    if os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"):
        return True
    try:
        import boto3
        return boto3.Session().get_credentials() is not None
    except Exception:
        return False


class TestUploadValidation:
    @pytest.mark.skipif(
        not _aws_creds_available(),
        reason="Requires AWS credentials to call generate_presigned_url",
    )
    async def test_valid_image_upload_accepted(
        self, client: AsyncClient, chw_tokens: dict
    ):
        res = await client.post(
            "/api/v1/upload/presigned-url",
            json={
                "filename": "license.jpg",
                "content_type": "image/jpeg",
                "purpose": "credential",
                "size_bytes": 500_000,
            },
            headers=auth_header(chw_tokens),
        )
        # May 200 or may fail on S3 connectivity — but MUST NOT 422 for valid input
        assert res.status_code != 422, f"Valid input was rejected: {res.text}"

    async def test_rejects_executable_mime(
        self, client: AsyncClient, chw_tokens: dict
    ):
        res = await client.post(
            "/api/v1/upload/presigned-url",
            json={
                "filename": "bad.exe",
                "content_type": "application/x-executable",
                "purpose": "credential",
                "size_bytes": 1000,
            },
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 422

    async def test_rejects_oversized_upload(
        self, client: AsyncClient, chw_tokens: dict
    ):
        res = await client.post(
            "/api/v1/upload/presigned-url",
            json={
                "filename": "huge.pdf",
                "content_type": "application/pdf",
                "purpose": "document",
                "size_bytes": 100 * 1024 * 1024,  # 100 MB — over 20 MB cap
            },
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 422

    async def test_rejects_path_traversal_filename(
        self, client: AsyncClient, chw_tokens: dict
    ):
        res = await client.post(
            "/api/v1/upload/presigned-url",
            json={
                "filename": "../../etc/passwd",
                "content_type": "application/pdf",
                "purpose": "document",
                "size_bytes": 1000,
            },
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 422

    async def test_rejects_null_byte_in_filename(
        self, client: AsyncClient, chw_tokens: dict
    ):
        res = await client.post(
            "/api/v1/upload/presigned-url",
            json={
                "filename": "file\x00.pdf",
                "content_type": "application/pdf",
                "purpose": "document",
                "size_bytes": 1000,
            },
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 422

    async def test_rejects_invalid_purpose(
        self, client: AsyncClient, chw_tokens: dict
    ):
        res = await client.post(
            "/api/v1/upload/presigned-url",
            json={
                "filename": "file.pdf",
                "content_type": "application/pdf",
                "purpose": "arbitrary-string-that-routes-to-public-bucket",
                "size_bytes": 1000,
            },
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 422

    async def test_requires_auth(self, client: AsyncClient):
        res = await client.post(
            "/api/v1/upload/presigned-url",
            json={
                "filename": "file.pdf",
                "content_type": "application/pdf",
                "purpose": "credential",
                "size_bytes": 1000,
            },
        )
        assert res.status_code == 401
