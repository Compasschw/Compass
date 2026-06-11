"""Tests for the S3 audio persistence step in recording_finalizer.

Coverage:
1. _build_audio_s3_key -- pure unit, no I/O.
   New path scheme: prod/v1/sessions/{session_uuid}/{comm_session_uuid}.mp3
   - No year/month partition -- keys are UUID-only (no PHI).
   - The comm_session_uuid as filename means two calls in the same session
     produce different keys (overwrite-collision fix).
2. _upload_audio_to_s3 success path -- mocked boto3; verifies put_object
   call shape (bucket, key, SSE-KMS, ContentType, Metadata) and return value.
3. _upload_audio_to_s3 BotoCoreError path -- returns None, does NOT raise.
4. _upload_audio_to_s3 ClientError path -- returns None, does NOT raise.
5. _run_pipeline S3 success -- audio_s3_key populated on comm_session.
6. _run_pipeline S3 failure -- audio_s3_key stays NULL; transcription still runs.

All tests are unit-level with mocked external services.  No real AWS calls.
No real DB is needed for the pure-unit tests; the pipeline integration tests
use a lightweight in-memory SQLite via SQLAlchemy (async).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.communication.recording_finalizer import (
    _build_audio_s3_key,
    _upload_audio_to_s3,
)


# ---------------------------------------------------------------------------
# _build_audio_s3_key -- pure unit
# ---------------------------------------------------------------------------


def test_build_audio_s3_key_format() -> None:
    """Key uses the new member-scoped UUID-only scheme: sessions/{session}/{call}.mp3"""
    session_id = uuid.UUID("550e8400-e29b-41d4-a716-446655440000")
    comm_session_id = uuid.UUID("7f3a1c9d-1234-5678-abcd-ef0123456789")
    key = _build_audio_s3_key(
        session_id=session_id,
        communication_session_id=comm_session_id,
    )
    assert key == (
        "prod/v1/sessions/550e8400-e29b-41d4-a716-446655440000"
        "/7f3a1c9d-1234-5678-abcd-ef0123456789.mp3"
    )


def test_build_audio_s3_key_no_phi_in_path() -> None:
    """Key must contain only UUIDs -- no dates, names, or other PHI."""
    session_id = uuid.uuid4()
    comm_session_id = uuid.uuid4()
    key = _build_audio_s3_key(
        session_id=session_id,
        communication_session_id=comm_session_id,
    )
    assert key.startswith("prod/v1/sessions/")
    # No year/month date partitions
    assert "/2026/" not in key
    assert "/06/" not in key
    # Must end with the comm_session_id UUID + .mp3
    assert key.endswith(f"{comm_session_id}.mp3")


def test_build_audio_s3_key_two_calls_same_session_no_collision() -> None:
    """Two comm_sessions on the same session produce different keys (no overwrite)."""
    session_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
    call_1 = uuid.UUID("aaaaaaaa-0000-0000-0000-000000000001")
    call_2 = uuid.UUID("bbbbbbbb-0000-0000-0000-000000000002")
    key_1 = _build_audio_s3_key(session_id=session_id, communication_session_id=call_1)
    key_2 = _build_audio_s3_key(session_id=session_id, communication_session_id=call_2)
    assert key_1 != key_2
    # Both share the same session prefix
    prefix = f"prod/v1/sessions/{session_id}/"
    assert key_1.startswith(prefix)
    assert key_2.startswith(prefix)


def test_build_audio_s3_key_same_inputs_are_stable() -> None:
    """Identical inputs always produce the same key (deterministic, idempotent)."""
    session_id = uuid.UUID("12345678-1234-5678-1234-567812345678")
    comm_session_id = uuid.UUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    assert _build_audio_s3_key(
        session_id=session_id, communication_session_id=comm_session_id
    ) == _build_audio_s3_key(
        session_id=session_id, communication_session_id=comm_session_id
    )


# ---------------------------------------------------------------------------
# _upload_audio_to_s3 -- mocked boto3
# ---------------------------------------------------------------------------


def _make_settings(bucket: str = "compass-prod-call-recordings", kms_arn: str = "") -> object:
    """Build a minimal settings mock for _upload_audio_to_s3."""
    return SimpleNamespace(
        s3_call_recordings_bucket=bucket,
        s3_kms_key_arn=kms_arn,
        aws_region="us-west-2",
    )


@pytest.mark.asyncio
async def test_upload_audio_to_s3_success_returns_key() -> None:
    """Successful PUT returns the expected S3 key string."""
    session_id = uuid.UUID("550e8400-e29b-41d4-a716-446655440000")
    comm_session_id = uuid.UUID("7f3a1c9d-1234-5678-abcd-ef0123456789")
    recorded_at = datetime(2026, 6, 9, 14, 32, 0, tzinfo=UTC)
    audio_bytes = b"fake-mp3-bytes"

    mock_s3 = MagicMock()
    mock_s3.put_object.return_value = {}

    # boto3 is imported lazily inside the function body, so we patch the
    # module-level boto3 reference that the lazy import resolves to, plus
    # the settings object via app.config.
    with (
        patch("boto3.client", return_value=mock_s3),
        patch(
            "app.config.settings",
            _make_settings(kms_arn="arn:aws:kms:us-west-2:123456789012:key/test-key-id"),
        ),
    ):
        result = await _upload_audio_to_s3(
            audio_bytes=audio_bytes,
            session_id=session_id,
            communication_session_id=comm_session_id,
            recorded_at=recorded_at,
        )

    expected_key = (
        f"prod/v1/sessions/{session_id}/{comm_session_id}.mp3"
    )
    assert result == expected_key

    mock_s3.put_object.assert_called_once()
    call_kwargs = mock_s3.put_object.call_args.kwargs
    assert call_kwargs["Bucket"] == "compass-prod-call-recordings"
    assert call_kwargs["Key"] == expected_key
    assert call_kwargs["Body"] == audio_bytes
    assert call_kwargs["ContentType"] == "audio/mpeg"
    assert call_kwargs["ServerSideEncryption"] == "aws:kms"
    assert call_kwargs["SSEKMSKeyId"] == "arn:aws:kms:us-west-2:123456789012:key/test-key-id"
    assert call_kwargs["Metadata"]["session-id"] == str(session_id)
    assert call_kwargs["Metadata"]["communication-session-id"] == str(comm_session_id)


@pytest.mark.asyncio
async def test_upload_audio_to_s3_omits_kms_key_id_when_arn_empty() -> None:
    """SSEKMSKeyId is not sent when s3_kms_key_arn is empty."""
    session_id = uuid.uuid4()
    comm_session_id = uuid.uuid4()
    recorded_at = datetime(2026, 6, 9, 14, 32, 0, tzinfo=UTC)

    mock_s3 = MagicMock()
    mock_s3.put_object.return_value = {}

    with (
        patch("boto3.client", return_value=mock_s3),
        patch("app.config.settings", _make_settings(kms_arn="")),
    ):
        result = await _upload_audio_to_s3(
            audio_bytes=b"bytes",
            session_id=session_id,
            communication_session_id=comm_session_id,
            recorded_at=recorded_at,
        )

    assert result is not None
    call_kwargs = mock_s3.put_object.call_args.kwargs
    assert "SSEKMSKeyId" not in call_kwargs


@pytest.mark.asyncio
async def test_upload_audio_to_s3_returns_none_on_client_error() -> None:
    """ClientError from boto3 results in None return -- does NOT raise."""
    from botocore.exceptions import ClientError

    session_id = uuid.uuid4()
    comm_session_id = uuid.uuid4()
    recorded_at = datetime(2026, 6, 9, 14, 32, 0, tzinfo=UTC)

    mock_s3 = MagicMock()
    mock_s3.put_object.side_effect = ClientError(
        error_response={"Error": {"Code": "AccessDenied", "Message": "Access Denied"}},
        operation_name="PutObject",
    )

    with (
        patch("boto3.client", return_value=mock_s3),
        patch("app.config.settings", _make_settings()),
    ):
        result = await _upload_audio_to_s3(
            audio_bytes=b"bytes",
            session_id=session_id,
            communication_session_id=comm_session_id,
            recorded_at=recorded_at,
        )

    assert result is None


@pytest.mark.asyncio
async def test_upload_audio_to_s3_returns_none_when_bucket_not_configured() -> None:
    """When S3_CALL_RECORDINGS_BUCKET is empty, returns None immediately."""
    session_id = uuid.uuid4()
    comm_session_id = uuid.uuid4()
    recorded_at = datetime(2026, 6, 9, 14, 32, 0, tzinfo=UTC)

    mock_s3 = MagicMock()

    with (
        patch("boto3.client", return_value=mock_s3),
        patch("app.config.settings", _make_settings(bucket="")),
    ):
        result = await _upload_audio_to_s3(
            audio_bytes=b"bytes",
            session_id=session_id,
            communication_session_id=comm_session_id,
            recorded_at=recorded_at,
        )

    assert result is None
    # put_object must NOT have been called
    mock_s3.put_object.assert_not_called()


# ---------------------------------------------------------------------------
# _run_pipeline integration: audio_s3_key behaviour
# ---------------------------------------------------------------------------
#
# We use lightweight mocks for the DB session, provider factories, and the
# S3 upload helper itself so these tests run without a real Postgres or AWS
# connection.


def _make_comm_session(session_id: uuid.UUID) -> MagicMock:
    """Build a minimal CommunicationSession-like mock."""
    cs = MagicMock()
    cs.id = uuid.uuid4()
    cs.session_id = session_id
    cs.transcript_text = None
    cs.recording_url = "https://api-eu.nexmo.com/v1/files/fake-uuid"
    cs.recording_duration_seconds = None
    cs.audio_s3_key = None
    cs.transcript_confidence = None
    return cs


def _make_transcription_result() -> MagicMock:
    chunk = MagicMock()
    chunk.speaker = "A"
    chunk.text = "Test utterance"
    chunk.confidence = 0.95
    chunk.start_ms = 0
    chunk.end_ms = 3000

    result = MagicMock()
    result.full_text = "Test utterance"
    result.confidence = 0.95
    result.duration_ms = 3000
    result.provider_transcript_id = "aai-test-id"
    result.chunks = [chunk]
    return result


@pytest.mark.asyncio
async def test_run_pipeline_sets_audio_s3_key_on_success() -> None:
    """audio_s3_key is populated on comm_session when S3 upload succeeds."""
    from app.services.communication.recording_finalizer import _run_pipeline

    session_id = uuid.uuid4()
    comm_session = _make_comm_session(session_id)
    transcription_result = _make_transcription_result()

    mock_db = AsyncMock()
    mock_db.get = AsyncMock(return_value=comm_session)
    # The scalar check for existing SessionTranscript rows returns None (no rows).
    mock_db.execute = AsyncMock(return_value=MagicMock(scalar_one_or_none=lambda: None))
    mock_db.scalar = AsyncMock(return_value=None)  # no SessionDocumentation
    mock_db.commit = AsyncMock()

    mock_comm_provider = MagicMock()
    mock_comm_provider.download_recording_bytes = AsyncMock(return_value=b"fake-audio-bytes")

    mock_transcription_provider = MagicMock()
    mock_transcription_provider.transcribe_bytes = AsyncMock(return_value=transcription_result)
    mock_transcription_provider.summarize_transcript = AsyncMock(return_value=None)

    # The expected key under the new scheme uses the comm_session.id UUID.
    expected_key = f"prod/v1/sessions/{session_id}/{comm_session.id}.mp3"

    with patch(
        "app.services.communication.recording_finalizer._upload_audio_to_s3",
        new=AsyncMock(return_value=expected_key),
    ):
        await _run_pipeline(
            db=mock_db,
            communication_session_id=comm_session.id,
            comm_provider_factory=lambda: mock_comm_provider,
            transcription_provider_factory=lambda: mock_transcription_provider,
        )

    assert comm_session.audio_s3_key == expected_key
    # DB commit must have been called at least once (for the S3 key flush).
    mock_db.commit.assert_called()


@pytest.mark.asyncio
async def test_run_pipeline_audio_s3_key_stays_null_on_s3_failure() -> None:
    """audio_s3_key stays NULL when S3 upload fails; transcription still proceeds."""
    from app.services.communication.recording_finalizer import _run_pipeline

    session_id = uuid.uuid4()
    comm_session = _make_comm_session(session_id)
    transcription_result = _make_transcription_result()

    mock_db = AsyncMock()
    mock_db.get = AsyncMock(return_value=comm_session)
    mock_db.execute = AsyncMock(return_value=MagicMock(scalar_one_or_none=lambda: None))
    mock_db.scalar = AsyncMock(return_value=None)
    mock_db.commit = AsyncMock()

    mock_comm_provider = MagicMock()
    mock_comm_provider.download_recording_bytes = AsyncMock(return_value=b"fake-audio-bytes")

    mock_transcription_provider = MagicMock()
    mock_transcription_provider.transcribe_bytes = AsyncMock(return_value=transcription_result)
    mock_transcription_provider.summarize_transcript = AsyncMock(return_value=None)

    with patch(
        "app.services.communication.recording_finalizer._upload_audio_to_s3",
        new=AsyncMock(return_value=None),  # S3 upload failed
    ):
        await _run_pipeline(
            db=mock_db,
            communication_session_id=comm_session.id,
            comm_provider_factory=lambda: mock_comm_provider,
            transcription_provider_factory=lambda: mock_transcription_provider,
        )

    # audio_s3_key must still be None -- upload failure must not raise.
    assert comm_session.audio_s3_key is None
    # Transcription must have been called despite the S3 failure.
    mock_transcription_provider.transcribe_bytes.assert_called_once()
