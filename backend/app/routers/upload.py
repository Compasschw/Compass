from fastapi import APIRouter, Depends

from app.config import settings
from app.dependencies import get_current_user
from app.schemas.upload import PresignedUrlRequest, PresignedUrlResponse
from app.services.s3_service import build_phi_key, build_public_key, generate_presigned_upload_url

router = APIRouter(prefix="/api/v1/upload", tags=["upload"])

@router.post("/presigned-url", response_model=PresignedUrlResponse)
async def get_presigned_url(data: PresignedUrlRequest, current_user=Depends(get_current_user)):
    if data.purpose in ("credential", "recording", "document"):
        key = build_phi_key(str(current_user.id), data.purpose, data.filename)
        bucket = settings.s3_bucket_phi
    else:
        key = build_public_key(str(current_user.id), data.filename)
        bucket = settings.s3_bucket_public
    url = generate_presigned_upload_url(bucket, key, data.content_type)
    return PresignedUrlResponse(upload_url=url, s3_key=key)
