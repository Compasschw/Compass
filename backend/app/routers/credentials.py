from datetime import UTC
from typing import TYPE_CHECKING
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user, require_role
from app.schemas.credential import (
    ChecklistItemResponse,
    ChecklistResponse,
    CredentialDownloadUrlResponse,
    CredentialResponse,
    CredentialReviewRequest,
    CredentialSubmit,
    CredentialValidationPatch,
    CredentialValidationResponse,
    CredentialValidationSubmit,
    InstitutionResponse,
)
from app.services.audit import record_phi_read
from app.services.chw_compliance import get_compliance_status
from app.services.s3_service import generate_presigned_download_url

if TYPE_CHECKING:
    from app.models.credential import CHWCredentialValidation, Credential

router = APIRouter(prefix="/api/v1/credentials", tags=["credentials"])

# ── D1: compliance-checklist document types ──────────────────────────────────
#
# Real external link / asset URLs (Wave-2 B1, QA batch #4). Single named
# constants so ops can swap the URL in one place if it ever changes — never
# inline these strings elsewhere. Mirrored on the frontend in
# CHWProfileScreen.tsx — keep both in sync if either changes.
HIPAA_TRAINING_LINK = "https://hipaatraining.us/"
LIABILITY_INSURANCE_LINK = "https://www.hpso.com/Get-a-Quote/"
CHW_ATTESTATION_FORM_LINK = "https://joincompasschw.com/documents/chw-attestation-form.pdf"

# type -> (label, guidance copy, optional link). Order matches
# app.services.chw_compliance.DOCUMENT_CREDENTIAL_TYPES.
_CREDENTIAL_TYPE_META: dict[str, dict[str, str | None]] = {
    "hipaa_training": {
        "label": "HIPAA Training",
        "copy": "Upload your HIPAA training certificate, or complete a free HIPAA training first.",
        "link": HIPAA_TRAINING_LINK,
    },
    "professional_service_agreement": {
        "label": "Professional Service Agreement",
        "copy": "Please sign the Professional Service Agreement and upload.",
        "link": None,
    },
    "liability_insurance": {
        "label": "Professional Liability Insurance",
        "copy": "Upload your professional liability insurance, or purchase a policy first.",
        "link": LIABILITY_INSURANCE_LINK,
    },
    "chw_certification": {
        "label": "CHW Certification",
        "copy": (
            "Upload your CHW certificate, or download the Attestation Form "
            "and fill it out before uploading it."
        ),
        "link": CHW_ATTESTATION_FORM_LINK,
    },
}

_DOCUMENT_CREDENTIAL_TYPES = tuple(_CREDENTIAL_TYPE_META.keys())

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


# ─── D1: compliance checklist (Credential table) ────────────────────────────
#
# NOTE ON ROUTE ORDERING: /checklist is a static path and is registered
# BEFORE the /{credential_type} and /{credential_id}/review path-param
# routes below, so FastAPI never tries to match "checklist" against those
# param patterns. Keep any future static sibling routes above the param
# routes for the same reason.


@router.get("/checklist", response_model=ChecklistResponse)
async def get_checklist(
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> ChecklistResponse:
    """Return the authenticated CHW's full 5-item compliance checklist.

    One round trip covering all 5 requirement codes (4 document credential
    types + background_check) plus the overall can_work/missing gate status,
    so the CHW Profile screen and Dashboard banner can both render from a
    single fetch. Backed by app.services.chw_compliance.get_compliance_status
    — the same evaluation used by the work-gate enforcement, so the
    checklist the CHW sees can never drift from what actually blocks them.

    ``gate_enabled`` mirrors app.config.settings.chw_work_gate_enabled
    (Epic D3) so the frontend knows whether can_work=False is merely
    informational (flag off) or actually blocks feature access right now
    (flag on) — without a second round trip.
    """
    from app.config import settings

    status_result = await get_compliance_status(db, current_user)
    items = [
        ChecklistItemResponse(code=code, status=status_result.credentials[code])
        for code in status_result.credentials
    ] + [
        ChecklistItemResponse(
            code="background_check", status=status_result.background_check_status
        )
    ]
    return ChecklistResponse(
        can_work=status_result.can_work,
        missing=status_result.missing,
        items=items,
        gate_enabled=settings.chw_work_gate_enabled,
    )


@router.post("/{credential_type}", response_model=CredentialResponse, status_code=201)
async def submit_credential(
    credential_type: str,
    data: CredentialSubmit,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> "Credential":
    """Upsert the authenticated CHW's document for one of the 4 checklist types.

    Upsert semantics on (chw_id, type): a re-upload after rejection UPDATEs
    the existing row's s3_key and resets status to "pending" — it does not
    create a duplicate row (enforced additionally by a DB unique constraint
    as a defense-in-depth backstop against a race between two concurrent
    submits).  CHWs cannot set status directly — this endpoint always writes
    status="pending" and clears verified_by/verified_at, regardless of what
    the previous state was.  background_check_status is NOT settable via
    this endpoint or any CHW-facing endpoint — see PATCH
    /admin/chws/{id}/background-check (admin-only).
    """
    from app.models.credential import Credential

    if credential_type not in _DOCUMENT_CREDENTIAL_TYPES:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown credential type '{credential_type}'. "
            f"Must be one of: {sorted(_DOCUMENT_CREDENTIAL_TYPES)}",
        )

    result = await db.execute(
        select(Credential).where(
            Credential.chw_id == current_user.id,
            Credential.type == credential_type,
        )
    )
    existing = result.scalar_one_or_none()

    file_name = data.s3_key.rsplit("/", 1)[-1]
    meta = _CREDENTIAL_TYPE_META[credential_type]

    if existing is not None:
        existing.s3_key = data.s3_key
        existing.file_name = file_name
        existing.status = "pending"
        existing.verified_by = None
        existing.verified_at = None
        row = existing
    else:
        row = Credential(
            chw_id=current_user.id,
            type=credential_type,
            label=str(meta["label"]),
            s3_key=data.s3_key,
            file_name=file_name,
            status="pending",
        )
        db.add(row)

    await db.commit()
    await db.refresh(row)
    return row


@router.get("/mine", response_model=list[CredentialResponse])
async def list_my_credentials(
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> list["Credential"]:
    """List the authenticated CHW's own Credential rows (the 4 document types).

    Only rows that have actually been submitted are returned — a type the
    CHW has never uploaded has no row here; use GET /checklist for a
    complete view including "missing" items with no row yet.
    """
    from app.models.credential import Credential

    result = await db.execute(
        select(Credential)
        .where(Credential.chw_id == current_user.id)
        .order_by(Credential.created_at.desc())
    )
    return list(result.scalars().all())


# ─── GET /{credential_id}/download-url ──────────────────────────────────────

CREDENTIAL_DOWNLOAD_URL_EXPIRY_SECONDS = 900  # 15 minutes, matches member_documents.py


@router.get(
    "/{credential_id}/download-url",
    response_model=CredentialDownloadUrlResponse,
    summary="Get a short-lived presigned GET URL for a CHW compliance-checklist document",
)
async def get_credential_download_url(
    credential_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CredentialDownloadUrlResponse:
    """Return a 15-minute presigned S3 GET URL for a Credential row's s3_key.

    QA batch #7 (2026-07-14): admins previously approved these documents
    "sight-unseen" — no download/view endpoint existed at all for
    Credential.s3_key. This closes that review-blind-spot while keeping the
    same ownership boundary as GET /documents/{doc_id}/download-url.

    Authz: the owning CHW, or an admin. Any other caller (a different CHW,
    a member) receives 403 — enforced explicitly here since Credential rows
    have no relationship-gate helper of their own (unlike MemberDocument,
    which uses _assert_member_access).
    """
    from app.models.credential import Credential

    row: Credential | None = await db.get(Credential, credential_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Credential not found")

    if current_user.role != "admin" and row.chw_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="You may only download your own compliance documents.",
        )

    if not row.s3_key:
        raise HTTPException(
            status_code=404,
            detail="No document has been uploaded for this credential yet.",
        )

    try:
        presigned_url = generate_presigned_download_url(
            bucket=settings.s3_bucket_phi,
            key=row.s3_key,
            expires_in=CREDENTIAL_DOWNLOAD_URL_EXPIRY_SECONDS,
        )
    except Exception as exc:  # noqa: BLE001 — never leak a bare 500 (TESTING.md #3)
        raise HTTPException(
            status_code=500,
            detail=f"Could not generate a download link: {type(exc).__name__}: {exc}",
        ) from exc

    await record_phi_read(
        actor_user_id=current_user.id,
        resource="credential",
        resource_id=str(credential_id),
        details={"actor_role": current_user.role, "chw_id": str(row.chw_id)},
    )

    return CredentialDownloadUrlResponse(
        download_url=presigned_url,
        expires_in_seconds=CREDENTIAL_DOWNLOAD_URL_EXPIRY_SECONDS,
    )


@router.patch("/{credential_id}/review", response_model=CredentialResponse)
async def review_credential(
    credential_id: UUID,
    data: CredentialReviewRequest,
    current_user=Depends(require_role("admin")),
    db: AsyncSession = Depends(get_db),
) -> "Credential":
    """Admin-only: approve or reject a submitted checklist document.

    Mirrors PATCH /validations/{id}/review's semantics for the
    CHWCredentialValidation table, applied here to the Credential table.
    Sets status to "verified"/"rejected" and stamps verified_by/verified_at.
    A CHW (even the owning CHW) must receive 403 — enforced by
    require_role("admin") above, matching the identical negative-auth
    guarantee already tested for /validations/{id}/review.

    Epic D3: on a can_work false -> true transition (i.e. approving the
    LAST outstanding requirement flips the CHW to fully compliant), fires a
    best-effort "you're approved" email + push. Captured BEFORE the mutation
    so approving a middle credential — with other requirements still
    outstanding — never fires it, and re-approving an already-verified
    credential never re-fires it (can_work was already True beforehand).
    """
    from app.models.credential import Credential
    from app.models.user import User
    from app.services.chw_compliance import chw_can_work, notify_chw_if_newly_approved

    row: Credential | None = await db.get(Credential, credential_id)
    if not row:
        raise HTTPException(status_code=404, detail="Credential not found")

    chw_user = await db.get(User, row.chw_id)
    if chw_user is None:
        raise HTTPException(status_code=404, detail="CHW not found")

    was_compliant_before, _ = await chw_can_work(db, chw_user)

    from datetime import datetime

    row.status = "verified" if data.approved else "rejected"
    row.verified_by = current_user.id
    row.verified_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(row)

    await notify_chw_if_newly_approved(db, chw_user, was_compliant_before=was_compliant_before)

    return row
