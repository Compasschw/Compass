"""Provider-agnostic interface for Medi-Cal claims submission.

Any billing provider (Pear Suite, direct 837 clearinghouse, etc.) must
implement this interface. The rest of the application imports only from
this module — never from a specific provider.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from uuid import UUID


@dataclass
class EligibilityResult:
    """Result of verifying a member's Medi-Cal eligibility."""
    is_eligible: bool
    plan_name: str | None = None
    cin: str | None = None  # Client Index Number (Medi-Cal identifier)
    message: str | None = None


@dataclass
class ClaimSubmission:
    """Data needed to submit a CHW service claim through a billing provider."""
    session_id: UUID
    chw_id: UUID
    member_id: UUID
    service_date: date
    procedure_code: str  # CPT: 98960/98961/98962
    modifier: str  # U2 for CHW services
    diagnosis_codes: list[str]  # ICD-10 Z-codes for SDOH
    units: int
    gross_amount: Decimal
    chw_npi: str | None = None  # National Provider Identifier
    notes: str | None = None
    extra: dict = field(default_factory=dict)


@dataclass
class ClaimResult:
    """Result of submitting a claim to a billing provider."""
    success: bool
    provider_claim_id: str | None = None
    status: str = "pending"  # pending, submitted, accepted, rejected, paid
    message: str | None = None
    raw_response: dict | None = None


class BillingProvider(ABC):
    """Abstract interface for billing / claims submission providers.

    To add a new provider:
    1. Create a new file (e.g., direct_837_provider.py)
    2. Implement this interface
    3. Update get_provider() in __init__.py
    """

    @abstractmethod
    async def verify_eligibility(self, member_medi_cal_id: str) -> EligibilityResult:
        """Check that a member is enrolled in a Medi-Cal plan and eligible for CHW services."""

    @abstractmethod
    async def submit_claim(self, claim: ClaimSubmission) -> ClaimResult:
        """Submit a completed session as a claim for reimbursement."""

    @abstractmethod
    async def get_claim_status(self, provider_claim_id: str) -> ClaimResult:
        """Poll the status of a previously submitted claim."""

    @abstractmethod
    async def void_claim(self, provider_claim_id: str) -> ClaimResult:
        """Void/retract a claim that hasn't yet been adjudicated."""
