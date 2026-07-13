import enum


class UserRole(str, enum.Enum):
    chw = "chw"
    member = "member"
    admin = "admin"

class Vertical(str, enum.Enum):
    # Epic C5: 'housing' is GRANDFATHERED — kept so historical rows (vertical
    # columns are String(50); this enum is validation-only) still validate,
    # deserialize, and render. It must NEVER be removed from this enum and
    # must NEVER be re-offered as a new selection anywhere in the product —
    # see native/src/lib/verticals.ts SELECTABLE_VERTICALS and the
    # value-lists in schemas/chw.py, schemas/resource.py, routers/resources.py
    # for the corresponding "selectable" exclusions. 'utilities' is its
    # replacement as a newly selectable vertical.
    housing = "housing"
    utilities = "utilities"
    transportation = "transportation"
    food = "food"
    mental_health = "mental_health"
    healthcare = "healthcare"
    employment = "employment"

class SessionStatus(str, enum.Enum):
    scheduled = "scheduled"
    in_progress = "in_progress"
    awaiting_documentation = "awaiting_documentation"
    completed = "completed"
    cancelled = "cancelled"

class RequestStatus(str, enum.Enum):
    open = "open"
    matched = "matched"
    completed = "completed"
    cancelled = "cancelled"

class Urgency(str, enum.Enum):
    routine = "routine"
    soon = "soon"
    urgent = "urgent"

class SessionMode(str, enum.Enum):
    in_person = "in_person"
    virtual = "virtual"
    phone = "phone"

class CredentialStatus(str, enum.Enum):
    pending = "pending"
    verified = "verified"
    expired = "expired"

class CredentialType(str, enum.Enum):
    chw_certification = "chw_certification"
    hipaa_training = "hipaa_training"
    background_check = "background_check"
    continuing_education = "continuing_education"

class ClaimStatus(str, enum.Enum):
    pending = "pending"
    submitted = "submitted"
    accepted = "accepted"
    rejected = "rejected"
    paid = "paid"

class ValidationStatus(str, enum.Enum):
    pending = "pending"
    in_review = "in_review"
    verified = "verified"
    rejected = "rejected"
    expired = "expired"

class MessageType(str, enum.Enum):
    text = "text"
    file = "file"
    system = "system"

class RewardAction(str, enum.Enum):
    session_completed = "session_completed"
    follow_through = "follow_through"
    streak_bonus = "streak_bonus"
    redeemed = "redeemed"

class EventType(str, enum.Enum):
    session = "session"
    goal_milestone = "goal_milestone"
    availability = "availability"
