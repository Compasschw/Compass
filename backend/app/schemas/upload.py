from pydantic import BaseModel


class PresignedUrlRequest(BaseModel):
    filename: str
    content_type: str
    purpose: str = "credential"

class PresignedUrlResponse(BaseModel):
    upload_url: str
    s3_key: str
