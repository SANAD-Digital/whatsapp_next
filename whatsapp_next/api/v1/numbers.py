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
	"saved_name",
	"synced_device",
	"synced_at",
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
	or_filters: list[list[Any]] = []
	if txt and txt.strip():
		like = f"%{txt.strip()}%"
		or_filters = [["phone_e164", "like", like], ["display_name", "like", like]]
		# a number typed the local way (`0501234567`, Arabic digits) finds its E.164 key
		kind, key = classify(txt)
		if kind == "Individual" and key != txt.strip():
			or_filters.append(["phone_e164", "like", f"%{key}%"])
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
	total = frappe.get_all(
		"WhatsApp Number",
		filters=filters,
		or_filters=or_filters,
		fields=[{"COUNT": "*", "as": "total"}],
	)[0].total
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


# ---- fetching the phone's contacts ---------------------------------------------------------


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def list_sync_devices() -> list[dict[str, Any]]:
	"""Devices a contacts fetch can read: registered on the platform and not disabled — connected
	first, then the default device, then the one heard from most recently: `[{name, device_name,
	phone, status, is_default, synced_at}]`. P: Manager."""
	default = frappe.db.get_single_value("WhatsApp Settings", "default_device")
	rows = frappe.get_all(
		"WhatsApp Device",
		filters={"platform_device": ("is", "set"), "disabled": 0},
		fields=["name", "device_name", "phone", "status"],
		# the device heard from most recently first: a live session hears from the platform often
		order_by="last_status_event_at desc",
	)
	last = {
		r.synced_device: r.synced_at
		for r in frappe.get_all(
			"WhatsApp Number",
			filters={"synced_device": ("in", [r.name for r in rows] or [""])},
			fields=["synced_device", {"MAX": "synced_at", "as": "synced_at"}],
			group_by="synced_device",
		)
	}
	out = [{**r, "is_default": r.name == default, "synced_at": last.get(r.name)} for r in rows]
	# stable: within each band the most recently heard-from device stays first
	return sorted(out, key=lambda r: (r["status"] != "Connected", not r["is_default"]))


@api_endpoint(roles=MANAGER)
def sync_from_device(device: str) -> dict[str, Any]:
	"""Start fetching `device`'s WhatsApp contacts into the Numbers table (`numbers_sync`, a `long`
	job); the counts arrive on `wa:numbers:synced` for the caller. P: Manager."""
	if not frappe.db.exists("WhatsApp Device", device):
		frappe.throw(_("WhatsApp Device {0} not found").format(device), WANotFoundError)
	from frappe.utils import now_datetime

	from whatsapp_next.services import numbers_sync

	numbers_sync.set_state(device, {"status": "running", "at": str(now_datetime())})
	frappe.enqueue(
		"whatsapp_next.services.numbers_sync.run_sync_job",
		device=device,
		user=frappe.session.user,
		queue="long",
		job_id=f"wa-numbers-sync-{device}",
		deduplicate=True,
		enqueue_after_commit=True,
		timeout=900,
	)
	return {"queued": True, "device": device}


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_sync_state(device: str) -> dict[str, Any]:
	"""Where the last fetch of `device` stands: `{status: running|done|failed|none, stats?, error?,
	at?}` — what a page polls when the realtime event does not reach it. P: Manager."""
	from whatsapp_next.services import numbers_sync

	return numbers_sync.state_of(device) or {"status": "none"}
