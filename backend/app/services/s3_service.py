import boto3
from botocore.exceptions import ClientError
from app.config import settings

_client = None

def get_s3_client():
    global _client
    if _client is None:
        _client = boto3.client("s3", region_name=settings.aws_region)
    return _client

def generate_presigned_upload_url(bucket: str, key: str, content_type: str, expires_in: int = 300) -> str:
    client = get_s3_client()
    return client.generate_presigned_url(
        "put_object",
        Params={"Bucket": bucket, "Key": key, "ContentType": content_type},
        ExpiresIn=expires_in,
    )

def generate_presigned_download_url(bucket: str, key: str, expires_in: int = 3600) -> str:
    client = get_s3_client()
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=expires_in,
    )

def build_phi_key(user_id: str, category: str, filename: str) -> str:
    return f"users/{user_id}/{category}/{filename}"

def build_public_key(user_id: str, filename: str) -> str:
    return f"profiles/{user_id}/{filename}"
