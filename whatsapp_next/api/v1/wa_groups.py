# Module role: whitelisted endpoints for creating WhatsApp groups (services.wa_groups): the
# members behind a selection, and the creation itself.

from __future__ import annotations

from typing import Any

import frappe

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import AGENT_UP, MANAGER
from whatsapp_next.services import wa_groups


@api_endpoint(roles=AGENT_UP, methods=("GET", "POST"),
	schema={"source_doctype": {"enum": ["Contact", "WhatsApp Contact Group", "WhatsApp Number"]}})
def members_from(source_doctype: str, names: list) -> dict[str, Any]:
	"""`{members[{phone_e164, display_name}]}` behind the selected records, to prefill the dialog."""
	return {"members": wa_groups.members_from(source_doctype, [str(n) for n in names or []])}


@api_endpoint(roles=MANAGER, schema={"name": {"max_length": 100}})
def create_group(device: str, name: str, members: list, description: str | None = None,
		contact: str | None = None) -> dict[str, Any]:
	"""Create a WhatsApp group on `device` with `members` (numbers); with `contact`, the group is
	saved among that contact's numbers. → `{jid, name, members[{phone, status, jid}], invite_link,
	saved_to_contact}`."""
	return wa_groups.create(device, name, [str(m) for m in members or []], description, contact,
		user=frappe.session.user)
