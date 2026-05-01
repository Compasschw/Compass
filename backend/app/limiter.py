import os

from slowapi import Limiter
from slowapi.util import get_remote_address

# Honour DISABLE_RATE_LIMIT for the test suite. Without this, tests that
# create multiple users via /auth/register collide with the 3/min limit and
# 429 cascades through every fixture that depends on chw_tokens / member_tokens.
_DISABLED = os.environ.get("DISABLE_RATE_LIMIT", "").lower() in ("1", "true", "yes")

limiter = Limiter(key_func=get_remote_address, enabled=not _DISABLED)
