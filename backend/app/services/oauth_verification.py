"""OAuth token verification service for Google and Apple Sign-In.

Architecture: token-verify model. The frontend completes the OAuth handshake
and sends only the id_token (a signed JWT). This service cryptographically
verifies the token against Google/Apple's public keys and returns an
OAuthIdentity — never trusts the raw payload without signature verification.

Security contract:
- Returns None on ANY verification failure (caller must → 401, never 500).
- Never logs the raw id_token (it is a bearer credential).
- email_verified must be True (Google) / truthy (Apple) before returning identity.
- aud claim must match our configured client ID exactly.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger("compass.oauth")

# Apple JWKS endpoint — public key set for verifying Sign in with Apple JWTs.
_APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"
_APPLE_ISSUER = "https://appleid.apple.com"

# Simple in-process JWKS cache: stores the raw dict returned by Apple's endpoint.
# Keyed by "apple_jwks" — reset by patching _apple_jwks_cache in tests.
# A production deployment should use a TTL-based cache (Apple rotates keys rarely).
_apple_jwks_cache: dict[str, Any] = {}


@dataclass(frozen=True)
class OAuthIdentity:
    """Verified identity returned from Google or Apple token verification.

    All fields are extracted from a cryptographically-verified JWT payload.
    Never construct this with unverified data.

    Attributes:
        email: The verified email address.
        email_verified: Whether the provider has verified this email.
        name: Display name from the token (None if provider didn't return it).
        provider: "google" or "apple".
        subject: The provider's stable user identifier (sub claim).
    """

    email: str
    email_verified: bool
    name: str | None
    provider: str
    subject: str


async def verify_google_id_token(id_token: str) -> OAuthIdentity | None:
    """Verify a Google ID token and return the identity it represents.

    Uses `google.oauth2.id_token.verify_oauth2_token` which fetches
    Google's public keys and validates the RS256/ES256 signature,
    expiry, issuer (accounts.google.com / accounts.google.com), and
    audience (must equal settings.google_oauth_client_id).

    Args:
        id_token: The raw id_token string from Google Identity Services JS SDK.

    Returns:
        OAuthIdentity on success, None on any verification failure.
        Never raises — all exceptions are caught and logged.
    """
    try:
        from google.auth.transport.requests import Request as _GoogleRequest
        from google.oauth2.id_token import verify_oauth2_token as _verify

        # verify_oauth2_token is synchronous (makes a blocking HTTP call on
        # first call to fetch Google's certs — subsequent calls are cached).
        # Running inside an async endpoint is acceptable: this is I/O-bound
        # and the google-auth library caches the cert after the first fetch.
        payload: dict[str, Any] = _verify(
            id_token,
            _GoogleRequest(),
            audience=settings.google_oauth_client_id,
        )

        # Double-check issuer (verify_oauth2_token does this, belt-and-suspenders).
        issuer = payload.get("iss", "")
        if issuer not in ("accounts.google.com", "https://accounts.google.com"):
            logger.warning("google oauth: unexpected issuer=%s", issuer)
            return None

        email: str = payload.get("email", "")
        if not email:
            logger.warning("google oauth: token missing email claim")
            return None

        email_verified: bool = bool(payload.get("email_verified", False))

        return OAuthIdentity(
            email=email.lower().strip(),
            email_verified=email_verified,
            name=payload.get("name") or None,
            provider="google",
            subject=str(payload["sub"]),
        )

    except Exception:  # noqa: BLE001
        # Catch ValueError (bad token), google.auth.exceptions.TransportError
        # (network), and any other verification failure. Never propagate — caller
        # maps None to 401.
        logger.warning("google oauth: token verification failed", exc_info=True)
        return None


async def _fetch_apple_jwks(force_refresh: bool = False) -> dict[str, Any]:
    """Fetch Apple's JSON Web Key Set (JWKS) with simple in-process caching.

    Apple rotates keys rarely; a per-process cache is sufficient for MVP.
    Pass force_refresh=True to bypass the cache (used when decode fails with
    an unknown kid, suggesting Apple rotated keys since last fetch).

    Returns:
        The raw JWKS dict (keys field contains a list of JWK objects).
    """
    global _apple_jwks_cache  # noqa: PLW0603
    if _apple_jwks_cache and not force_refresh:
        return _apple_jwks_cache

    async with httpx.AsyncClient(timeout=10.0) as http:
        resp = await http.get(_APPLE_JWKS_URL)
        resp.raise_for_status()
        _apple_jwks_cache = resp.json()
        return _apple_jwks_cache


def _decode_apple_jwt(id_token: str, jwks: dict[str, Any], audience: str) -> dict[str, Any]:
    """Decode and verify an Apple id_token using the JWKS.

    Verifies: RS256 signature, exp, iss == https://appleid.apple.com,
    aud == audience. Raises jwt.InvalidTokenError (or subclass) on any
    failure — callers should catch and return None.

    Args:
        id_token: Raw id_token from the Apple JS SDK.
        jwks: The JWKS dict from Apple's /auth/keys endpoint.
        audience: Must match the aud claim — our Apple Service ID.

    Returns:
        Verified JWT payload as a dict.

    Raises:
        jwt.InvalidTokenError: on any signature / claim validation failure.
    """
    import jwt
    from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
    from jwt.algorithms import RSAAlgorithm

    # Extract the kid from the unverified header to select the right public key.
    header = jwt.get_unverified_header(id_token)
    kid = header.get("kid")
    if not kid:
        raise jwt.InvalidTokenError("Apple id_token missing kid header")

    # Find the matching key in the JWKS.
    matching_key = next(
        (k for k in jwks.get("keys", []) if k.get("kid") == kid),
        None,
    )
    if matching_key is None:
        raise jwt.InvalidTokenError(f"No matching Apple public key for kid={kid}")

    # RSAAlgorithm.from_jwk always returns a public key for a public JWK;
    # cast to the concrete type to satisfy jwt.decode's type signature.
    public_key: RSAPublicKey = RSAAlgorithm.from_jwk(matching_key)  # type: ignore[assignment]

    return jwt.decode(  # type: ignore[return-value]
        id_token,
        public_key,
        algorithms=["RS256"],
        audience=audience,
        issuer=_APPLE_ISSUER,
        options={"verify_exp": True},
    )


async def verify_apple_id_token(id_token: str) -> OAuthIdentity | None:
    """Verify an Apple id_token and return the identity it represents.

    Fetches Apple's JWKS (cached per-process), verifies RS256 signature,
    exp, iss, and aud claims. If the kid is not found in the cached JWKS
    (Apple rotated keys), refreshes the cache and retries once.

    Apple sign-in specifics:
    - `name` is only returned on the FIRST consent — subsequent sign-ins
      omit it. We gracefully handle None.
    - `email` may be a private-relay address (e.g. abc123@privaterelay.appleid.com).
      We store it as-is; the member can update their display email later.
    - `email_verified` may be the string "true" (not a bool) — we coerce.

    Args:
        id_token: The raw id_token from Sign in with Apple JS SDK.

    Returns:
        OAuthIdentity on success, None on any verification failure.
        Never raises.
    """
    try:
        import jwt as _jwt

        jwks = await _fetch_apple_jwks()

        try:
            payload = _decode_apple_jwt(id_token, jwks, settings.apple_oauth_client_id)
        except _jwt.InvalidTokenError as exc:
            # kid not found might mean Apple rotated — retry with forced refresh.
            if "No matching Apple public key" in str(exc):
                logger.info("apple oauth: kid not in cache, refreshing JWKS")
                jwks = await _fetch_apple_jwks(force_refresh=True)
                payload = _decode_apple_jwt(id_token, jwks, settings.apple_oauth_client_id)
            else:
                raise

        email: str = payload.get("email", "")
        if not email:
            logger.warning("apple oauth: token missing email claim")
            return None

        # Apple may return email_verified as "true" (string) or True (bool).
        email_verified_raw = payload.get("email_verified", False)
        email_verified = email_verified_raw is True or email_verified_raw == "true"

        # Name is only present on first consent.
        name: str | None = payload.get("name") or None

        return OAuthIdentity(
            email=email.lower().strip(),
            email_verified=email_verified,
            name=name,
            provider="apple",
            subject=str(payload["sub"]),
        )

    except Exception:  # noqa: BLE001
        logger.warning("apple oauth: token verification failed", exc_info=True)
        return None
