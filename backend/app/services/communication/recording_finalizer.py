"""Post-call recording finalization pipeline.

Triggered from the Vonage ``/voice/events`` webhook when a ``record`` event
delivers a ``recording_url``.  Runs as a background task so the webhook returns
promptly while the (potentially long) AssemblyAI transcription job runs.

Pipeline steps:

    1. Re-fetch the CommunicationSession row (the webhook already saved the
       URL; we re-load here in our own DB session for isolation).
    2. Download the recording bytes from Vonage using the application JWT.
    2a. [NEW] PUT audio bytes to S3 (compass-prod-call-recordings) for durable
        storage.  Failure is non-fatal: logs at ERROR + Sentry alert, but the
        transcription step still proceeds.  audio_s3_key column set on success.
    3. Submit bytes to AssemblyAI batch transcription with the medical model.
    4. Persist ``transcript_text`` + ``transcript_confidence`` on the
       CommunicationSession and explode the diarised utterances into
       ``session_transcripts`` rows (with ``is_final=True`` so they're picked
       up by the summarizer + follow-up extractor).
    5. Best-effort: trigger AI summary generation on the parent Session.

The pipeline is idempotent — if transcript_text is already populated when
finalize_recording fires, it short-circuits.  Failures at any step are
logged but never re-raised: the webhook is fire-and-forget and a re-delivered
record event will retry from the top.

HIPAA notes:
    - ``audio_bytes`` is PHI: never logged.  Only byte count is logged.
    - Transcript text is PHI: never logged.  Only utterance counts are logged.
    - The recording URL is logged at INFO only as the hostname, not the full
      path (the path contains the recording UUID which is correlatable to
      a session).
    - S3 PUT uses SSE-KMS with the compass-phi KMS key ARN sourced from
      settings.s3_kms_key_arn.  ContentType and session-level Metadata are
      set for traceability without logging PHI.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.communication import CommunicationSession
from app.models.session import SessionTranscript

logger = logging.getLogger("compass.communication.finalizer")


def _build_audio_s3_key(session_id: UUID, recorded_at: datetime) -> str:
    """Construct the S3 object key for a Vonage call recording.

    Path schema: ``prod/v1/{year}/{month}/{session_id}.mp3``

    Uses the session_id (not communication_session_id) so the path is stable
    across retry calls.  The year/month partition is derived from the
    ``recorded_at`` timestamp (UTC) so keys can be scanned by date range.

    Args:
        session_id: The parent Session UUID (from CommunicationSession.session_id).
        recorded_at: UTC datetime of when the recording finalizer runs.

    Returns:
        S3 object key string, e.g. ``prod/v1/2026/06/550e8400-...mp3``.
    """
    return f"prod/v1/{recorded_at.year}/{recorded_at.month:02d}/{session_id}.mp3"


async def _upload_audio_to_s3(
    *,
    audio_bytes: bytes,
    session_id: UUID,
    communication_session_id: UUID,
    recorded_at: datetime,
) -> str | None:
    """PUT audio bytes to S3 with KMS encryption.

    Non-fatal: returns the S3 key on success, None on any failure.  Callers
    must NOT raise on None — transcription proceeds regardless.

    Args:
        audio_bytes: Raw MP3 bytes downloaded from Vonage.
        session_id: Parent Session UUID (used in the S3 key path).
        communication_session_id: CommunicationSession UUID (stored in S3 metadata).
        recorded_at: UTC timestamp used for the year/month path partition.

    Returns:
        S3 key string on success, None on failure.
    """
    try:
        import boto3
        from botocore.exceptions import BotoCoreError, ClientError

        from app.config import settings

        bucket = settings.s3_call_recordings_bucket
        kms_key_arn = settings.s3_kms_key_arn

        if not bucket:
            logger.warning(
                "_upload_audio_to_s3: S3_CALL_RECORDINGS_BUCKET not configured — "
                "skipping upload comm_session_id=%s",
                communication_session_id,
            )
            return None

        s3_key = _build_audio_s3_key(session_id=session_id, recorded_at=recorded_at)

        put_kwargs: dict = {
            "Bucket": bucket,
            "Key": s3_key,
            "Body": audio_bytes,
            "ContentType": "audio/mpeg",
            "ServerSideEncryption": "aws:kms",
            "Metadata": {
                "session-id": str(session_id),
                "communication-session-id": str(communication_session_id),
                "recorded-at": recorded_at.isoformat(),
            },
        }
        if kms_key_arn:
            put_kwargs["SSEKMSKeyId"] = kms_key_arn

        s3_client = boto3.client("s3", region_name=settings.aws_region)
        s3_client.put_object(**put_kwargs)

        logger.info(
            "_upload_audio_to_s3: uploaded comm_session_id=%s bytes=%d s3_key=%s",
            communication_session_id,
            len(audio_bytes),
            s3_key,
        )
        return s3_key

    except (BotoCoreError, ClientError) as exc:  # type: ignore[name-defined]
        logger.error(
            "_upload_audio_to_s3: S3 PUT failed comm_session_id=%s — "
            "audio not durably stored; Vonage 30-day window is the fallback. "
            "error=%s",
            communication_session_id,
            exc,
        )
        _maybe_alert_sentry(exc, comm_session_id=communication_session_id)
        return None
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "_upload_audio_to_s3: unexpected error comm_session_id=%s error=%s",
            communication_session_id,
            exc,
        )
        _maybe_alert_sentry(exc, comm_session_id=communication_session_id)
        return None


def _maybe_alert_sentry(exc: Exception, *, comm_session_id: UUID) -> None:
    """Attempt a Sentry capture_exception without raising on Sentry SDK absence."""
    try:
        import sentry_sdk  # type: ignore[import-not-found]

        sentry_sdk.capture_exception(
            exc,
            extras={"communication_session_id": str(comm_session_id)},
        )
    except Exception:  # noqa: BLE001
        pass  # Sentry not configured — log is sufficient


async def finalize_recording(
    *,
    communication_session_id: UUID,
) -> None:
    """Download the Vonage recording and persist a full batch transcript.

    Called as a FastAPI BackgroundTasks job from the voice/events webhook.
    Opens its own DB session so it survives webhook teardown.

    Args:
        communication_session_id: The ``communication_sessions.id`` UUID of
            the row whose ``recording_url`` was just persisted.
    """
    from app.database import async_session
    from app.services.communication import get_provider as get_communication_provider
    from app.services.transcription import get_transcription_provider

    async with async_session() as db:
        try:
            await _run_pipeline(
                db=db,
                communication_session_id=communication_session_id,
                comm_provider_factory=get_communication_provider,
                transcription_provider_factory=get_transcription_provider,
            )
        except Exception:  # noqa: BLE001
            # Outer catch: never raise out of a background task.  The webhook
            # has already returned; an unhandled exception here would only
            # noise up the logs.  Inner steps already log at the right level.
            logger.exception(
                "finalize_recording crashed comm_session_id=%s",
                communication_session_id,
            )


async def _run_pipeline(
    *,
    db: AsyncSession,
    communication_session_id: UUID,
    comm_provider_factory,
    transcription_provider_factory,
) -> None:
    """Inner pipeline so the outer wrapper can manage the DB session lifecycle."""
    comm_session = await db.get(CommunicationSession, communication_session_id)
    if comm_session is None:
        logger.warning(
            "finalize_recording: CommunicationSession not found id=%s",
            communication_session_id,
        )
        return

    if comm_session.transcript_text:
        logger.info(
            "finalize_recording: transcript already populated comm_session_id=%s — skipping",
            communication_session_id,
        )
        return

    recording_url = comm_session.recording_url
    if not recording_url:
        logger.warning(
            "finalize_recording: no recording_url on comm_session_id=%s",
            communication_session_id,
        )
        return

    # ── Step 1: download recording bytes from Vonage ──────────────────────
    comm_provider = comm_provider_factory()
    download = getattr(comm_provider, "download_recording_bytes", None)
    if download is None:
        logger.warning(
            "finalize_recording: communication provider %s lacks "
            "download_recording_bytes — skipping",
            type(comm_provider).__name__,
        )
        return

    audio_bytes: bytes | None = await download(recording_url)
    if not audio_bytes:
        logger.error(
            "finalize_recording: download returned no bytes comm_session_id=%s",
            communication_session_id,
        )
        return
    logger.info(
        "finalize_recording: downloaded recording comm_session_id=%s bytes=%d",
        communication_session_id, len(audio_bytes),
    )

    # ── Step 1a: persist audio bytes to S3 for durable storage ───────────
    # This step is non-fatal.  If the PUT fails, audio_s3_key stays NULL and
    # the Vonage 30-day window remains the fallback.  Transcription continues
    # regardless so the clinical workflow is never blocked by storage issues.
    recorded_at = datetime.now(UTC)
    s3_key = await _upload_audio_to_s3(
        audio_bytes=audio_bytes,
        session_id=comm_session.session_id,
        communication_session_id=communication_session_id,
        recorded_at=recorded_at,
    )
    if s3_key:
        comm_session.audio_s3_key = s3_key
        # Flush the S3 key to the DB immediately so it is visible to ops even
        # if the transcription step below fails or takes a long time.
        await db.commit()

    # ── Step 2: batch-transcribe via AssemblyAI ───────────────────────────
    transcription_provider = transcription_provider_factory()
    if not hasattr(transcription_provider, "transcribe_bytes"):
        logger.warning(
            "finalize_recording: transcription provider %s lacks "
            "transcribe_bytes — skipping",
            type(transcription_provider).__name__,
        )
        return

    result = await transcription_provider.transcribe_bytes(
        audio_bytes=audio_bytes,
        language="en",
        medical_model=True,
    )

    if not result.full_text and not result.provider_transcript_id:
        logger.error(
            "finalize_recording: AssemblyAI returned empty result "
            "comm_session_id=%s — leaving transcript fields null for retry",
            communication_session_id,
        )
        return

    # ── Step 3: persist transcript text + confidence on CommunicationSession ──
    comm_session.transcript_text = result.full_text or None
    if result.confidence:
        comm_session.transcript_confidence = float(result.confidence)
    if result.duration_ms is not None and not comm_session.recording_duration_seconds:
        comm_session.recording_duration_seconds = max(0, int(result.duration_ms / 1000))

    # ── Step 4: explode utterances into session_transcripts rows ──────────
    # Skip if rows already exist for this session_id (idempotency).
    existing_count_row = await db.execute(
        select(SessionTranscript)
        .where(SessionTranscript.session_id == comm_session.session_id)
        .limit(1)
    )
    if existing_count_row.scalar_one_or_none() is None:
        inserted = 0
        for chunk in result.chunks:
            # speaker_role mapping: AssemblyAI diarises with labels "A"/"B".
            # We can't know which is CHW vs member without voice-print matching,
            # so we record the raw diarisation label and leave speaker_role
            # NULL; the documentation UI can let the CHW reassign manually.
            db.add(
                SessionTranscript(
                    session_id=comm_session.session_id,
                    speaker_label=chunk.speaker or None,
                    speaker_role=None,
                    speaker_user_id=None,
                    text=chunk.text or "",
                    is_final=True,
                    confidence=chunk.confidence,
                    started_at_ms=chunk.start_ms,
                    ended_at_ms=chunk.end_ms,
                )
            )
            inserted += 1
        logger.info(
            "finalize_recording: inserted %d session_transcripts rows "
            "comm_session_id=%s session_id=%s",
            inserted, communication_session_id, comm_session.session_id,
        )

    await db.commit()
    logger.info(
        "finalize_recording: persisted transcript comm_session_id=%s "
        "session_id=%s text_len=%d confidence=%.3f utterances=%d "
        "provider_transcript_id=%s",
        communication_session_id,
        comm_session.session_id,
        len(comm_session.transcript_text or ""),
        comm_session.transcript_confidence or 0.0,
        len(result.chunks),
        result.provider_transcript_id,
    )

    # ── Step 5: best-effort AI summary trigger ────────────────────────────
    # Pre-populate SessionDocumentation.summary so the CHW opens the modal
    # to a draft instead of a blank field.  Pure best-effort: any failure
    # is silent.
    try:
        await _maybe_trigger_ai_summary(
            db=db,
            session_id=comm_session.session_id,
            transcript_text=result.full_text,
            transcription_provider=transcription_provider,
        )
    except Exception:  # noqa: BLE001
        logger.exception(
            "finalize_recording: AI summary trigger failed (non-fatal) "
            "session_id=%s",
            comm_session.session_id,
        )


async def _maybe_trigger_ai_summary(
    *,
    db: AsyncSession,
    session_id: UUID,
    transcript_text: str,
    transcription_provider,
) -> None:
    """Generate + store an AI summary draft on the SessionDocumentation row.

    Looks up the SessionDocumentation for ``session_id``; if it exists and
    the ``ai_summary`` field is empty, fills it.  If no documentation row
    exists yet (CHW hasn't opened the modal), does nothing — the modal-open
    path will run the same trigger.
    """
    if not transcript_text or len(transcript_text.strip()) < 20:
        return

    # Lazy import to avoid a circular import via app.models.session import chain.
    from app.models.session import SessionDocumentation

    doc = await db.scalar(
        select(SessionDocumentation).where(SessionDocumentation.session_id == session_id)
    )
    if doc is None:
        # No documentation row yet — the CHW hasn't opened the modal.  When
        # they do, the existing /ai-summary endpoint will run this same path.
        return
    if getattr(doc, "ai_summary", None):
        return  # already populated

    summary = await transcription_provider.summarize_transcript(
        transcript=transcript_text,
        member_name=None,
    )
    if not summary:
        return

    doc.ai_summary = summary
    await db.commit()
    logger.info(
        "finalize_recording: AI summary draft saved session_id=%s len=%d",
        session_id, len(summary),
    )
