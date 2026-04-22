"""CHW professional intake questionnaire responses.

Captures the 27-question "Profile & Intake" questionnaire that every CHW
completes after signup. Used downstream to match CHWs to members and to
report to partner MCPs on the CHW roster's capabilities.

All response fields are nullable so partial progress can be saved between
sections. The authoritative "fully answered" signal is `completed_at`.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class CHWIntakeResponse(Base):
    """A CHW's answers to the 27-question professional intake questionnaire."""

    __tablename__ = "chw_intake_responses"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), unique=True, nullable=False, index=True
    )

    # ─── Section 1 — About You (Q1-4) ─────────────────────────────────────
    years_experience: Mapped[str | None] = mapped_column(String(30))
    employment_status: Mapped[str | None] = mapped_column(String(30))
    education_level: Mapped[str | None] = mapped_column(String(30))
    primary_setting: Mapped[str | None] = mapped_column(String(30))

    # ─── Section 2 — Credentials (Q5-9) ───────────────────────────────────
    ca_chw_certificate: Mapped[str | None] = mapped_column(String(30))
    training_pathway: Mapped[str | None] = mapped_column(String(30))
    additional_certification: Mapped[str | None] = mapped_column(String(30))
    medi_cal_familiarity: Mapped[str | None] = mapped_column(String(30))
    ehr_experience: Mapped[str | None] = mapped_column(String(30))

    # ─── Section 3 — Languages & Cultural Competency (Q10-14) ─────────────
    primary_language: Mapped[str | None] = mapped_column(String(30))
    other_language_fluency: Mapped[str | None] = mapped_column(String(30))
    additional_language: Mapped[str | None] = mapped_column(String(30))
    cultural_competency_training: Mapped[str | None] = mapped_column(String(30))
    lived_experience: Mapped[str | None] = mapped_column(String(30))

    # ─── Section 4 — Expertise & Specialization (Q15-19) ──────────────────
    primary_specialization: Mapped[str | None] = mapped_column(String(40))
    sdoh_experience: Mapped[str | None] = mapped_column(String(30))
    population_experience: Mapped[str | None] = mapped_column(String(40))
    motivational_interviewing: Mapped[str | None] = mapped_column(String(30))
    hedis_experience: Mapped[str | None] = mapped_column(String(30))

    # ─── Section 5 — Work Setting & Modality (Q20-24) ─────────────────────
    preferred_modality: Mapped[str | None] = mapped_column(String(30))
    home_visit_comfort: Mapped[str | None] = mapped_column(String(30))
    telehealth_comfort: Mapped[str | None] = mapped_column(String(30))
    transportation: Mapped[str | None] = mapped_column(String(30))
    preferred_caseload: Mapped[str | None] = mapped_column(String(30))

    # ─── Section 6 — Schedule & Availability (Q25-27) ─────────────────────
    preferred_schedule: Mapped[str | None] = mapped_column(String(30))
    preferred_employment_type: Mapped[str | None] = mapped_column(String(30))
    urgent_outreach: Mapped[str | None] = mapped_column(String(30))

    # ─── Free-text "Other" overrides (Q10, Q12) ────────────────────────────
    primary_language_other: Mapped[str | None] = mapped_column(String(100))
    additional_language_other: Mapped[str | None] = mapped_column(String(100))

    # ─── Progress + metadata ──────────────────────────────────────────────
    # 0-6; the highest section the CHW has completed so they can resume.
    last_completed_section: Mapped[int] = mapped_column(Integer, default=0)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
