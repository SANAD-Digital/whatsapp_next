# Module role: API of the "Send a bulk message" window (D-136) — thin wrappers over
# services/bulk_send.py: the window's context, the live estimate of a selection, contact search
# for the "Contacts" tab (through the contextual permission layer) and the send itself, which
# becomes a campaign started now or scheduled.

from __future__ import annotations

from typing import Any

import frappe

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import MANAGER
from whatsapp_next.services import bulk_send, permissions


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_context() -> dict[str, Any]:
	"""`{groups[], templates[], devices[], default_device, rate, messages_remaining}`. P: Manager."""
	return bulk_send.context()


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def estimate(
	groups: list | None = None, contacts: list | None = None, numbers: list | None = None
) -> dict[str, Any]:
	"""`{total, excluded, invalid}` for a selection (blacklists applied). P: Manager."""
	return bulk_send.estimate(groups, contacts, numbers)


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def search_contacts(txt: str | None = None) -> list[dict[str, Any]]:
	"""Contacts with a WhatsApp number for the "Contacts" tab: `[{name, label, phone, party_type}]`
	(`permissions.list_contacts`, audited). P: Manager and Contact User | Contact read."""
	permissions.require("read")
	page = permissions.list_contacts(search=txt or None, has_whatsapp=None, page_length=50)
	out = []
	for r in page["rows"]:
		phones = r.get("phone_nos") or []
		phone = next((p.get("wa_phone_e164") for p in phones if p.get("wa_phone_e164")), None)
		if not phone:
			continue
		links = r.get("links") or []
		out.append(
			{
				"name": r["name"],
				"label": r.get("full_name") or r["name"],
				"phone": phone,
				"party_type": links[0]["link_doctype"] if links else None,
			}
		)
	return out


@api_endpoint(roles=MANAGER)
def send(payload: dict) -> dict[str, Any]:
	"""Send one message to the selection: a campaign started now or scheduled
	(`services.bulk_send.send`); audited `Bulk Send`. P: Manager."""
	return bulk_send.send(payload, user=frappe.session.user)
