# Module role: whitelisted endpoints of the WhatsApp hub window (services.hub). Managers read and
# install; a function, which runs code on the site, needs a System Manager (checked in the service).

from __future__ import annotations

from typing import Any

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import MANAGER
from whatsapp_next.services import hub

TYPES = list(hub.DOCTYPES)


@api_endpoint(roles=MANAGER, methods=("GET", "POST"), schema={"hub_type": {"enum": TYPES}, "txt": {"max_length": 100}})
def list_entries(hub_type: str, txt: str | None = None) -> list[dict[str, Any]]:
	"""The hub's entries of one type, with `state` (not_installed / update_available / installed)."""
	return hub.entries(hub_type, txt)


@api_endpoint(roles=MANAGER, methods=("GET", "POST"), schema={"name": {"max_length": 140}})
def get_entry(name: str) -> dict[str, Any]:
	"""One entry with all its data and its `state` here."""
	return hub.entry(name)


@api_endpoint(roles=MANAGER, schema={"name": {"max_length": 140}})
def install(name: str) -> dict[str, Any]:
	"""Install the entry, or update the copy installed before."""
	import frappe

	return hub.install(name, user=frappe.session.user)
