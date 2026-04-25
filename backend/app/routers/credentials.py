from datetime import UTC
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_role
from app.schemas.credential import (
    CredentialValidationPatch,
    CredentialValidationResponse,
    CredentialValidationSubmit,
    InstitutionResponse,
)

router = APIRouter(prefix="/api/v1/credentials", tags=["credentials"])

@router.post("/validate", response_model=CredentialValidationResponse, status_code=201)
async def submit_validation(data: CredentialValidationSubmit, current_user=Depends(require_role("chw")), db: AsyncSession = Depends(get_db)):
    from app.models.credential import CHWCredentialValidation, InstitutionRegistry
    # Get or create institution
    result = await db.execute(select(InstitutionRegistry).where(InstitutionRegistry.name == data.institution_name))
    institution = result.scalar_one_or_none()
    if not institution:
        institution = InstitutionRegistry(name=data.institution_name, contact_email=data.institution_contact_email)
        db.add(institution)
        await db.flush()
    validation = CHWCredentialValidation(
        chw_id=current_user.id,
        institution_id=institution.id,
        program_name=data.program_name,
        certificate_number=data.certificate_number,
        graduation_date=data.graduation_date,
        document_s3_key=data.document_s3_key,
        expiry_date=data.expiry_date,
    )
    db.add(validation)
    await db.commit()
    await db.refresh(validation)
    return validation

@router.get("/validations", response_model=list[CredentialValidationResponse])
async def list_validations(current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from app.models.credential import CHWCredentialValidation
    if current_user.role == "admin":
        result = await db.execute(select(CHWCredentialValidation).order_by(CHWCredentialValidation.created_at.desc()))
    else:
        result = await db.execute(select(CHWCredentialValidation).where(CHWCredentialValidation.chw_id == current_user.id))
    return result.scalars().all()

@router.patch("/validations/{validation_id}", response_model=CredentialValidationResponse)
async def update_validation(
    validation_id: UUID,
    data: CredentialValidationPatch,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> "CHWCredentialValidation":
    """Allow a CHW to attach a document S3 key or expiry date after initial submission.

    Typical flow: CHW calls POST /validate to create the record, then the
    native client performs a presigned-PUT directly to S3, then the client calls
    this endpoint with the resulting ``document_s3_key``.

    Only the owning CHW can update their own credential record.  Admins must
    use the /review endpoint to change validation_status.
    """
    from app.models.credential import CHWCredentialValidation

    v: CHWCredentialValidation | None = await db.get(CHWCredentialValidation, validation_id)
    if not v:
        raise HTTPException(status_code=404, detail="Validation not found")
    if v.chw_id != current_user.id:
        raise HTTPException(status_code=403, detail="You may only update your own credentials")

    patch_data = data.model_dump(exclude_unset=True)
    for field, value in patch_data.items():
        setattr(v, field, value)

    await db.commit()
    await db.refresh(v)
    return v


@router.patch("/validations/{validation_id}/review", response_model=CredentialValidationResponse)
async def review_validation(
    validation_id: UUID,
    approved: bool,
    notes: str = "",
    current_user=Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
) -> "CHWCredentialValidation":
    """Admin endpoint to approve or reject a CHW credential validation.

    Returns the full updated record so the admin UI can reflect the new
    ``validation_status``, ``document_s3_key``, and ``expiry_date`` in one call.
    """
    from datetime import datetime

    from app.models.credential import CHWCredentialValidation

    v: CHWCredentialValidation | None = await db.get(CHWCredentialValidation, validation_id)
    if not v:
        raise HTTPException(status_code=404, detail="Validation not found")
    v.validation_status = "verified" if approved else "rejected"
    v.validated_by = current_user.id
    v.validated_at = datetime.now(UTC)
    v.notes = notes
    await db.commit()
    await db.refresh(v)
    return v

@router.get("/institutions", response_model=list[InstitutionResponse])
async def search_institutions(q: str = Query(default=""), db: AsyncSession = Depends(get_db)):
    from app.models.credential import InstitutionRegistry
    query = select(InstitutionRegistry)
    if q:
        query = query.where(InstitutionRegistry.name.ilike(f"%{q}%"))
    result = await db.execute(query.limit(20))
    return result.scalars().all()
