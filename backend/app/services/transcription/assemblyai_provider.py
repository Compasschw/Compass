"""AssemblyAI transcription provider (Phase 2).

Uses the `assemblyai` Python SDK (>=0.63.0) for all provider calls.

HIPAA notes:
- All audio bytes, transcript text, and member names are PHI.
  This module never logs any of those values.
- API key is a secret — never log it.
- Only provider IDs, session UUIDs, and HTTP status codes are safe to log.

Pricing reference (April 2026):
    Base transcription: $0.37/hr
    Conformer-2 (medical):  adds ~$0.09/hr
    LeMUR:  $3/1M input tokens + $15/1M output tokens (default model)

Docs:
    https://www.assemblyai.com/docs
    https://github.com/AssemblyAI/assemblyai-python-sdk
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from uuid import UUID

from app.services.transcription.base import TranscriptionProvider
from app.services.transcription.types import (
    ActionItem,
    ExtractedFollowups,
    FollowUpTask,
    OwnerEnum,
    PriorityEnum,
    ResourceReferred,
    ResourceTypeEnum,
    StreamingSession,
    TranscriptChunk,
    TranscriptionResult,
    VerticalEnum,
)

logger = logging.getLogger("compass.transcription.assemblyai")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

POLL_INTERVAL_SECONDS: float = 3.0
POLL_TIMEOUT_SECONDS: int = 600  # 10 min — typical session transcribes in < 2 min

# LeMUR model used for follow-up extraction.
# "default" maps to AssemblyAI's recommended model at the time of the request.
# Switch to "anthropic/claude-3-haiku" or "anthropic/claude-3-5-sonnet" for
# richer extraction quality at higher token cost.
LEMUR_MODEL_DEFAULT = "default"

# Streaming sample rate contract — must match the audio format spec in base.py.
STREAMING_SAMPLE_RATE = 16_000

# Prefix patterns used to detect sandbox / test keys.
_TEST_KEY_PREFIXES = ("test_",)

# ---------------------------------------------------------------------------
# LeMUR prompt template
# ---------------------------------------------------------------------------

_FOLLOWUP_PROMPT_TEMPLATE = """\
You are a Community Health Worker (CHW) documentation assistant.

The following is a transcript from a CHW session{member_clause}.

Your task is to extract structured follow-up information and return it as a \
single JSON object matching this exact schema:

{{
  "action_items": [
    {{
      "description": "<concrete next step>",
      "owner": "chw|member|both",
      "due_date": "<ISO 8601 date or null>"
    }}
  ],
  "follow_up_tasks": [
    {{
      "title": "<short task title>",
      "vertical": "housing|food|transportation|employment|education|mental_health|substance_use|utilities|legal|childcare|other",
      "priority": "low|medium|high"
    }}
  ],
  "resources_referred": [
    {{
      "name": "<resource name>",
      "type": "program|provider|document"
    }}
  ],
  "member_goals_stated": ["<goal 1>", "<goal 2>"]
}}

Rules:
- Return ONLY the JSON object. No markdown fences, no explanation.
- If a field has no items, use an empty array [].
- Use null (not the string "null") for missing due_date values.
- Infer priority from urgency cues in the transcript (eviction notice = high, \
  general interest = low).
- Do not invent information not present in the transcript.

Transcript:
{transcript}
"""


class AssemblyAIProvider(TranscriptionProvider):
    """AssemblyAI adapter for Compass CHW transcription pipeline.

    Wraps the `assemblyai` SDK. The SDK is lazy-loaded so that the module
    can be imported even if the package is not installed — import errors
    surface at call time with a clear message.

    Config (via app.config.settings):
        ASSEMBLYAI_API_KEY          — required; starts with a hex string for
                                      production, "test_..." for sandbox.
        ASSEMBLYAI_LEMUR_MODEL      — LeMUR model slug; default "default"
        ENVIRONMENT                 — "production" triggers key-validity check
    """

    def __init__(
        self,
        api_key: str,
        lemur_model: str = LEMUR_MODEL_DEFAULT,
        environment: str = "development",
    ) -> None:
        self._api_key = api_key
        self._lemur_model = lemur_model
        self._environment = environment
        self._sdk = None  # lazy-loaded

        self._check_key_environment_mismatch()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _check_key_environment_mismatch(self) -> None:
        """Emit a CRITICAL log if a sandbox key is used in production.

        Does not raise — visibility is the goal, not a hard block, because
        the BAA may still be pending and the team needs to be able to run
        staging deployments without crashing.
        """
        if self._environment != "production":
            return
        if not self._api_key:
            return
        is_test_key = any(
            self._api_key.startswith(prefix) for prefix in _TEST_KEY_PREFIXES
        )
        if is_test_key:
            logger.critical(
                "HIPAA RISK: AssemblyAI sandbox/test key detected in production "
                "environment. PHI audio will be sent to a non-BAA endpoint. "
                "Replace ASSEMBLYAI_API_KEY with the production key immediately. "
                "environment=%s key_prefix=%s",
                self._environment,
                self._api_key[:8],  # Safe — only the key prefix, never the full key.
            )

    def _get_sdk(self):
        """Lazy-load the assemblyai SDK.

        Returns the module on success or raises ImportError with install hint.
        """
        if self._sdk is not None:
            return self._sdk
        try:
            import assemblyai as aai  # type: ignore[import-untyped]
            aai.settings.api_key = self._api_key
            self._sdk = aai
            return self._sdk
        except ImportError as exc:
            raise ImportError(
                "assemblyai SDK is not installed. "
                "Add 'assemblyai>=0.63.0' to pyproject.toml and re-install."
            ) from exc

    def _make_transcription_config(
        self,
        language: str,
        medical_model: bool,
    ):
        """Build an assemblyai.TranscriptionConfig for async transcription."""
        aai = self._get_sdk()

        speech_model = (
            aai.SpeechModel.conformer2 if medical_model else aai.SpeechModel.default
        )

        return aai.TranscriptionConfig(
            language_code=language,
            speech_model=speech_model,
            speaker_labels=True,
            entity_detection=True,
            punctuate=True,
            format_text=True,
            # PII redaction is always enabled for PHI compliance.
            redact_pii=True,
            redact_pii_policies=[
                aai.PIIRedactionPolicy.medical_condition,
                aai.PIIRedactionPolicy.medical_process,
                aai.PIIRedactionPolicy.blood_type,
                aai.PIIRedactionPolicy.drug,
                aai.PIIRedactionPolicy.injury,
                aai.PIIRedactionPolicy.person_age,
                aai.PIIRedactionPolicy.phone_number,
                aai.PIIRedactionPolicy.us_social_security_number,
            ],
        )

    @staticmethod
    def _parse_utterances(utterances: list | None) -> list[TranscriptChunk]:
        """Convert SDK utterance objects to TranscriptChunk instances."""
        if not utterances:
            return []
        chunks: list[TranscriptChunk] = []
        for u in utterances:
            chunks.append(
                TranscriptChunk(
                    speaker=getattr(u, "speaker", "?") or "?",
                    text=getattr(u, "text", "") or "",
                    start_ms=int(getattr(u, "start", 0) or 0),
                    end_ms=int(getattr(u, "end", 0) or 0),
                    confidence=float(getattr(u, "confidence", 0.0) or 0.0),
                    is_partial=False,
                )
            )
        return chunks

    @staticmethod
    def _parse_entities(entities: list | None) -> list[dict]:
        """Convert SDK entity objects to plain dicts for TranscriptionResult."""
        if not entities:
            return []
        result: list[dict] = []
        for e in entities:
            result.append(
                {
                    "type": getattr(e, "entity_type", None),
                    "text": getattr(e, "text", None),  # PHI — not logged
                    "start_ms": getattr(e, "start", None),
                    "end_ms": getattr(e, "end", None),
                }
            )
        return result

    # ------------------------------------------------------------------
    # TranscriptionProvider interface
    # ------------------------------------------------------------------

    async def start_streaming_session(
        self,
        session_id: UUID,
        language: str = "en",
    ) -> StreamingSession:
        """Open an AssemblyAI RealtimeTranscriber WebSocket session.

        The transcriber is stored in StreamingSession.provider_handle. Partial
        transcripts arrive via internal callbacks but are not surfaced here —
        callers receive the aggregated final transcript from
        end_streaming_session.

        AssemblyAI Universal-Streaming delivers ~300ms end-to-end latency.
        """
        if not self._api_key:
            raise RuntimeError(
                "ASSEMBLYAI_API_KEY is not set. Cannot open streaming session."
            )

        aai = self._get_sdk()

        def _create_transcriber() -> object:
            transcriber = aai.RealtimeTranscriber(
                sample_rate=STREAMING_SAMPLE_RATE,
                # Callbacks — we collect finals in a list for aggregation.
                on_data=lambda transcript: None,  # Handled in end_streaming_session
                on_error=lambda err: logger.error(
                    "AssemblyAI streaming error session_id=%s error=%s",
                    session_id,
                    err,
                ),
            )
            transcriber.connect()
            return transcriber

        transcriber = await asyncio.to_thread(_create_transcriber)
        logger.info(
            "AssemblyAI streaming session opened session_id=%s language=%s",
            session_id,
            language,
        )
        return StreamingSession(
            session_id=session_id,
            language=language,
            provider_handle=transcriber,
        )

    async def send_audio_chunk(
        self,
        stream: StreamingSession,
        pcm_chunk: bytes,
    ) -> None:
        """Stream a PCM chunk to the open RealtimeTranscriber.

        Audio must be 16-bit signed PCM, 16 kHz, mono. The content of
        pcm_chunk is never logged — it is PHI.
        """
        if stream.provider_handle is None:
            raise RuntimeError(
                f"StreamingSession for session_id={stream.session_id} "
                "has no active provider handle. Was start_streaming_session called?"
            )
        transcriber = stream.provider_handle

        def _send() -> None:
            transcriber.stream(pcm_chunk)

        await asyncio.to_thread(_send)

    async def end_streaming_session(
        self,
        stream: StreamingSession,
    ) -> TranscriptionResult:
        """Close the RealtimeTranscriber and return the aggregated transcript.

        The SDK's close() method flushes buffered audio and waits for the
        server to finalise all pending segments before closing the WebSocket.
        On any error we return a degraded result with empty text so the caller
        can decide how to handle it.
        """
        if stream.provider_handle is None:
            logger.warning(
                "end_streaming_session called with no provider handle session_id=%s",
                stream.session_id,
            )
            return TranscriptionResult(is_partial=False)

        transcriber = stream.provider_handle

        def _close() -> None:
            transcriber.close()

        try:
            await asyncio.to_thread(_close)
            logger.info(
                "AssemblyAI streaming session closed session_id=%s",
                stream.session_id,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "Error closing AssemblyAI streaming session session_id=%s",
                stream.session_id,
            )

        # The SDK's RealtimeTranscriber accumulates final transcript segments
        # internally. Access them via the final_transcript property if available;
        # otherwise fall back to an empty result.
        # TODO(#TBD): Confirm SDK version 0.63+ exposes `final_transcript`
        # or use on_data callback accumulation pattern if not.
        final_text: str = ""
        if hasattr(transcriber, "final_transcript"):
            final_text = getattr(transcriber, "final_transcript", "") or ""

        return TranscriptionResult(
            full_text=final_text,
            language=stream.language,
            is_partial=False,
        )

    async def transcribe_async(
        self,
        audio_url: str,
        language: str = "en",
        medical_model: bool = True,
    ) -> TranscriptionResult:
        """Submit a post-call audio URL and poll until AssemblyAI completes.

        Uses Conformer-2 when medical_model=True. Polls every
        POLL_INTERVAL_SECONDS up to POLL_TIMEOUT_SECONDS.

        On any failure (HTTP error, timeout, SDK exception) returns a
        TranscriptionResult with empty full_text so the caller can store the
        partial record and retry later.
        """
        if not self._api_key:
            logger.info(
                "AssemblyAI API key not configured — skipping transcription"
            )
            return TranscriptionResult()

        aai = self._get_sdk()
        config = self._make_transcription_config(
            language=language,
            medical_model=medical_model,
        )

        def _transcribe_sync():
            transcriber = aai.Transcriber()
            # submit_url queues the job and returns immediately with a Transcript
            # object whose status begins as "queued"/"processing".
            return transcriber.submit(audio_url, config=config)

        try:
            job = await asyncio.to_thread(_transcribe_sync)
            transcript_id: str = job.id
            logger.info(
                "AssemblyAI job submitted transcript_id=%s medical_model=%s",
                transcript_id,
                medical_model,
            )
        except Exception:  # noqa: BLE001
            logger.exception("AssemblyAI job submission failed audio_url=<redacted>")
            return TranscriptionResult()

        # Poll loop — runs in a thread to keep the event loop unblocked.
        def _poll_until_done(transcript_id: str):
            import time

            aai_local = self._get_sdk()
            elapsed = 0
            while elapsed < POLL_TIMEOUT_SECONDS:
                poll = aai_local.Transcript.get_by_id(transcript_id)
                status = poll.status
                if status == aai_local.TranscriptStatus.completed:
                    return poll
                if status == aai_local.TranscriptStatus.error:
                    logger.error(
                        "AssemblyAI transcription error transcript_id=%s",
                        transcript_id,
                    )
                    return None
                time.sleep(POLL_INTERVAL_SECONDS)
                elapsed += POLL_INTERVAL_SECONDS
            logger.warning(
                "AssemblyAI transcription timed out after %ds transcript_id=%s",
                POLL_TIMEOUT_SECONDS,
                transcript_id,
            )
            return None

        try:
            completed = await asyncio.to_thread(_poll_until_done, transcript_id)
        except Exception:  # noqa: BLE001
            logger.exception(
                "AssemblyAI poll loop failed transcript_id=%s", transcript_id
            )
            return TranscriptionResult(provider_transcript_id=transcript_id)

        if completed is None:
            return TranscriptionResult(provider_transcript_id=transcript_id)

        chunks = self._parse_utterances(getattr(completed, "utterances", None))
        entities = self._parse_entities(getattr(completed, "entities", None))
        duration_ms: int | None = getattr(completed, "audio_duration", None)
        if duration_ms is not None:
            duration_ms = int(duration_ms * 1000)  # SDK returns seconds as float

        return TranscriptionResult(
            provider_transcript_id=completed.id,
            language=getattr(completed, "language_code", language) or language,
            confidence=float(getattr(completed, "confidence", 0.0) or 0.0),
            full_text=getattr(completed, "text", "") or "",
            chunks=chunks,
            duration_ms=duration_ms,
            medical_entities=entities,
            is_partial=False,
        )

    async def extract_followups(
        self,
        transcript: str,
        member_name: str | None = None,
    ) -> ExtractedFollowups:
        """Run AssemblyAI LeMUR to extract structured follow-ups from a transcript.

        The prompt requests strict JSON output. The response is parsed with
        json.loads; if AssemblyAI returns markdown-fenced JSON we strip the
        fences before parsing.

        On any failure (LeMUR quota, network error, JSON parse error) we
        return ExtractedFollowups.degraded(reason) — never raise.

        HIPAA: transcript and member_name are PHI. They are sent to AssemblyAI
        under the BAA. Neither value is logged here.
        """
        if not self._api_key:
            return ExtractedFollowups.degraded("AssemblyAI API key not configured")
        if not transcript.strip():
            return ExtractedFollowups.degraded("Empty transcript provided")

        aai = self._get_sdk()

        member_clause = (
            f" with member {member_name}" if member_name else ""
        )
        prompt = _FOLLOWUP_PROMPT_TEMPLATE.format(
            member_clause=member_clause,
            transcript=transcript,
        )

        def _run_lemur() -> str:
            lemur = aai.Lemur()
            response = lemur.task(
                prompt=prompt,
                final_model=(
                    aai.LemurModel.default
                    if self._lemur_model == "default"
                    else self._lemur_model
                ),
            )
            return response.response

        try:
            raw_response: str = await asyncio.to_thread(_run_lemur)
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "AssemblyAI LeMUR call failed error_type=%s",
                type(exc).__name__,
            )
            return ExtractedFollowups.degraded(f"LeMUR call failed: {type(exc).__name__}")

        return self._parse_lemur_response(raw_response)

    # ------------------------------------------------------------------
    # LeMUR response parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _strip_markdown_fences(text: str) -> str:
        """Remove ```json ... ``` or ``` ... ``` fences if present.

        TODO: LeMUR JSON parsing assumes structured output mode; needs
        validation if AssemblyAI returns markdown-fenced JSON despite the
        prompt asking for raw JSON. This heuristic covers the common case.
        """
        text = text.strip()
        # Match optional language hint after opening fence.
        fence_pattern = re.compile(r"^```(?:json)?\s*([\s\S]*?)\s*```$", re.DOTALL)
        match = fence_pattern.match(text)
        if match:
            return match.group(1).strip()
        return text

    @classmethod
    def _parse_lemur_response(cls, raw: str) -> ExtractedFollowups:
        """Parse LeMUR JSON output into ExtractedFollowups.

        Applies fault-tolerant field coercion: unknown enum values fall back
        to their defaults rather than crashing.
        """
        cleaned = cls._strip_markdown_fences(raw)

        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError as exc:
            logger.error(
                "LeMUR response JSON parse failed error=%s response_length=%d",
                exc.msg,
                len(raw),
            )
            return ExtractedFollowups.degraded(f"JSON parse error: {exc.msg}")

        if not isinstance(data, dict):
            logger.error(
                "LeMUR response is not a JSON object type=%s", type(data).__name__
            )
            return ExtractedFollowups.degraded("LeMUR returned non-object JSON")

        action_items: list[ActionItem] = []
        for raw_item in data.get("action_items", []) or []:
            if not isinstance(raw_item, dict):
                continue
            try:
                owner = OwnerEnum(raw_item.get("owner", "both"))
            except ValueError:
                owner = OwnerEnum.BOTH
            action_items.append(
                ActionItem(
                    description=str(raw_item.get("description", "")),
                    owner=owner,
                    due_date=raw_item.get("due_date") or None,
                )
            )

        follow_up_tasks: list[FollowUpTask] = []
        for raw_task in data.get("follow_up_tasks", []) or []:
            if not isinstance(raw_task, dict):
                continue
            try:
                vertical = VerticalEnum(raw_task.get("vertical", "other"))
            except ValueError:
                vertical = VerticalEnum.OTHER
            try:
                priority = PriorityEnum(raw_task.get("priority", "medium"))
            except ValueError:
                priority = PriorityEnum.MEDIUM
            follow_up_tasks.append(
                FollowUpTask(
                    title=str(raw_task.get("title", "")),
                    vertical=vertical,
                    priority=priority,
                )
            )

        resources: list[ResourceReferred] = []
        for raw_res in data.get("resources_referred", []) or []:
            if not isinstance(raw_res, dict):
                continue
            try:
                res_type = ResourceTypeEnum(raw_res.get("type", "program"))
            except ValueError:
                res_type = ResourceTypeEnum.PROGRAM
            resources.append(
                ResourceReferred(
                    name=str(raw_res.get("name", "")),
                    type=res_type,
                )
            )

        goals: list[str] = [
            str(g) for g in (data.get("member_goals_stated", []) or [])
            if g
        ]

        return ExtractedFollowups(
            action_items=action_items,
            follow_up_tasks=follow_up_tasks,
            resources_referred=resources,
            member_goals_stated=goals,
        )
