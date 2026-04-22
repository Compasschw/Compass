"""Member → CHW matching service.

Scoring combines:
  1. Baseline CHWProfile signals: specializations, languages, proximity,
     availability, rating, years of experience.
  2. Enrichment from the 27-question CHW intake questionnaire: primary
     specialization mapping to the requested vertical, additional-language
     fluency, preferred modality, home-visit comfort, urgent-outreach
     availability.

The intake is optional — CHWs who haven't completed it score on baseline
signals alone. This lets the product launch before 100% of CHWs have
finished their intake.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

# ─── Distance helper ─────────────────────────────────────────────────────────

def haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in miles between two lat/lng pairs."""
    R = 3959
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlng / 2) ** 2
    )
    return R * 2 * math.asin(math.sqrt(a))


# ─── Intake → request-vertical mapping ───────────────────────────────────────
#
# The intake's primary_specialization uses DHCS-aligned clinical categories;
# member service requests use broader community-support verticals. A CHW whose
# self-reported intake specialization *maps* to the requested vertical gets a
# bonus on top of the baseline CHWProfile.specializations match.

INTAKE_SPECIALIZATION_TO_VERTICALS: dict[str, set[str]] = {
    "chronic_disease": {"healthcare"},
    "behavioral_health": {"mental_health", "rehab"},
    "maternal_child": {"healthcare"},
    "housing_social": {"housing", "food"},
    "cancer_prevention": {"healthcare"},
}

# Map intake's short-code language values to the human-readable names used in
# CHWProfile.languages (and the member request's language field).
INTAKE_LANGUAGE_TO_PROFILE: dict[str, str] = {
    "spanish": "Spanish",
    "mandarin_cantonese": "Mandarin",
    "vietnamese": "Vietnamese",
    "tagalog": "Tagalog",
    "korean": "Korean",
    "hmong": "Hmong",
    "armenian": "Armenian",
}


# ─── Result dataclass ────────────────────────────────────────────────────────

@dataclass
class MatchResult:
    """A single scored CHW candidate with explanations."""

    chw: Any  # CHWProfile (kept loose to avoid circular imports)
    score: float
    distance_miles: float
    match_reasons: list[str] = field(default_factory=list)


# ─── Scoring ─────────────────────────────────────────────────────────────────

def _score_intake(
    intake: Any,
    vertical: str,
    member_language: str,
    mode: str | None,
    urgency: str | None,
    reasons: list[str],
) -> float:
    """Additive bonus points from the CHW intake response.

    Returns 0 if intake is None (CHW hasn't completed the questionnaire).
    """
    if intake is None:
        return 0.0

    bonus = 0.0

    # Specialization mapping (+8): strongest intake signal
    if intake.primary_specialization:
        mapped = INTAKE_SPECIALIZATION_TO_VERTICALS.get(intake.primary_specialization, set())
        if vertical in mapped:
            bonus += 8
            reasons.append(
                f"specializes in {intake.primary_specialization.replace('_', ' ')}"
            )

    # Additional-language fluency (+5): catches CHWs whose profile.languages
    # list may be stale when the intake is fresher.
    if intake.additional_language:
        profile_name = INTAKE_LANGUAGE_TO_PROFILE.get(intake.additional_language)
        if profile_name and profile_name.lower() == (member_language or "").lower():
            bonus += 5
            if not any(r.startswith("speaks ") for r in reasons):
                reasons.append(f"speaks {profile_name}")

    # Modality preference (+5 / -5): steer in-person requests away from
    # remote-only CHWs and vice versa.
    if mode and intake.preferred_modality:
        if mode == "in_person":
            if intake.preferred_modality in {"in_person", "hybrid_in_person", "flexible"}:
                bonus += 5
                reasons.append("available for in-person")
            elif intake.preferred_modality == "remote":
                bonus -= 5
        elif mode == "remote":
            if intake.preferred_modality in {"remote", "hybrid_remote", "flexible"}:
                bonus += 5
                reasons.append("available for telehealth")
            elif intake.preferred_modality == "in_person":
                bonus -= 5

    # Home-visit comfort (for in-person requests only) (+3)
    if mode == "in_person" and intake.home_visit_comfort in {"prefer", "comfortable_safety"}:
        bonus += 3
        reasons.append("comfortable with home visits")

    # Urgent outreach availability (+5)
    if urgency == "urgent" and intake.urgent_outreach in {"regularly", "occasionally"}:
        bonus += 5
        reasons.append("available for urgent outreach")

    return bonus


def score_chw(
    chw,
    vertical: str,
    member_lat: float,
    member_lng: float,
    member_language: str,
    intake=None,
    mode: str | None = None,
    urgency: str | None = None,
) -> MatchResult | None:
    """Score a single CHW candidate.

    Returns None if the CHW doesn't offer the requested vertical (hard filter).
    """
    if vertical not in (chw.specializations or []):
        return None

    reasons: list[str] = []
    score = 0.0

    # Geographic proximity (up to 40)
    distance = None
    if chw.latitude and chw.longitude:
        distance = haversine(chw.latitude, chw.longitude, member_lat, member_lng)
        if distance <= 5:
            score += 40
            reasons.append(f"{distance:.1f} mi away")
        elif distance <= 15:
            score += 30
            reasons.append(f"{distance:.1f} mi away")
        elif distance <= 30:
            score += 15
            reasons.append(f"{distance:.1f} mi away")

    # Baseline language match from CHWProfile (up to 25)
    if member_language in (chw.languages or []):
        score += 25
        reasons.append(f"speaks {member_language}")

    # Availability (up to 20)
    if chw.is_available:
        score += 20

    # Rating + experience (up to ~15)
    if chw.rating:
        score += (chw.rating / 5.0) * 10
    score += min(chw.years_experience or 0, 10) * 0.5

    # Intake-based enrichment (additive; can be positive or negative)
    score += _score_intake(intake, vertical, member_language, mode, urgency, reasons)

    return MatchResult(
        chw=chw,
        score=round(score, 2),
        distance_miles=round(distance, 1) if distance is not None else 999.0,
        match_reasons=reasons,
    )


# ─── Public entry point ──────────────────────────────────────────────────────

async def find_matching_chws(
    db: AsyncSession,
    vertical: str,
    member_lat: float,
    member_lng: float,
    member_language: str,
    limit: int = 10,
    mode: str | None = None,
    urgency: str | None = None,
) -> list[dict]:
    """Return up to `limit` CHW candidates ranked by match score.

    Each result is a dict with: chw, score, distance_miles, match_reasons.
    Dicts (not dataclasses) for backward compatibility with the router that
    previously consumed this shape.
    """
    from app.models.chw_intake import CHWIntakeResponse
    from app.models.user import CHWProfile

    # Single query pulling profiles + their intake (if any) in one round trip.
    stmt = (
        select(CHWProfile, CHWIntakeResponse)
        .outerjoin(CHWIntakeResponse, CHWIntakeResponse.user_id == CHWProfile.user_id)
        .where(CHWProfile.is_available == True)  # noqa: E712
    )
    result = await db.execute(stmt)
    rows = result.all()

    scored: list[dict] = []
    for profile, intake in rows:
        match = score_chw(
            profile,
            vertical=vertical,
            member_lat=member_lat,
            member_lng=member_lng,
            member_language=member_language,
            intake=intake,
            mode=mode,
            urgency=urgency,
        )
        if match is None:
            continue
        scored.append(
            {
                "chw": match.chw,
                "score": match.score,
                "distance_miles": match.distance_miles,
                "match_reasons": match.match_reasons,
            }
        )

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:limit]
