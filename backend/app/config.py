import sys

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    secret_key: str
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7

    aws_region: str = "us-west-2"
    s3_bucket_phi: str = "compass-phi-dev"
    s3_bucket_public: str = "compass-public-dev"

    cors_origins: list[str] = ["http://localhost:5173", "https://joincompasschw.com"]

    # Communication provider (vonage, twilio, plivo)
    communication_provider: str = "vonage"

    # Vonage (recommended for MVP)
    vonage_api_key: str = ""
    vonage_api_secret: str = ""
    vonage_application_id: str = ""
    vonage_private_key_path: str = ""

    # Twilio (future option)
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_proxy_service_sid: str = ""

    # Billing provider (pear_suite, direct_837)
    billing_provider: str = "pear_suite"

    # Pear Suite billing integration
    pear_suite_api_key: str = ""
    pear_suite_base_url: str = "https://api.pearsuite.com"

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

    # Observability
    sentry_dsn: str = ""
    environment: str = "development"  # development | staging | production

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
