from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://compass:compass_dev_password@localhost:5432/compass"
    secret_key: str = "dev-secret-key-change-in-production"
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7
    algorithm: str = "HS256"

    aws_region: str = "us-west-2"
    s3_bucket_phi: str = "compass-phi-dev"
    s3_bucket_public: str = "compass-public-dev"

    cors_origins: list[str] = ["http://localhost:5173", "https://joincompasschw.com"]

    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_proxy_service_sid: str = ""

    class Config:
        env_file = ".env"


settings = Settings()
