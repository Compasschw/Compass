import uuid
from datetime import date, datetime

from sqlalchemy import (
    ARRAY,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    event,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.encryption import EncryptedString
from app.utils.phone import PLACEHOLDER_PHONE_E164


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        # QA-batch #1 — CHW phone uniqueness, applied platform-wide (any role
        # supplying a phone). Partial index (NULL phones excluded) so the
        # optional-phone-at-signup contract is preserved: any number of
        # accounts may still have no phone on file. Mirrors migration
        # ``chwphone0713`` — kept in sync here so ``Base.metadata.create_all``
        # (used by the test suite's per-test schema setup, which does NOT run
        # Alembic migrations) also creates this constraint, and so a fresh
        # `alembic upgrade head` on a NEW database is consistent with what
        # `create_all` would produce. This is the race-safe backstop; the
        # primary UX is the pre-create check in
        # ``app.services.auth_service.register_user`` (returns a clean 409
        # instead of surfacing this constraint's IntegrityError to the
        # caller).
        #
        # QA feedback batch (2026-07-14), Part 3: the WHERE clause also
        # excludes the 555-555-5555 placeholder sentinel — CHWs use it when a
        # member has no phone of their own, and any number of accounts may
        # now share that one specific value. Every OTHER non-null phone
        # remains globally unique. Mirrors migration ``phoneidx0715``.
        Index(
            "uq_users_phone_not_null",
            "phone",
            unique=True,
            postgresql_where=text(
                f"phone IS NOT NULL AND phone != '{PLACEHOLDER_PHONE_E164}'"
            ),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(20))
    # Non-null once the user completes an SMS OTP challenge for this number.
    # Reset to NULL if the user starts a new phone-change flow (before
    # confirmation) so the old verified number stays valid during the window.
    phone_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    profile_picture_url: Mapped[str | None] = mapped_column(String(500))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_onboarded: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    # Last authenticated activity — bumped (throttled) in get_current_user. Drives
    # presence in the UI (e.g. a member's "Active" pill when active < 10 min ago).
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Timestamp of the user's FIRST successful authentication (self-service
    # /auth/register auto-login, /auth/login, or OAuth sign-in) — NULL until then.
    # Distinct from `last_active_at` (which tracks ongoing presence): this is a
    # one-time "has this person ever actually signed in" signal. Introduced for
    # the CHW Members-page status rule (a CHW-created member — who only holds a
    # temp password handed to them out-of-band — must be shown 'inactive' until
    # they actually sign in themselves, not merely because the CHW provisioned
    # the account). See routers/auth.py (register/login/oauth) for write sites
    # and routers/chw.py list_chw_members for the read site.
    first_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Distinct from `first_login_at` above — that column records *whether* the
    # user has ever authenticated; this one records whether they are still
    # sitting on a password they didn't choose themselves and must replace
    # before continuing (Epic G2). True only for members a CHW provisions via
    # `POST /chw/members` (``create_chw_member`` in routers/chw.py), where the
    # CHW hands the member a temp password out-of-band. False for every
    # self-service path — ``auth_service.register_user``'s self-signup branch,
    # OAuth sign-up (`routers/auth.py::_handle_oauth_signin`), and magic-link —
    # because in those flows the account holder chose (or has no) password
    # themselves, so there is nothing to force a change on.
    #
    # Cleared (set False) by ``POST /auth/change-password`` once the member
    # successfully sets their own password. Surfaced to the frontend on
    # ``TokenResponse`` (login/register/refresh/magic-verify) and
    # ``MemberProfileResponse`` (GET /member/profile) so the client knows to
    # show the mandatory first-login "set your password" prompt.
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    # ── Account-deletion fields (soft-delete + HIPAA 6-year retention) ──────────
    # Populated by AccountDeletionService. A non-null deleted_at means the account
    # has been soft-deleted and all PII anonymised. The row is intentionally kept
    # so that ServiceRequest / Session / BillingClaim / AuditLog foreign-key
    # references remain valid for the HIPAA 6-year retention window.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    # Computed at deletion: deleted_at + 6 years. After this date a future scheduled
    # job may hard-delete the row.
    #
    # TODO(hard-delete-scheduler): implement a nightly APScheduler job that queries
    #   SELECT id FROM users
    #   WHERE deleted_at IS NOT NULL
    #     AND data_retention_until <= CURRENT_DATE;
    # and for each row:
    #   1. Assert no open BillingClaim rows remain (status != 'paid').
    #   2. DELETE FROM <profile_table> WHERE user_id = id  (CHWProfile / MemberProfile)
    #   3. DELETE FROM users WHERE id = id
    #   4. Write a final AuditLog row: action='hard_delete', resource='account_purge'
    # Link issue: compass#XXX
    data_retention_until: Mapped[date | None] = mapped_column(Date, nullable=True)

class CHWProfile(Base):
    __tablename__ = "chw_profiles"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), unique=True, nullable=False)
    specializations: Mapped[list] = mapped_column(ARRAY(String), default=list)
    languages: Mapped[list] = mapped_column(ARRAY(String), default=list)
    bio: Mapped[str | None] = mapped_column(Text)
    zip_code: Mapped[str | None] = mapped_column(String(10), index=True)
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    years_experience: Mapped[int] = mapped_column(Integer, default=0)
    total_sessions: Mapped[int] = mapped_column(Integer, default=0)
    rating: Mapped[float] = mapped_column(Float, default=0.0)
    rating_count: Mapped[int] = mapped_column(Integer, default=0)
    is_available: Mapped[bool] = mapped_column(Boolean, default=True)
    availability_windows: Mapped[dict | None] = mapped_column(JSONB)

    # Stripe Connect Express account for receiving payouts. Null until the CHW
    # completes the onboarding flow. The status fields are cached from the
    # account.updated webhook to avoid round-tripping to Stripe on every request.
    stripe_connected_account_id: Mapped[str | None] = mapped_column(String(100))
    stripe_payouts_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    stripe_details_submitted: Mapped[bool] = mapped_column(Boolean, default=False)

    # Pear Suite user ID provisioned via their dashboard (no Create User API).
    # Must be set manually by Jemal before demo claims can be submitted.
    # Indexed for fast lookup during claim orchestration.
    pear_suite_user_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)

    # National Provider Identifier (10-digit CMS-issued ID for billing). Not
    # in Pear's bulk-upload CSV template today, but required for Medi-Cal
    # billing audit + future Pear API submissions. Nullable until the CHW
    # provides it during onboarding / admin sets it via the admin endpoint.
    npi: Mapped[str | None] = mapped_column(String(10), nullable=True)
    # ── Compliance (HIPAA training, certification, background check) ─────────
    hipaa_training_completed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )
    chw_certification: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # "not_started" | "pending" | "clear" | "consider"
    background_check_status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default="not_started"
    )

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

class MemberProfile(Base):
    __tablename__ = "member_profiles"
    __table_args__ = (
        # QA feedback batch (2026-07-14), Part 4 — CIN (Medi-Cal ID)
        # uniqueness across members. ``medi_cal_id`` is encrypted at rest
        # with a random nonce per row (EncryptedString/AES-256-GCM), so
        # identical plaintext CINs produce different ciphertext and can
        # never be compared or indexed directly. ``medi_cal_id_hash`` is a
        # deterministic HMAC-SHA256 digest of the normalized CIN (see
        # ``app.utils.encryption.hash_cin``), kept in lockstep with
        # ``medi_cal_id`` by the ``set`` event listener registered below.
        # Partial index (NULL hashes excluded) so members with no CIN on
        # file are unaffected. Mirrors migration ``cinhash0715`` — kept in
        # sync here for the same ``create_all``/fresh-DB reasons documented
        # on ``User.__table_args__`` above. Race-safe backstop; the primary
        # UX is the pre-create/pre-edit check in
        # ``app.services.auth_service.check_cin_uniqueness`` (returns a
        # clean 409 instead of surfacing this constraint's IntegrityError).
        Index(
            "uq_member_profiles_cin_hash",
            "medi_cal_id_hash",
            unique=True,
            postgresql_where=text("medi_cal_id_hash IS NOT NULL"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), unique=True, nullable=False)
    zip_code: Mapped[str | None] = mapped_column(String(10), index=True)
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    primary_language: Mapped[str] = mapped_column(String(50), default="English")
    primary_need: Mapped[str | None] = mapped_column(String(50))
    additional_needs: Mapped[list | None] = mapped_column(ARRAY(String))
    # CHW-assigned priority levels per resource need slug.
    # Values ∈ {"low","medium","high"}.  Default {} (no levels set).
    # Full replacement on every PATCH — no in-place mutation — so standard
    # JSONB without MutableDict tracking is sufficient (matches the pattern
    # used by CHWProfile.availability_windows in this file).
    resource_need_levels: Mapped[dict] = mapped_column(
        JSONB, nullable=False, server_default=text("'{}'")
    )
    insurance_provider: Mapped[str | None] = mapped_column(String(255))
    # Encrypted at rest (AES-256-GCM). PHI per HIPAA 45 CFR §164.312(a)(2)(iv).
    medi_cal_id: Mapped[str | None] = mapped_column(EncryptedString)
    # Deterministic HMAC-SHA256 digest of the normalized CIN — see the
    # uniqueness index in __table_args__ above and app.utils.encryption.
    # hash_cin. Kept in lockstep automatically by the ``set`` event listener
    # registered at the bottom of this module — never assign this column
    # directly; set ``medi_cal_id`` and the hash recomputes itself.
    medi_cal_id_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # ── Expanded signup fields (member RegisterScreen) ───────────────────
    # Captured at signup OR later via profile-edit; all nullable so a
    # half-complete profile doesn't block account creation.  Only DOB +
    # gender are required for the curated Pear Suite member-create payload
    # (see app.services.pear_suite_member_sync._build_member_payload).
    date_of_birth: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Maps to Pear Suite's ``sex`` enum: "Male" | "Female" | "Other".
    gender: Mapped[str | None] = mapped_column(String(32), nullable=True)
    address_line1: Mapped[str | None] = mapped_column(String(160), nullable=True)
    address_line2: Mapped[str | None] = mapped_column(String(160), nullable=True)
    city: Mapped[str | None] = mapped_column(String(80), nullable=True)
    state: Mapped[str | None] = mapped_column(String(2), nullable=True)
    # Curated 6-carrier dropdown value from the signup form.  Used by
    # pear_cost_ids.resolve_cost_id to pick the per-carrier costId at claim
    # submission.  Keeps ``insurance_provider`` (free-text legacy column)
    # untouched so older intake data still works.
    insurance_company: Mapped[str | None] = mapped_column(String(80), nullable=True)

    # Pear Suite member ID returned by POST /api/beta/members. Null until the
    # member has been synced. Indexed for fast existence check in ensure_member_synced.
    pear_suite_member_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)

    # Pear bulk-upload Member-Import CSV idempotency stamp. Set to NOW()
    # by auth/register (and the backfill script) after a successful row
    # is written to s3_bucket_member_csv. The writer has no in-CSV marker
    # column (Pear's Member template is 12 cols, no Notes), so retries
    # must be gated on this column or they produce duplicate rows.
    # NULL = "never exported"; non-NULL = "exported at this UTC moment".
    member_csv_exported_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # ── Services Consent (T03) ───────────────────────────────────────────────
    # Member-controlled toggle that gates ALL CHW↔member communication on the
    # platform. Two values:
    #   "consent_to_services"  — default; communication enabled
    #   "refuse_services"      — member opt-out; call-bridge, messages, and
    #                            new session acceptance all return 403
    #
    # When a member flips to "refuse_services" after a confirm modal:
    #   - ALL CHWs cannot call them (call-bridge 403)
    #   - ALL CHWs cannot message them (message-send 403)
    #   - No new sessions can be accepted for this member
    #   - Existing in-flight sessions complete normally (not killed)
    #   - Reverting to "consent_to_services" re-enables everything immediately
    #
    # changed_at + changed_by provide an audit trail — required for
    # compliance (consent record must be timestamped and attributed).
    services_consent: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="consent_to_services"
    )
    services_consent_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    services_consent_changed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    # ── Billing eligibility (billable / non-billable) ────────────────────────
    # CHW-controlled toggle on the Member Profile. Default true (billable).
    # When false, the member is marked non-billable: their completed sessions
    # should be excluded from Pear Suite billing submission. changed_at +
    # changed_by give the compliance audit trail (who flipped it, when),
    # mirroring the services_consent pattern above.
    is_billable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="true"
    )
    billing_status_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    billing_status_changed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    # ── Member closure (CHW closes out the member's case) ────────────────────
    # A CHW can close a member from the Member Profile. Closure records a
    # disposition (closure_status) + reason and disables active engagement
    # (Begin Session / Message) while keeping the record intact. NULL status
    # means the member is open/active. Reversible: reopening sets all four
    # fields back to NULL. closed_at + closed_by give the audit trail, mirroring
    # the services_consent / billing_status patterns above.
    #
    # closure_status ∈ {closed_successful, closed_unsuccessful, declined}.
    # closure_reason ∈ the 12 canonical reason slugs (see CloseMemberRequest).
    closure_status: Mapped[str | None] = mapped_column(String(30), nullable=True)
    closure_reason: Mapped[str | None] = mapped_column(String(40), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    closed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    # Member's chosen/preferred name (what they go by), distinct from the legal
    # name stored on User.name. Nullable — falls back to first name in the UI.
    preferred_name: Mapped[str | None] = mapped_column(String(100), nullable=True)

    rewards_balance: Mapped[int] = mapped_column(Integer, default=0)
    preferred_mode: Mapped[str | None] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # ── Masked SMS messaging (CHW↔member over the shared Vonage number) ──────
    # Per-member "sticky" routing pointer: the Conversation an inbound SMS
    # reply from this member should land in. Written every time ANY CHW sends
    # an outbound SMS to this member from a conversation (last-writer-wins —
    # a member only ever has one "currently texting" thread at a time even if
    # they have multiple CHWs). A stored column (rather than deriving "most
    # recent outbound SMS Message" via a query) was chosen because: (1) the
    # inbound webhook is latency- and correctness-sensitive — a single
    # indexed FK lookup beats a MAX(created_at) scan per inbound SMS: (2) it
    # gives an explicit, debuggable value ops can inspect directly instead of
    # re-deriving routing history. ON DELETE SET NULL: a deleted conversation
    # just falls back to "most recent conversation" routing — never blocks
    # inbound messaging.
    last_sms_conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="SET NULL"),
        nullable=True,
    )
    # STOP/UNSUBSCRIBE opt-out flag (CTIA short-code compliance). Set to True
    # by the inbound SMS webhook when the member texts a recognized opt-out
    # keyword (see app.routers.communication._STOP_KEYWORDS). Once True,
    # POST /conversations/{id}/sms is blocked for this member (422) until a
    # human/ops process resets it — there is no self-service re-subscribe
    # flow in this PR; CTIA guidance requires an explicit new opt-in, not an
    # automatic one, so that's deliberately out of scope here.
    sms_opt_out: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")

    # ── Signup consent (A2P 10DLC documented opt-in + HIPAA audit) ───────────
    # Timestamped consent captured at member creation on BOTH signup surfaces
    # (self-service /auth/register and CHW-initiated /chw/members). Two distinct
    # agreements, recorded separately so each has its own audit timestamp:
    #   - terms_accepted_at: member agreed to the Terms of Service + Privacy Policy.
    #   - communications_consent_at: member consented to calls/SMS from Compass and
    #     their CHW, and to Compass billing their insurance for covered services.
    # Both are NULL for legacy members created before this gate shipped — nullable
    # so the migration never has to backfill and existing rows are unaffected.
    # Only NEW signups are required (enforced at the request-schema boundary) to
    # supply both consents; the endpoints stamp these columns = NOW(UTC) on success.
    terms_accepted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    communications_consent_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # ── Social sign-in onboarding gate ──────────────────────────────────────────
    # True for all normal (password/magic-link) signups — those users supply
    # every Pear-required field at registration.
    # Set to False for OAuth-created members who bypassed the Pear-required
    # signup form. POST /auth/complete-member-onboarding flips it to True once
    # DOB/sex/insurance/CIN/ZIP are supplied.
    # Exposed as ``needs_onboarding`` in the OAuth response and on the
    # /member/profile endpoint so the FE can gate route navigation.
    onboarding_complete: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="true"
    )


# ── CIN uniqueness digest: keep medi_cal_id_hash in lockstep automatically ────
#
# QA feedback batch (2026-07-14), Part 4. Rather than touching every one of
# the (currently 5) write paths that set MemberProfile.medi_cal_id —
# routers/auth.py (self-signup + OAuth-onboarding-completion),
# routers/chw.py (CHW-initiated member creation, via register_user),
# routers/member.py (profile PUT + insurance-CIN PATCH) — a single
# SQLAlchemy attribute-level ``set`` event listener recomputes the digest on
# every assignment, including any future write path that's added later.
#
# This only fires on an explicit Python attribute assignment
# (``profile.medi_cal_id = value`` or a constructor kwarg) — SQLAlchemy's
# ORM-load path (hydrating a row fetched from the database) populates
# attributes directly into instance state without going through the
# instrumented ``__set__``, so this listener does NOT re-fire (and does not
# need to — the hash column is loaded from its own row value) every time an
# existing MemberProfile is read from the database.
def _sync_medi_cal_id_hash(target: "MemberProfile", value: str | None, oldvalue: object, initiator: object) -> None:
    """Recompute ``medi_cal_id_hash`` whenever ``medi_cal_id`` is assigned.

    Setting a falsy CIN (None or empty string) clears the hash too, so a
    member who removes their CIN frees up that CIN for another member (and
    never leaves a stale hash blocking the partial unique index for no
    reason).
    """
    from app.schemas.cin_config import normalize_cin
    from app.utils.encryption import hash_cin

    if value:
        normalized = normalize_cin(value)
        target.medi_cal_id_hash = hash_cin(normalized) if normalized else None
    else:
        target.medi_cal_id_hash = None


event.listen(MemberProfile.medi_cal_id, "set", _sync_medi_cal_id_hash, retval=False)
