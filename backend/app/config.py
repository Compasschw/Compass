import sys

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    secret_key: str
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7

    # ── Vonage webhook signature (Finding #1, CRITICAL) ───────────────────────
    # HMAC-SHA256 secret used to verify incoming Vonage Voice webhook requests.
    # Set in the Vonage API Settings dashboard under "Signature method: SHA-256 HMAC".
    # When empty in production the server refuses to start (fail-safe).
    # Generate: python -c "import secrets; print(secrets.token_hex(32))"
    vonage_signature_secret: str = ""

    aws_region: str = "us-west-2"
    s3_bucket_phi: str = "compass-phi-dev"
    s3_bucket_public: str = "compass-public-dev"

    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://localhost:8081",
        "http://localhost:8083",
        "https://joincompasschw.com",
        "https://www.joincompasschw.com",
    ]

    # Communication provider (vonage, twilio, plivo)
    communication_provider: str = "vonage"

    # Vonage (recommended for MVP)
    vonage_api_key: str = ""
    vonage_api_secret: str = ""
    vonage_application_id: str = ""
    vonage_private_key_path: str = ""
    # The rented virtual number that both parties see on caller ID during
    # masked calls. Format: E.164 without the + (e.g. "18127224291").
    vonage_from_number: str = ""
    # Base URL for the backend WebSocket server that receives the live audio
    # fork from Vonage.  Must be a wss:// URL with no trailing slash.
    # e.g. "wss://api.joincompasschw.com"
    # When empty, the WebSocket fork is silently skipped and only the
    # existing mp3 record action runs (safe fallback for local dev / staging).
    vonage_ws_audio_url_base: str = ""

    # Twilio (future option)
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_proxy_service_sid: str = ""

    # Billing provider (pear_suite, direct_837)
    billing_provider: str = "pear_suite"

    # Pear Suite billing integration
    pear_suite_api_key: str = ""
    pear_suite_base_url: str = "https://api.pearsuite.com"

    # ── Pear Suite demo / real-submission config ──────────────────────────────
    # Jemal's userId in Pear Suite — obtained from Pear dashboard → Users.
    # Must be set before the demo-claim endpoint can submit a real claim.
    # Empty string degrades to a clear 400 at claim time, not at startup.
    pear_suite_demo_chw_user_id: str = ""
    # Activity Template ID built in Pear's Builder UI with billing enabled.
    # Procedure inside the template is 98960/98961/98962 (the CHW codes Pear
    # accepts) — NOT T1016. DEPLOY.md uses this same env-var name; the code
    # used to read PEAR_SUITE_T1016_TEMPLATE_ID which silently mismatched.
    pear_suite_demo_template_id: str = ""
    # Default ICD-10 diagnosis codes applied to CHW service claims when the
    # session documentation does not supply specific codes.
    pear_suite_default_dx_codes: list[str] = ["Z71.89"]

    # Admin dashboard access
    admin_key: str = ""

    # PHI field-level encryption (AES-256-GCM). Base64 of 32 random bytes.
    # Generate: python -c "import secrets, base64; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"
    phi_encryption_key: str = ""

    # Notification provider (expo for MVP; future: direct apns/fcm)
    notification_provider: str = "expo"
    expo_access_token: str = ""  # Optional; higher rate limits when set

    # Transactional email (AWS SES default; covered by AWS BAA)
    email_provider: str = "ses"
    email_from: str = "noreply@joincompasschw.com"
    email_reply_to: str = ""

    # Magic-link auth (passwordless login via email)
    magic_link_ttl_minutes: int = 15
    magic_link_base_url: str = "https://joincompasschw.com/auth/magic"

    # Transcription provider (assemblyai for medical-grade; vonage_builtin as fallback)
    transcription_provider: str = "assemblyai"
    assemblyai_api_key: str = ""
    # AssemblyAI workspace ID — used for org-scoped API calls and BAA audit trails.
    # Found under Settings → Workspace in the AssemblyAI dashboard.
    assemblyai_workspace_id: str = ""
    # LeMUR model slug for follow-up extraction.
    # "default" uses AssemblyAI's recommended model at request time.
    # Alternatives: "anthropic/claude-3-haiku", "anthropic/claude-3-5-sonnet"
    assemblyai_lemur_model: str = "default"

    # Anthropic API key — used for AI summary generation via Claude.
    # When set, AnthropicSummarizer is used; otherwise NoopSummarizer returns empty.
    # Generate at: https://console.anthropic.com/settings/keys
    anthropic_api_key: str | None = None

    # ── BAA confirmation gates (Findings #3, #4, CRITICAL) ────────────────────
    # Cofounders set these to True in the production .env AFTER the BAA is
    # countersigned by legal. Default False = fail-safe: PHI never flows to
    # the vendor until the gate is explicitly opened.
    assemblyai_baa_confirmed: bool = False
    anthropic_baa_confirmed: bool = False

    # Observability
    sentry_dsn: str = ""
    environment: str = "development"  # development | staging | production

    # Payments (Stripe Connect Express)
    payments_provider: str = "stripe"
    stripe_secret_key: str = ""  # sk_live_... or sk_test_...
    stripe_webhook_secret: str = ""  # whsec_... from Stripe dashboard
    stripe_platform_name: str = "CompassCHW"

    # Vonage WebSocket JWT auth — signs short-lived tokens embedded in NCCO
    # websocket endpoints so Vonage can authenticate to our audio-ingestion WS.
    # Intentionally NOT validated at startup (backwards compat — existing deploys
    # without this key keep running; the Vonage WS route simply refuses new
    # connections until the key is configured).
    # Generate: python -c "import secrets; print(secrets.token_urlsafe(48))"
    vonage_ws_jwt_secret: str = ""

    class Config:
        env_file = ".env"


settings = Settings()

_DANGEROUS_KEYS = {"", "dev-secret-key-change-in-production", "changeme", "secret"}
if settings.secret_key in _DANGEROUS_KEYS:
    print("FATAL: SECRET_KEY is not set or is a known placeholder. Set it in .env or environment.", file=sys.stderr)
    sys.exit(1)
if len(settings.secret_key) < 32:
    print("FATAL: SECRET_KEY must be at least 32 characters.", file=sys.stderr)
    sys.exit(1)
if not settings.admin_key or len(settings.admin_key) < 16:
    print("FATAL: ADMIN_KEY must be set and at least 16 characters.", file=sys.stderr)
    sys.exit(1)

# ── Production-only startup guards ────────────────────────────────────────────
# These checks run at import time (process start). Any guard that fires in
# production logs a FATAL line so the failure appears in CloudWatch / Sentry
# before sys.exit(1) terminates the worker.

import os as _os  # noqa: E402 — placed here intentionally (config module owns guards)

if settings.environment == "production":
    # Finding #2 — DISABLE_RATE_LIMIT must never be truthy in production.
    _disable_rl = _os.environ.get("DISABLE_RATE_LIMIT", "").lower()
    if _disable_rl in ("1", "true", "yes"):
        print(
            "FATAL: DISABLE_RATE_LIMIT is set to a truthy value in a production "
            "environment. Rate limiting is a critical security control — unset "
            "DISABLE_RATE_LIMIT before starting the server in production.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Finding #1 — Vonage signature secret must be set in production.
    if not settings.vonage_signature_secret:
        print(
            "FATAL: VONAGE_SIGNATURE_SECRET is not configured in production. "
            "Vonage webhook endpoints cannot verify request authenticity without "
            "this secret. Set it in .env before deploying.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Findings #3, #4 — BAA gates must be confirmed before PHI flows to vendors.
    if not settings.assemblyai_baa_confirmed:
        print(
            "FATAL: ASSEMBLYAI_BAA_CONFIRMED is False in production. "
            "Set ASSEMBLYAI_BAA_CONFIRMED=true in .env after the BAA is "
            "countersigned by legal.",
            file=sys.stderr,
        )
        sys.exit(1)

    if not settings.anthropic_baa_confirmed:
        print(
            "FATAL: ANTHROPIC_BAA_CONFIRMED is False in production. "
            "Set ANTHROPIC_BAA_CONFIRMED=true in .env after the BAA is "
            "countersigned by legal.",
            file=sys.stderr,
        )
        sys.exit(1)
