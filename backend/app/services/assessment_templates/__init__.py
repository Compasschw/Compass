"""Assessment template registry.

Templates are pure Python dicts — JSON-serializable, easy to version,
no DB migration needed to add/change questions. The template_id is the
authoritative key; the router resolves it here.
"""

from app.services.assessment_templates.compass_member_v1 import TEMPLATE as _COMPASS_MEMBER_V1
from app.services.assessment_templates.compass_intro_script_v1 import TEMPLATE as _COMPASS_INTRO_V1

_REGISTRY: dict[str, dict] = {
    "compass_member_v1": _COMPASS_MEMBER_V1,
    "compass_intro_script_v1": _COMPASS_INTRO_V1,
}


def get_template(template_id: str) -> dict | None:
    """Return the template dict for the given template_id, or None if not found."""
    return _REGISTRY.get(template_id)


def list_template_ids() -> list[str]:
    """Return all registered template IDs."""
    return list(_REGISTRY.keys())
