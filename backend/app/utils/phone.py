"""Shared phone-number constants for the 555-555-5555 placeholder sentinel.

QA feedback batch (2026-07-14), Part 3: CHWs enter this number when a member
has no phone of their own. It is exempt from the platform-wide phone
uniqueness rule (see migration ``phoneidx0715`` + ``User.__table_args__`` in
``app/models/user.py``) so any number of accounts may share it, but it can
never be used to place or receive a masked call (no real device is behind
it) and can never receive SMS (mirrored, defensively, in
``app.services.sms_eligibility``).

Single source of truth — every call site that needs to recognize this
sentinel value imports it from here rather than redefining the literal.
"""

from __future__ import annotations

# Canonical E.164 form of "555-555-5555" (and all its common raw formatting
# variants — "(555) 555-5555", "5555555555", "+1 555 555 5555", etc. — which
# all collapse to this one value via
# ``app.services.auth_service._normalize_phone_e164``).
PLACEHOLDER_PHONE_E164: str = "+15555555555"

# User-facing message shown when a call is blocked because either party's
# phone is the placeholder sentinel. Deliberately worded as "member" — every
# masked call on Compass is between a CHW and a member, and the placeholder
# convention exists specifically for members without a phone of their own —
# so this reads correctly regardless of which leg (initiator or recipient)
# resolved to the sentinel.
PLACEHOLDER_PHONE_CALL_BLOCK_MESSAGE: str = (
    "This member's phone number is 555-555-5555 and cannot receive calls."
)


def is_placeholder_phone(e164: str | None) -> bool:
    """Return True when ``e164`` is exactly the placeholder sentinel.

    Exact-match only (not a prefix rule) — per product decision, only the
    literal 555-555-5555 number is treated as "no real phone", never a
    number that merely starts similarly.

    Assumes ``e164`` is already normalized (every write path routes through
    ``app.services.auth_service._normalize_phone_e164`` before persisting a
    User.phone value) — this function does not re-normalize.
    """
    return e164 is not None and e164 == PLACEHOLDER_PHONE_E164
