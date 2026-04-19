"""AssemblyAI transcription provider.

Offers a HIPAA BAA + medical terminology model. Pricing:
  $0.0025/min base + $0.0025/min medical add-on = ~$0.005/min

Docs: https://www.assemblyai.com/docs/api-reference/transcripts

Workflow:
1. POST /v2/transcript with { audio_url, speaker_labels, entity_detection, ... }
2. Poll GET /v2/transcript/{id} until status = "completed" | "error"
3. Extract text, confidence, diarization segments, medical entities
"""

import asyncio
import logging

import httpx

from app.services.transcription.base import (
    Transcript,
    TranscriptionProvider,
    TranscriptSegment,
)

logger = logging.getLogger("compass.transcription.assemblyai")

BASE_URL = "https://api.assemblyai.com/v2"
POLL_INTERVAL_SECONDS = 3
POLL_TIMEOUT_SECONDS = 600  # 10 min — most sessions transcribe in under 2 min


class AssemblyAIProvider(TranscriptionProvider):
    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def _headers(self) -> dict[str, str]:
        return {
            "authorization": self._api_key,
            "content-type": "application/json",
        }

    async def transcribe(self, audio_url: str, *, medical: bool = True) -> Transcript | None:
        if not self._api_key:
            logger.info("AssemblyAI API key not configured — skipping transcription")
            return None

        request_body = {
            "audio_url": audio_url,
            "speaker_labels": True,
            "entity_detection": True,  # Pulls out names, medical terms, locations
            "language_detection": True,
            "punctuate": True,
            "format_text": True,
        }
        if medical:
            # AssemblyAI applies their medical terminology model when this is set.
            # This is charged as a $0.15/hr add-on on top of the base rate.
            request_body["speech_model"] = "universal"
            request_body["redact_pii"] = True  # Auto-redact SSN, phone, etc.
            request_body["redact_pii_policies"] = [
                "medical_condition",
                "medical_process",
                "blood_type",
                "drug",
                "injury",
                "person_age",
                "phone_number",
                "us_social_security_number",
            ]

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                # Submit transcription job
                submit = await client.post(
                    f"{BASE_URL}/transcript",
                    json=request_body,
                    headers=self._headers(),
                )
                submit.raise_for_status()
                job = submit.json()
                transcript_id = job["id"]

                # Poll until complete
                elapsed = 0
                while elapsed < POLL_TIMEOUT_SECONDS:
                    poll = await client.get(
                        f"{BASE_URL}/transcript/{transcript_id}",
                        headers=self._headers(),
                    )
                    poll.raise_for_status()
                    data = poll.json()
                    status = data.get("status")
                    if status == "completed":
                        return self._parse(data)
                    if status == "error":
                        logger.error("AssemblyAI transcription error: %s", data.get("error"))
                        return None
                    await asyncio.sleep(POLL_INTERVAL_SECONDS)
                    elapsed += POLL_INTERVAL_SECONDS

                logger.warning("AssemblyAI transcription timed out after %ds", POLL_TIMEOUT_SECONDS)
                return None
        except httpx.HTTPStatusError as e:
            logger.error("AssemblyAI HTTP %d: %s", e.response.status_code, e.response.text[:500])
            return None
        except Exception as e:  # noqa: BLE001
            logger.error("AssemblyAI transcription failed: %s", e)
            return None

    def _parse(self, data: dict) -> Transcript:
        segments = []
        for u in data.get("utterances", []) or []:
            segments.append(TranscriptSegment(
                speaker=u.get("speaker", "?"),
                text=u.get("text", ""),
                start_ms=int(u.get("start", 0)),
                end_ms=int(u.get("end", 0)),
            ))

        medical_entities = []
        for e in data.get("entities", []) or []:
            medical_entities.append({
                "type": e.get("entity_type"),
                "text": e.get("text"),
                "start_ms": e.get("start"),
                "end_ms": e.get("end"),
            })

        return Transcript(
            text=data.get("text", ""),
            confidence=float(data.get("confidence", 0)),
            language=data.get("language_code", "en"),
            segments=segments,
            provider_id=data.get("id"),
            medical_entities=medical_entities,
        )
