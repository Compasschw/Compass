"""Shared password-complexity policy.

Single source of truth for the platform-wide password strength rule (QA-batch
#8/#10) so every password-accepting Pydantic schema — self-service signup,
CHW-initiated member creation (temp password), change-password, and password
reset — enforces the identical bar. A violation anywhere reuses the exact
same wording, so the frontend never has to guess which rule fired.

Policy: at least 8 characters, at least one uppercase letter, at least one
digit, and at least one special (non-alphanumeric) character. Deliberately
does NOT require a lowercase letter or forbid whitespace — kept close to
NIST 800-63B's spirit (length + a mix of character classes) without being
so strict it locks out legitimate passphrases.
"""

from __future__ import annotations

MIN_LENGTH = 8


def validate_password_complexity(value: str) -> str:
    """Validate ``value`` against the platform password policy.

    Intended for use as a Pydantic ``field_validator`` on every
    password-accepting field (``RegisterRequest.password``,
    ``ChangePasswordRequest.new_password``,
    ``CHWCreateMemberRequest.temp_password``,
    ``PasswordResetConfirmBody.new_password``, ...).

    Args:
        value: The raw candidate password string.

    Returns:
        The unmodified ``value`` when it satisfies every rule (Pydantic
        validators must return the value to keep it).

    Raises:
        ValueError: Naming every missing requirement in one message, e.g.
            "Password must contain at least one uppercase letter and one
            special character." Pydantic surfaces this as a 422 at the
            request boundary. Length is checked first and reported alone
            (a too-short password can't usefully satisfy the other rules
            anyway) so the message stays short and actionable.
    """
    if len(value) < MIN_LENGTH:
        raise ValueError(f"Password must be at least {MIN_LENGTH} characters long")

    missing: list[str] = []
    if not any(ch.isupper() for ch in value):
        missing.append("one uppercase letter")
    if not any(ch.isdigit() for ch in value):
        missing.append("one digit")
    if not any(not ch.isalnum() for ch in value):
        missing.append("one special character")

    if missing:
        if len(missing) == 1:
            requirement_text = missing[0]
        elif len(missing) == 2:
            requirement_text = " and ".join(missing)
        else:
            requirement_text = ", ".join(missing[:-1]) + ", and " + missing[-1]
        raise ValueError(f"Password must contain at least {requirement_text}")

    return value
