"""Provider-agnostic interface for CHW payouts.

CompassCHW is the merchant of record:
  Medi-Cal → Pear Suite → Compass Stripe balance → CHW connected account → bank

Any payments provider (Stripe, Adyen for Platforms, etc.) must implement this
interface. The rest of the application imports only from this module.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from uuid import UUID


@dataclass
class ConnectedAccount:
    """Result of creating a new CHW payout account."""
    provider_account_id: str
    provider: str  # "stripe" | "adyen"


@dataclass
class OnboardingLink:
    """A hosted URL where the CHW completes KYC + bank info."""
    url: str
    expires_at_iso: str


@dataclass
class AccountStatus:
    """Provider-reported state of a connected account."""
    charges_enabled: bool
    payouts_enabled: bool
    details_submitted: bool
    requirements_currently_due: list[str] = field(default_factory=list)
    raw: dict | None = None


@dataclass
class TransferResult:
    """Outcome of initiating a platform-to-connected-account transfer."""
    success: bool
    provider_transfer_id: str | None = None
    amount_cents: int = 0
    error: str | None = None
    raw: dict | None = None


@dataclass
class TransferRequest:
    """Request to move funds from Compass's platform balance to a CHW."""
    connected_account_id: str
    amount_cents: int
    description: str
    # For reconciliation — surfaced in provider dashboards and webhooks
    session_id: UUID | None = None
    billing_claim_id: UUID | None = None
    chw_id: UUID | None = None
    service_date_iso: str | None = None


class PaymentsProvider(ABC):
    """Abstract interface for payout/connected-account providers."""

    @abstractmethod
    async def create_connected_account(
        self,
        user_id: UUID,
        email: str,
        country: str = "US",
    ) -> ConnectedAccount:
        """Create a new Connect account for a CHW. Called once per CHW during onboarding."""

    @abstractmethod
    async def create_onboarding_link(
        self,
        connected_account_id: str,
        return_url: str,
        refresh_url: str,
    ) -> OnboardingLink:
        """Generate a short-lived URL where the CHW completes KYC + bank collection.

        `return_url` = where Stripe redirects after successful onboarding.
        `refresh_url` = where Stripe redirects if the link expires and the CHW clicks retry.
        """

    @abstractmethod
    async def get_account_status(self, connected_account_id: str) -> AccountStatus:
        """Fetch the current readiness state of a connected account.

        Use `payouts_enabled` as the gate for transferring funds — false means
        the CHW hasn't finished KYC, bank verification, or identity upload.
        """

    @abstractmethod
    async def transfer(self, req: TransferRequest) -> TransferResult:
        """Transfer funds from Compass's platform balance to a connected account.

        Idempotency: callers should pass a unique session_id or billing_claim_id
        so duplicate triggers don't send money twice. Provider-level idempotency
        keys are computed from those values.
        """

    @abstractmethod
    def verify_webhook(self, payload: bytes, signature_header: str) -> dict:
        """Verify a webhook's authenticity and return the parsed event.

        Raises if the signature is invalid — never process unverified events.
        """
