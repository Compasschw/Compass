"""Unit tests for app.services.matching_service.score_chw.

These tests exercise the specializations scoring logic in isolation —
no database, no HTTP client, no fixtures from conftest.py.  They use
simple SimpleNamespace objects to stand in for CHWProfile rows so that
the scoring arithmetic can be verified without any I/O.

Coverage:
  1. CHW with vertical in specializations → no penalty; positive score.
  2. CHW with empty specializations → -15 penalty applied; result not None.
  3. CHW with non-empty specs that exclude the vertical → -30 penalty applied.
  4. Sort order: matching CHW ranks above empty-specs, which ranks above
     wrong-spec CHW.
"""

from types import SimpleNamespace

import pytest

from app.services.matching_service import MatchResult, score_chw


# ─── Override the autouse DB fixture so these pure-unit tests don't need
#     a running Postgres instance.  conftest.py declares setup_db as
#     autouse=True at function scope; a local fixture with the same name
#     and scope shadows it for every test in this module. ─────────────────────

@pytest.fixture(autouse=True)
def setup_db():  # noqa: PT004 — intentional no-op override
    """No-op DB fixture: matching_service unit tests are pure Python."""
    yield


# ─── CHW stub factory ─────────────────────────────────────────────────────────

def _make_chw(
    *,
    specializations: list[str] | None = None,
    languages: list[str] | None = None,
    latitude: float = 34.05,
    longitude: float = -118.24,
    is_available: bool = True,
    rating: float = 0.0,
    years_experience: int = 0,
) -> SimpleNamespace:
    """Return a minimal CHWProfile-shaped object for unit testing."""
    return SimpleNamespace(
        specializations=specializations,
        languages=languages or [],
        latitude=latitude,
        longitude=longitude,
        is_available=is_available,
        rating=rating,
        years_experience=years_experience,
    )


# Fixed member coordinates (Los Angeles area) used across all tests.
_MEMBER_LAT = 34.05
_MEMBER_LNG = -118.24
_VERTICAL = "food"


# ─── Test cases ───────────────────────────────────────────────────────────────


def test_matching_vertical_no_penalty() -> None:
    """A CHW whose specializations include the requested vertical incurs no
    specialization penalty, so their raw score must be >= 0."""
    chw = _make_chw(specializations=["food", "housing"])

    result = score_chw(
        chw,
        vertical=_VERTICAL,
        member_lat=_MEMBER_LAT,
        member_lng=_MEMBER_LNG,
        member_language="English",
    )

    assert isinstance(result, MatchResult), "score_chw must return a MatchResult for matching CHW"
    # Availability adds 20; no specialization penalty → score must be positive.
    assert result.score > 0, f"Expected positive score, got {result.score}"
    # The -15 / -30 penalty strings must NOT appear in match reasons.
    assert not any("no specializations" in r for r in result.match_reasons), (
        "Matching CHW should not have the 'no specializations set' reason"
    )
    assert not any("primarily specializes in" in r for r in result.match_reasons), (
        "Matching CHW should not have the wrong-spec reason"
    )


def test_empty_specializations_applies_minus_15_penalty() -> None:
    """A CHW with empty (or None) specializations must still be returned
    as a MatchResult, with a -15 penalty baked into the score and the
    explanatory reason string present."""
    for empty_value in (None, [], ):
        chw = _make_chw(specializations=empty_value, is_available=False, rating=0.0)

        result = score_chw(
            chw,
            vertical=_VERTICAL,
            member_lat=_MEMBER_LAT,
            member_lng=_MEMBER_LNG,
            member_language="English",
        )

        assert isinstance(result, MatchResult), (
            f"score_chw must return MatchResult for empty specializations={empty_value!r}"
        )
        # With is_available=False, rating=0.0, years_experience=0, and no
        # geographic offset (same coords as member → distance ≈ 0 → +40), the
        # only deduction is the -15 penalty.  Score = 40 - 15 = 25.
        assert result.score == pytest.approx(25.0), (
            f"Expected score 25.0 (40 proximity - 15 penalty), got {result.score}"
        )
        assert any("no specializations set" in r for r in result.match_reasons), (
            "Expected 'no specializations set' in match_reasons"
        )


def test_wrong_specialization_applies_minus_30_penalty() -> None:
    """A CHW with non-empty specializations that exclude the requested
    vertical must still be returned as a MatchResult, with a -30 penalty
    and an explanatory reason string."""
    chw = _make_chw(specializations=["mental_health", "rehab"], is_available=False, rating=0.0)

    result = score_chw(
        chw,
        vertical=_VERTICAL,
        member_lat=_MEMBER_LAT,
        member_lng=_MEMBER_LNG,
        member_language="English",
    )

    assert isinstance(result, MatchResult), (
        "score_chw must return MatchResult for wrong-specialization CHW"
    )
    # Same logic: 40 proximity - 30 penalty = 10.
    assert result.score == pytest.approx(10.0), (
        f"Expected score 10.0 (40 proximity - 30 penalty), got {result.score}"
    )
    assert any("primarily specializes in mental_health" in r for r in result.match_reasons), (
        "Expected 'primarily specializes in mental_health' in match_reasons"
    )


def test_sort_order_matching_above_empty_above_wrong_spec() -> None:
    """After sorting by score descending, the ranking must be:
      1. matching CHW (no penalty)
      2. empty-specs CHW (-15 penalty)
      3. wrong-spec CHW (-30 penalty)
    """
    # All CHWs: is_available=True → +20; same coords as member → +40.
    chw_matching = _make_chw(specializations=["food"])
    chw_empty = _make_chw(specializations=None)
    chw_wrong = _make_chw(specializations=["mental_health"])

    results = [
        score_chw(
            chw,
            vertical=_VERTICAL,
            member_lat=_MEMBER_LAT,
            member_lng=_MEMBER_LNG,
            member_language="English",
        )
        for chw in (chw_matching, chw_empty, chw_wrong)
    ]

    # All three must produce MatchResult (no hard-filter exclusions).
    assert all(isinstance(r, MatchResult) for r in results), (
        "All three CHWs must produce a MatchResult"
    )

    ranked = sorted(results, key=lambda r: r.score, reverse=True)

    assert ranked[0].chw is chw_matching, "Matching CHW must rank first"
    assert ranked[1].chw is chw_empty, "Empty-specs CHW must rank second"
    assert ranked[2].chw is chw_wrong, "Wrong-spec CHW must rank last"
