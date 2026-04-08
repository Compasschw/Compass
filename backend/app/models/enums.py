import enum

class UserRole(str, enum.Enum):
    chw = "chw"
    member = "member"
    admin = "admin"

class Vertical(str, enum.Enum):
    housing = "housing"
    rehab = "rehab"
    food = "food"
    mental_health = "mental_health"
    healthcare = "healthcare"

class SessionStatus(str, enum.Enum):
    scheduled = "scheduled"
    in_progress = "in_progress"
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
