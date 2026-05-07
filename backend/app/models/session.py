import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    ARRAY,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    false,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Session(Base):
    __tablename__ = "sessions"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("service_requests.id"), nullable=False)
    chw_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    vertical: Mapped[str] = mapped_column(String(50), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="scheduled", index=True)
    mode: Mapped[str] = mapped_column(String(20), nullable=False)
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    duration_minutes: Mapped[int | None] = mapped_column(Integer)
    suggested_units: Mapped[int | None] = mapped_column(Integer)
    units_billed: Mapped[int | None] = mapped_column(Integer)
    notes: Mapped[str | None] = mapped_column(Text)
    gross_amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    net_amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    # Set when the member affirmatively consents to call recording —
    # DTMF "1" on the IVR for phone calls, explicit consent button for chat.
    # The full audit record (signature method, IP, UA) lives in the
    # member_consents table; this column is denormalized for fast joinless
    # lookups during billing claim creation. NULL means recording was never
    # consented (and therefore must not have happened).
    recording_consent_given_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

class SessionDocumentation(Base):
    __tablename__ = "session_documentation"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sessions.id"), unique=True, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    resources_referred: Mapped[list | None] = mapped_column(ARRAY(String))
    member_goals: Mapped[list | None] = mapped_column(ARRAY(String))
    follow_up_needed: Mapped[bool] = mapped_column(Boolean, default=False)
    follow_up_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    diagnosis_codes: Mapped[list | None] = mapped_column(ARRAY(String))
    procedure_code: Mapped[str | None] = mapped_column(String(10))
    units_to_bill: Mapped[int | None] = mapped_column(Integer)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Stamped when the LLM extraction pass completes for this session.
    # NULL means extraction has not run yet — used as the primary idempotency
    # gate in app.services.followup_extraction.extract_session_followups.
    followups_extracted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # AI-generated summary fields (distinct from the CHW-authored `summary` above).
    # Investors and HIPAA auditors must be able to tell the two apart at a glance.
    # ai_summary: the raw LLM output — never edited by the CHW.
    # ai_summary_generated_at: UTC timestamp of the generation call.
    # ai_summary_excluded: CHW can flag the AI draft as inappropriate/inapplicable.
    ai_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_summary_generated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    ai_summary_excluded: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=false()
    )

class MemberConsent(Base):
    __tablename__ = "member_consents"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sessions.id"), nullable=False)
    member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    consent_type: Mapped[str] = mapped_column(String(50), nullable=False)
    typed_signature: Mapped[str] = mapped_column(String(255), nullable=False)
    consented_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ip_address: Mapped[str | None] = mapped_column(String(45))
    user_agent: Mapped[str | None] = mapped_column(Text)


class ConsentRequest(Base):
    """In-app two-party consent request for session recording.

    HIPAA + California Penal Code §632 compliance
    ---------------------------------------------------
    Two-party consent for audio recording is required under California §632.
    This model represents the CHW's request for the member to explicitly approve
    session recording within the app, creating an immutable audit trail of:
      - who requested consent (chw_id), and when (requested_at)
      - who responded (member_id), and when (responded_at)
      - the final decision (status)
      - expiry guard: requests auto-expire after 5 minutes to prevent stale
        pending rows from bypassing future consent decisions

    Statuses
    --------
    pending   → created by CHW; member has not responded yet
    approved  → member tapped Approve; a MemberConsent row was created
    denied    → member tapped Deny; no MemberConsent row exists
    cancelled → CHW cancelled before the member responded
    expired   → responded_at is NULL and expires_at < now() (checked at read time)

    The MemberConsent row created on approval carries member_id = the member's
    own user ID and no chw_attestation flag — this is a genuine member-tap
    consent, not a CHW surrogate, satisfying both HIPAA "individual authorization"
    and California §632 two-party consent requirements.
    """

    __tablename__ = "consent_requests"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    chw_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    # "ai_transcription" for session recording consent; extensible for future types.
    consent_type: Mapped[str] = mapped_column(String(50), nullable=False)
    # pending | approved | denied | cancelled | expired
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending", index=True
    )
    requested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Stamped when the member approves or denies, or the CHW cancels.
    responded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Default: 5 minutes from creation. Checked at read time; no background job needed.
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    __table_args__ = (
        # Fast look-up: "all pending consent requests for this session"
        Index("ix_consent_requests_session_status", "session_id", "status"),
    )

    def is_expired(self, now: datetime) -> bool:
        """Return True when this request has not been responded to and its TTL has elapsed."""
        return self.status == "pending" and now >= self.expires_at


class SessionTranscript(Base):
    """Persisted final transcript chunks for a session.

    Only ``is_final=True`` chunks are written here — partials are high-volume
    and noisy. The table is the authoritative audit trail for AI-transcribed
    sessions and supports post-session replay and follow-up extraction.

    HIPAA: ``text`` is PHI. Access must be logged at the API layer. Never
    include ``text`` in structured logs.
    """

    __tablename__ = "session_transcripts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=False,  # covered by composite index below
    )
    # "A" or "B" — the diarisation label returned by the transcription provider.
    speaker_label: Mapped[str | None] = mapped_column(String(10))
    # chw | member | unknown — resolved from CHW audio-source attribution.
    speaker_role: Mapped[str | None] = mapped_column(String(20))
    # Nullable FK: only set when the role is positively resolved to a user.
    speaker_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    # PHI — do not log.
    text: Mapped[str] = mapped_column(Text, nullable=False)
    is_final: Mapped[bool] = mapped_column(Boolean, nullable=False)
    confidence: Mapped[float | None] = mapped_column(Float)
    # Millisecond offsets from session start (provider-supplied timing).
    started_at_ms: Mapped[int | None] = mapped_column(BigInteger)
    ended_at_ms: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
