# Module role: creating WhatsApp groups from the product's screens (Contacts, WhatsApp Numbers,
# Contact Groups). The device creates the group through the provider and becomes its admin; the
# group then exists here as a WhatsApp Number of type Group, and — when it was created for a
# Contact — as one of that contact's numbers too. Plan feature `allow_groups`.

from __future__ import annotations

from dataclasses import asdict
from typing import Any

import frappe
from frappe import _
from frappe.utils import now_datetime

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.services import audit, plan_features
from whatsapp_next.services.guards import status_writer
from whatsapp_next.services.phone import classify

MAX_MEMBERS = 256
MAX_NAME = 100


def members_from(source_doctype: str, names: list[str]) -> list[dict[str, Any]]:
	"""The WhatsApp numbers behind a selection, to prefill the dialog: Contacts (their numbers),
	WhatsApp Contact Groups (their members) or WhatsApp Numbers (individual ones). Read through the
	caller's permissions; each row `{phone_e164, display_name}`."""
	names = [n for n in names or [] if n][:MAX_MEMBERS]
	out: dict[str, str | None] = {}
	if source_doctype == "Contact":
		from whatsapp_next.services import permissions

		# only the contacts this user may read: through the product's contact role (all of them),
		# else one by one through Frappe's own permission (`get_all` itself checks nothing)
		if not permissions.can_elevate("read"):
			names = [n for n in names if frappe.has_permission("Contact", "read", n)]
		for row in frappe.get_all("Contact Phone", filters={"parenttype": "Contact", "parent": ("in", names or [""])},
				fields=["parent", "wa_phone_e164"]):
			kind, key = classify(row.wa_phone_e164)
			if kind == "Individual":
				out.setdefault(key, frappe.db.get_value("Contact", row.parent, "full_name"))
	elif source_doctype == "WhatsApp Contact Group":
		for name in names:
			frappe.has_permission("WhatsApp Contact Group", "read", name, throw=True)
		for row in frappe.get_all("WhatsApp Contact Group Member", filters={"parent": ("in", names)},
				fields=["phone_e164", "display_name"], ignore_permissions=True):
			kind, key = classify(row.phone_e164)
			if kind == "Individual":
				out.setdefault(key, row.display_name)
	elif source_doctype == "WhatsApp Number":
		for row in frappe.get_list("WhatsApp Number", filters={"name": ("in", names), "number_type": "Individual"},
				fields=["name", "display_name"]):
			out.setdefault(row.name, row.display_name)
	else:
		frappe.throw(_("Members cannot be taken from {0}").format(source_doctype), WAValidationError)
	return [{"phone_e164": k, "display_name": v} for k, v in out.items()]


def create(device: str, name: str, members: list[str], description: str | None = None,
		contact: str | None = None, user: str | None = None) -> dict[str, Any]:
	"""Create the group on `device` with `members` (numbers); returns `{jid, name, members[{phone,
	status, jid}], invite_link, saved_to_contact}`. Audited `WhatsApp Group Created`."""
	from whatsapp_next.providers import registry

	plan_features.require_groups()
	name = (name or "").strip()
	if not name or len(name) > MAX_NAME:
		frappe.throw(_("The group name is required, at most {0} characters").format(MAX_NAME), WAValidationError)
	keys = []
	for m in members or []:
		kind, key = classify(m)
		if kind == "Individual" and key not in keys:
			keys.append(key)
	if not keys:
		frappe.throw(_("Choose at least one number to add"), WAValidationError)
	if len(keys) > MAX_MEMBERS:
		frappe.throw(_("A group holds at most {0} members").format(MAX_MEMBERS), WAValidationError)
	row = frappe.db.get_value("WhatsApp Device", device, ["platform_device", "status", "disabled"], as_dict=True)
	if not row:
		frappe.throw(_("WhatsApp Device {0} not found").format(device), WAValidationError)
	if row.status != "Connected":
		frappe.throw(_("{0} is not connected").format(device), WAStateConflictError)

	created = registry.get_provider().create_group(row.platform_device, name, keys, (description or "").strip() or None)
	kind, jid = classify(created.jid)
	if kind != "Group":
		frappe.throw(_("The group was not created"), WAStateConflictError)
	_save_number(jid, created.name or name, device)
	saved = False
	if contact:
		from whatsapp_next.services import permissions

		saved = permissions.add_group_to_contact(contact, jid, user=user)
	audit.log("WhatsApp Group Created", reference=("WhatsApp Number", jid), target=("Contact", contact) if contact else None,
		count=len(keys), details={"device": device, "statuses": _tally(created.members)}, user=user)
	return {
		"jid": jid,
		"name": created.name or name,
		"members": [asdict(m) for m in created.members],
		"invite_link": created.invite_link,
		"saved_to_contact": saved,
	}


def _save_number(jid: str, name: str, device: str) -> None:
	"""The group's WhatsApp Number row, as the device sync would write it."""
	now = now_datetime()
	if frappe.db.exists("WhatsApp Number", jid):
		frappe.db.set_value("WhatsApp Number", jid, {"display_name": name, "saved_name": name,
			"synced_device": device, "synced_at": now})
		return
	with status_writer():
		frappe.get_doc({"doctype": "WhatsApp Number", "phone_e164": jid, "jid": jid, "number_type": "Group",
			"display_name": name, "saved_name": name, "synced_device": device, "synced_at": now,
			"link_status": "Not Linked"}).insert(ignore_permissions=True)


def _tally(members) -> dict[str, int]:
	out: dict[str, int] = {}
	for m in members:
		out[m.status] = out.get(m.status, 0) + 1
	return out
