"""LLM summarizer abstraction for CHW session summaries.

Provides a ``SummarizerProvider`` Protocol that decouples the summary-generation
call-site from any specific LLM vendor.  Current implementations:

    AnthropicSummarizer  — calls Claude via the ``anthropic`` SDK.
    NoopSummarizer       — returns an empty SummaryResult.  Used in tests and
                           when ANTHROPIC_API_KEY is not configured.

Factory:

    get_summarizer() -> SummarizerProvider
        Returns ``AnthropicSummarizer`` when ``settings.anthropic_api_key`` is
        set; otherwise ``NoopSummarizer``.  Result is cached via
        ``functools.lru_cache`` so the SDK client is constructed once per
        process.

HIPAA note
----------
Transcript text and member names passed to ``summarize`` are PHI.  They are
transmitted to Anthropic under the applicable BAA.  Neither value is ever
logged in this module.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from typing import Protocol, Sequence

logger = logging.getLogger("compass.summarizer")

# ---------------------------------------------------------------------------
# Data contract
# ---------------------------------------------------------------------------

_MIN_TRANSCRIPT_CHARS = 50
"""Transcripts shorter than this threshold produce an empty SummaryResult.
The UI hides the AI-summary section when ``text`` is empty."""

# Role → human-readable prefix used in the labeled transcript sent to Claude.
# Unknown / untagged chunks use no prefix so the prompt instruction about
# "absent" labels still applies cleanly.
_ROLE_PREFIX: dict[str, str] = {
    "chw": "CHW",
    "member": "Member",
}

_MAX_OUTPUT_TOKENS = 500
"""Generous ceiling for the 3-5 sentence summary — roughly 375 words."""

_CLAUDE_MODEL = "claude-haiku-4-5"
"""Production model.  Haiku is the cheapest Claude tier and sufficient for
brief clinical summaries.  Switch to claude-sonnet-* for higher fidelity."""

_SYSTEM_PROMPT = (
    "You are a clinical documentation assistant supporting Community Health "
    "Workers (CHWs) in a Medi-Cal case management programme.  Your role is "
    "to produce concise, factual summaries of CHW–member conversations that "
    "can appear verbatim in a case management note.\n\n"
    "The transcript you receive may contain speaker labels: lines prefixed with "
    "\"CHW:\" are spoken by the Community Health Worker; lines prefixed with "
    "\"Member:\" are spoken by the patient/member.  Use this attribution to "
    "accurately represent who disclosed what, who asked which questions, and "
    "who committed to which follow-up actions.  When speaker labels are absent "
    "(legacy single-stream sessions), treat the transcript as undifferentiated "
    "conversation.\n\n"
    "Rules:\n"
    "- Write 3-5 sentences in plain, clinical-but-accessible language.\n"
    "- Focus on: what the member discussed or disclosed, their stated needs, "
    "and any action items or next steps that were mentioned.\n"
    "- When speaker labels are present, correctly attribute statements to CHW "
    "or Member (e.g. 'The CHW asked about…', 'The member reported…').\n"
    "- Do NOT invent facts absent from the transcript.\n"
    "- Do NOT use markdown headings, bullet points, or bold text — plain prose only.\n"
    "- Do NOT include diagnostic conclusions or clinical judgments beyond what "
    "the CHW or member stated explicitly.\n"
    "- Keep the tone neutral and factual, suitable for a Medi-Cal audit."
)


@dataclass
class SummaryResult:
    """Output of a single summarise call.

    ``text`` is empty string when the transcript was too short or the provider
    is unavailable — callers should hide the AI-summary UI section in that case.
    ``generated_at`` is None when ``text`` is empty.
    """

    text: str = ""
    generated_at: datetime | None = field(default=None)

    @classmethod
    def empty(cls) -> SummaryResult:
        """Canonical empty result — transcript too short or provider unavailable."""
        return cls(text="", generated_at=None)


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------


def build_labeled_transcript(
    chunks: Sequence[dict],
) -> str:
    """Assemble a speaker-labeled transcript string from a sequence of chunk dicts.

    Each chunk dict is expected to carry ``"text"`` and ``"speaker_role"``
    fields (the same shape stored in ``session_transcripts``).  Only final
    chunks (``is_final=True`` or key absent — legacy rows) are included.

    Output format (one utterance per line)::

        CHW: Can you tell me more about your housing situation?
        Member: I've been staying at a shelter for the past two weeks.
        CHW: I'm going to connect you with our housing specialist.

    When ``speaker_role`` is absent or ``"unknown"``, the line is emitted
    without a prefix so Claude treats it as undifferentiated speech per the
    system-prompt instructions.

    PHI contract: this function never logs chunk text.
    """
    lines: list[str] = []
    for chunk in chunks:
        text: str = (chunk.get("text") or "").strip()
        if not text:
            continue
        # Skip partial (in-flight) chunks if the key is present and False.
        if chunk.get("is_final") is False:
            continue
        role: str = chunk.get("speaker_role") or "unknown"
        prefix = _ROLE_PREFIX.get(role, "")
        lines.append(f"{prefix}: {text}" if prefix else text)
    return "\n".join(lines)


class SummarizerProvider(Protocol):
    """Duck-typed interface for LLM summary providers.

    Any object that satisfies this Protocol can be returned by ``get_summarizer``
    without subclassing — making it straightforward to add future providers
    (e.g. OpenAI, Gemini) as sibling implementations.
    """

    async def summarize(
        self,
        transcript: str,
        *,
        vertical: str | None = None,
    ) -> SummaryResult:
        """Produce a plain-text summary of the given CHW session transcript.

        Args:
            transcript: The assembled session transcript text.  PHI — do not log.
                        May contain speaker-labeled lines (``CHW: …`` / ``Member: …``)
                        built via ``build_labeled_transcript`` for dual-stream sessions,
                        or plain concatenated text for legacy single-stream sessions.
            vertical:   Optional service vertical hint (e.g. "housing", "food").
                        Used to tailor context in the prompt.

        Returns:
            SummaryResult with ``text`` populated on success, or
            ``SummaryResult.empty()`` when the transcript is too short, the
            provider key is absent, or any network/API error occurs.
        """
        ...

    async def summarize_chunks(
        self,
        chunks: Sequence[dict],
        *,
        vertical: str | None = None,
    ) -> SummaryResult:
        """Build a speaker-labeled transcript from chunk dicts and summarize it.

        Convenience entry-point for callers that have the raw ``session_transcripts``
        rows (or equivalent dicts) rather than a pre-assembled string.  Each dict
        must contain at minimum ``"text"`` and ``"speaker_role"``.

        The chunks are assembled into a labeled string via ``build_labeled_transcript``
        and then forwarded to ``summarize``.  The same length gate applies.

        PHI contract: chunk text is never logged.
        """
        ...


# ---------------------------------------------------------------------------
# NoopSummarizer
# ---------------------------------------------------------------------------


class NoopSummarizer:
    """Returns an empty SummaryResult.

    Used in tests and when ``ANTHROPIC_API_KEY`` is not configured.  The
    class satisfies ``SummarizerProvider`` structurally without declaring it.
    """

    async def summarize(
        self,
        transcript: str,
        *,
        vertical: str | None = None,
    ) -> SummaryResult:
        """Always returns an empty result — no network call made."""
        return SummaryResult.empty()

    async def summarize_chunks(
        self,
        chunks: Sequence[dict],
        *,
        vertical: str | None = None,
    ) -> SummaryResult:
        """Always returns an empty result — no network call made."""
        return SummaryResult.empty()


# ---------------------------------------------------------------------------
# AnthropicSummarizer
# ---------------------------------------------------------------------------


class AnthropicSummarizer:
    """Calls the Anthropic Messages API to produce a session summary.

    Uses the ``anthropic`` SDK (async client).  The SDK client is created once
    in ``__init__`` and reused across calls — ``get_summarizer`` ensures a
    single instance per process via ``lru_cache``.

    On any API error (rate limit, network failure, bad response) the method
    logs the error type (never the transcript) and returns ``SummaryResult.empty()``.

    Args:
        api_key: Anthropic API key.  Obtained from ``settings.anthropic_api_key``.
    """

    def __init__(self, api_key: str) -> None:
        # Finding #4 BAA gate (CRITICAL) — refuse to construct an Anthropic
        # client in production unless ANTHROPIC_BAA_CONFIRMED=true is set.
        # Transcript text passed to ``summarize`` is PHI; it must not reach
        # Anthropic's servers before the BAA is countersigned.
        try:
            from app.config import settings as _settings
            if _settings.environment == "production" and not _settings.anthropic_baa_confirmed:
                raise RuntimeError(
                    "Anthropic BAA not confirmed; refusing to send PHI to Claude. "
                    "Set ANTHROPIC_BAA_CONFIRMED=true in production .env after "
                    "the BAA is countersigned by legal."
                )
        except ImportError:
            pass  # Outside of the main app context; let caller handle.

        try:
            import anthropic  # type: ignore[import-untyped]
        except ImportError as exc:
            raise ImportError(
                "anthropic SDK is not installed. "
                "Add 'anthropic>=0.25.0' to pyproject.toml dependencies."
            ) from exc

        self._client = anthropic.AsyncAnthropic(api_key=api_key)

    async def summarize(
        self,
        transcript: str,
        *,
        vertical: str | None = None,
    ) -> SummaryResult:
        """Call Claude to produce a 3-5 sentence plain-text clinical summary.

        Returns ``SummaryResult.empty()`` when:
        - ``transcript`` is empty or under ``_MIN_TRANSCRIPT_CHARS`` characters.
        - The Anthropic API returns an error.
        - Any unexpected exception occurs.

        PHI contract: ``transcript`` is never logged.
        """
        if not transcript or len(transcript.strip()) < _MIN_TRANSCRIPT_CHARS:
            logger.debug(
                "AnthropicSummarizer.summarize: transcript too short (len=%d) — returning empty",
                len(transcript),
            )
            return SummaryResult.empty()

        vertical_clause = f" The session vertical is: {vertical}." if vertical else ""
        # Note to prompt: lines prefixed "CHW:" / "Member:" enable attribution.
        # Plain transcripts (legacy single-stream) have no prefixes — the model
        # falls back to generic attribution per the system prompt instructions.
        user_message = (
            f"Please summarise the following CHW session transcript.{vertical_clause} "
            f"Speaker-labeled lines (\"CHW: …\", \"Member: …\") indicate who spoke "
            f"each utterance; unlabeled lines come from a session where speaker "
            f"attribution was not available.\n\n"
            f"Transcript:\n{transcript}\n\nSummary:"
        )

        try:

            response = await self._client.messages.create(
                model=_CLAUDE_MODEL,
                max_tokens=_MAX_OUTPUT_TOKENS,
                system=_SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_message}],
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "AnthropicSummarizer.summarize: API call failed error_type=%s",
                type(exc).__name__,
            )
            return SummaryResult.empty()

        raw_text: str = ""
        if response.content and hasattr(response.content[0], "text"):
            raw_text = response.content[0].text or ""

        # Strip the "Summary:" echo if the model repeats the prompt suffix.
        summary = raw_text.strip()
        if summary.lower().startswith("summary:"):
            summary = summary[len("summary:"):].lstrip()

        if not summary:
            logger.warning(
                "AnthropicSummarizer.summarize: empty text in API response "
                "stop_reason=%s",
                getattr(response, "stop_reason", "unknown"),
            )
            return SummaryResult.empty()

        return SummaryResult(text=summary, generated_at=datetime.now(UTC))

    async def summarize_chunks(
        self,
        chunks: Sequence[dict],
        *,
        vertical: str | None = None,
    ) -> SummaryResult:
        """Build a speaker-labeled transcript from chunk dicts and summarize it.

        Assembles a ``CHW: … / Member: …`` labeled string via
        ``build_labeled_transcript`` then delegates to ``summarize``.
        The same length gate (``_MIN_TRANSCRIPT_CHARS``) applies to the
        assembled string.

        PHI contract: chunk text is never logged.
        """
        labeled = build_labeled_transcript(chunks)
        return await self.summarize(labeled, vertical=vertical)


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


@lru_cache(maxsize=1)
def get_summarizer() -> SummarizerProvider:
    """Return the configured summarizer, constructed once per process.

    Reads ``settings.anthropic_api_key``.  Returns ``AnthropicSummarizer``
    when the key is present and non-empty; otherwise ``NoopSummarizer``.

    The ``lru_cache`` ensures the SDK client (and its underlying httpx
    connection pool) is shared across all callers rather than constructed per
    request.
    """
    from app.config import settings

    api_key = settings.anthropic_api_key
    if api_key:
        logger.info("get_summarizer: returning AnthropicSummarizer model=%s", _CLAUDE_MODEL)
        return AnthropicSummarizer(api_key=api_key)

    logger.info(
        "get_summarizer: ANTHROPIC_API_KEY not set — returning NoopSummarizer"
    )
    return NoopSummarizer()
