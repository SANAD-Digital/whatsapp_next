# Module role: API of the WhatsApp Numbers screen (backend-plan §4.8, screen 13) over the
# materialized `WhatsApp Number` table. Reads are role-gated (Viewer+ / Contact User); link and
# convert go through the contextual layer in `services/permissions.py` (`roles=None`, gate inside);
# unlink is Manager-only and confirm is Agent+. Nothing here writes core `Contact` directly.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _

from whatsapp_next.api._common import api_endpoint, paginate
from whatsapp_next.api.v1 import _bulk
from whatsapp_next.api.v1._roles import AGENT_UP, CONTACT_USER, MANAGER, VIEWER_UP
from whatsapp_next.exceptions import WANotFoundError
from whatsapp_next.services import permissions
from whatsapp_next.services.phone import classify

NUMBER_FIELDS: tuple[str, ...] = (
	"name",
	"phone_e164",
	"jid",
	"number_type",
	"display_name",
	"contact",
	"link_status",
	"linked_by",
	"linked_at",
	"first_seen",
	"last_seen",
	"last_direction",
	"last_device",
	"outbound_count",
	"inbound_count",
	"conversation_confirmed",
	"conversation_confirmed_by",
	"conversation_confirmed_at",
	"conversation_note",
	"modified",
)
SEARCH_FIELDS: tuple[str, ...] = (
	"name",
	"phone_e164",
	"number_type",
	"display_name",
	"contact",
	"link_status",
	"last_seen",
	"outbound_count",
	"inbound_count",
	"conversation_confirmed",
)


def _key(phone_e164: str) -> str:
	kind, key = classify(phone_e164)
	if not kind or not frappe.db.exists("WhatsApp Number", key):
		frappe.throw(_("WhatsApp Number {0} not found").format(phone_e164), WANotFoundError)
	return key


@api_endpoint(roles=VIEWER_UP + CONTACT_USER, methods=("GET", "POST"))
def get_number(phone_e164: str) -> dict[str, Any]:
	"""Number row + `contact_summary` (CONTACT_READ fields through the contextual layer, only when
	the caller may read contacts). P: Viewer+, Contact User. E: `WANotFoundError`."""
	key = _key(phone_e164)
	row = frappe.db.get_value("WhatsApp Number", key, list(NUMBER_FIELDS), as_dict=True)
	row["contact_summary"] = (
		permissions.get_contact(row.contact) if row.contact and permissions.can_elevate("read") else None
	)
	return row


@api_endpoint(roles=None)
def link_number(phone_e164: str, contact: str) -> dict[str, str]:
	"""Link a number to an existing Contact. P: Contact User | Contact write. E: `WANotFoundError`;
	audited `Number Linked`."""
	permissions.require("write")
	key = permissions.link_number(phone_e164, contact)
	return {"contact": contact, "link_status": frappe.db.get_value("WhatsApp Number", key, "link_status")}


@api_endpoint(roles=None)
def convert_number(
	phone_e164: str,
	first_name: str,
	last_name: str | None = None,
	party_type: str | None = None,
	party_name: str | None = None,
) -> dict[str, str]:
	"""Create a Contact from the number (phone row + optional party link) and link it.
	P: Contact User | Contact create. E: `WANotFoundError`, `WAStateConflictError` (already
	linked); audited `Number Converted`."""
	permissions.require("create")
	contact = permissions.convert_number(
		phone_e164, first_name, last_name=last_name, party_type=party_type, party_name=party_name
	)
	return {"contact": contact, "link_status": "Linked"}


@api_endpoint(roles=MANAGER)
def unlink_number(phone_e164: str) -> dict[str, str]:
	"""Detach the number from its Contact. P: Manager. E: `WANotFoundError`; audited
	`Number Linked` with `details.unlinked=1`."""
	key = permissions.unlink_number(phone_e164)
	return {"link_status": frappe.db.get_value("WhatsApp Number", key, "link_status")}


@api_endpoint(roles=AGENT_UP)
def confirm_conversation(phone_e164: str, confirmed: bool, note: str | None = None) -> dict[str, bool]:
	"""Mark / unmark the number as a confirmed conversation. P: Agent, Manager. E: `WANotFoundError`;
	audited `Conversation Confirmed`."""
	return {"conversation_confirmed": permissions.confirm_conversation(phone_e164, confirmed, note=note)}


@api_endpoint(
	roles=VIEWER_UP + CONTACT_USER,
	methods=("GET", "POST"),
	schema={"link_status": {"enum": ["Linked", "Not Linked"]}},
)
def search_numbers(
	txt: str | None = None, link_status: str | None = None, page: int = 1, page_length: int = 20
) -> dict[str, Any]:
	"""Number rows matching `txt` (key or display name), optionally by `link_status`
	(QuickSend / picker helper). Returns `{rows, total}`. P: Viewer+, Contact User."""
	filters: dict[str, Any] = {}
	if link_status:
		filters["link_status"] = link_status
	or_filters: dict[str, Any] = {}
	if txt and txt.strip():
		like = f"%{txt.strip()}%"
		or_filters = {"phone_e164": ("like", like), "display_name": ("like", like)}
	start, length = paginate(page, page_length)
	rows = frappe.get_all(
		"WhatsApp Number",
		filters=filters,
		or_filters=or_filters,
		fields=list(SEARCH_FIELDS),
		order_by="last_seen desc, name asc",
		start=start,
		page_length=length,
	)
	total = len(frappe.get_all("WhatsApp Number", filters=filters, or_filters=or_filters, pluck="name"))
	return {"rows": rows, "total": total}


@api_endpoint(roles=None)
def convert_many(phone_e164s: list[str]) -> dict[str, Any]:
	"""Bulk convert (09 G-01): create a Contact for every `Not Linked` number using its display
	name (or the number) as `first_name`; linked rows are reported in `skipped`.
	P: Contact User | Contact create."""
	permissions.require("create")

	def one(phone_e164: str) -> None:
		key = _key(phone_e164)
		row = frappe.db.get_value(
			"WhatsApp Number", key, ["contact", "display_name", "number_type"], as_dict=True
		)
		if row.contact:
			raise _bulk.Skip("already linked")
		if row.number_type != "Individual":
			raise _bulk.Skip("not an individual number")
		permissions.convert_number(key, first_name=(row.display_name or "").strip() or key)

	return _bulk.run_bulk(phone_e164s, one)


@api_endpoint(roles=None, methods=("GET", "POST"))
def get_conversation_log(phone_e164: str) -> dict[str, Any]:
	"""The number's conversation-state history (09 G-06): `{rows[{at, user, user_name, confirmed,
	note}]}`, newest first. P: Contact User | Contact read."""
	return {"rows": permissions.conversation_log(phone_e164)}
