"""CHW weekly availability: parsing, validation, and slot generation.

Availability is stored on ``CHWProfile.availability_windows`` as a JSONB dict
keyed by lowercase 3-letter weekday abbreviations, each mapping to a single
``"HH:MM-HH:MM"`` window (24-hour clock), e.g.::

    {"mon": "09:00-17:00", "wed": "09:00-17:00", "fri": "10:00-14:00"}

A legacy hour-only form (``"9-17"``) is accepted on input and normalized to the
``"HH:MM-HH:MM"`` form. Days absent from the dict mean "not available that day".

The same window definition drives:
  - the CHW's own availability editor (GET/PUT /chw/availability), and
  - the member-facing bookable-slot list (30-minute increments within a day's
    window, minus times already taken by the CHW's booked/pending sessions).
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta

# Canonical weekday keys, Monday-first. Index matches datetime.weekday().
WEEKDAY_KEYS: tuple[str, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

# Default slot length for member bookings.
SLOT_MINUTES = 30


class AvailabilityError(ValueError):
    """Raised when an availability payload is malformed."""


def _parse_time(token: str) -> time:
    """Parse ``"9"``, ``"09"``, or ``"09:30"`` into a :class:`datetime.time`.

    Raises:
        AvailabilityError: token is not a valid 24-hour time.
    """
    token = token.strip()
    if not token:
        raise AvailabilityError("Empty time value.")
    parts = token.split(":")
    try:
        hour = int(parts[0])
        minute = int(parts[1]) if len(parts) > 1 else 0
    except ValueError as exc:
        raise AvailabilityError(f"Invalid time '{token}'.") from exc
    if len(parts) > 2:
        raise AvailabilityError(f"Invalid time '{token}'.")
    if not (0 <= hour <= 23) or not (0 <= minute <= 59):
        raise AvailabilityError(f"Time out of range '{token}'.")
    return time(hour=hour, minute=minute)


def parse_window(value: str) -> tuple[time, time]:
    """Parse a ``"HH:MM-HH:MM"`` (or legacy ``"H-H"``) window into (start, end).

    Raises:
        AvailabilityError: value is not a valid window or start >= end.
    """
    if not isinstance(value, str) or "-" not in value:
        raise AvailabilityError(f"Window must look like '09:00-17:00', got {value!r}.")
    start_token, end_token = value.split("-", 1)
    start = _parse_time(start_token)
    end = _parse_time(end_token)
    if start >= end:
        raise AvailabilityError(f"Window start must be before end in {value!r}.")
    return start, end


def _format_window(start: time, end: time) -> str:
    return f"{start.strftime('%H:%M')}-{end.strftime('%H:%M')}"


def validate_and_normalize(windows: dict) -> dict[str, str]:
    """Validate an availability payload and normalize every window to HH:MM-HH:MM.

    Args:
        windows: Raw dict keyed by weekday abbreviation → window string.

    Returns:
        A new dict with canonical keys and normalized window strings, with any
        empty/blank values dropped (a day the CHW cleared = not available).

    Raises:
        AvailabilityError: a key is not a valid weekday, or a window is invalid.
    """
    if not isinstance(windows, dict):
        raise AvailabilityError("Availability must be an object keyed by weekday.")
    normalized: dict[str, str] = {}
    for raw_key, raw_value in windows.items():
        key = str(raw_key).strip().lower()[:3]
        if key not in WEEKDAY_KEYS:
            raise AvailabilityError(
                f"Invalid weekday '{raw_key}'. Use one of {list(WEEKDAY_KEYS)}."
            )
        # Allow clearing a day by sending null/empty.
        if raw_value is None or (isinstance(raw_value, str) and not raw_value.strip()):
            continue
        start, end = parse_window(str(raw_value))
        normalized[key] = _format_window(start, end)
    return normalized


def generate_day_slots(
    day: date,
    window_value: str,
    *,
    slot_minutes: int = SLOT_MINUTES,
) -> list[datetime]:
    """Generate slot start datetimes for one day within its window.

    Each slot is ``slot_minutes`` long; a slot is included only if the full slot
    fits inside the window (a trailing partial slot is dropped). Returned
    datetimes are naive local wall-clock times for the given calendar day; the
    caller attaches timezone/UTC handling.

    Args:
        day: The calendar day to generate slots for.
        window_value: The day's window string ("HH:MM-HH:MM").
        slot_minutes: Slot length in minutes (default 30).

    Returns:
        Ordered list of slot-start datetimes (may be empty).
    """
    start, end = parse_window(window_value)
    cursor = datetime.combine(day, start)
    day_end = datetime.combine(day, end)
    step = timedelta(minutes=slot_minutes)
    slots: list[datetime] = []
    while cursor + step <= day_end:
        slots.append(cursor)
        cursor += step
    return slots


def window_for_day(windows: dict | None, day: date) -> str | None:
    """Return the window string for ``day``'s weekday, or None if unavailable."""
    if not windows or not isinstance(windows, dict):
        return None
    key = WEEKDAY_KEYS[day.weekday()]
    value = windows.get(key)
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    return str(value)
