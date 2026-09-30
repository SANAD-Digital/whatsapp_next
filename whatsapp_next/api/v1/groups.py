# Module role: API of the contact group editor window (`whatsapp_next.groups.open`). Thin wrappers
# over services/groups_editor.py; the service checks read / create / write on the group itself.

from __future__ import annotations

from typing import Any

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import AGENT_UP, CONTACT_USER, VIEWER_UP
from whatsapp_next.services import groups_editor

EDITOR_ROLES = AGENT_UP + CONTACT_USER


@api_endpoint(roles=VIEWER_UP + CONTACT_USER, methods=("GET", "POST"))
def get_editor(name: str | None = None) -> dict[str, Any]:
	"""The group (or a new one's defaults), the kinds and whether the user may change it."""
	return groups_editor.editor(name)


@api_endpoint(roles=EDITOR_ROLES)
def save_editor(payload: dict) -> dict[str, Any]:
	"""Create or update the group and apply the member changes in one request
	→ `{name, modified, added, removed, skipped}`."""
	return groups_editor.save(payload)
