# Module role: the contact group editor window — what `whatsapp_next.groups.open` loads and saves.
# One save carries the group's own fields and the member changes made in the window (rows picked
# with the ContactPicker in local mode, numbers marked for removal); they are applied in one
# request through the picker's own `commit_remove` / `commit_add`, so the audit reads the same as
# the picker's and a failure leaves nothing half-written. The controller keeps every rule
# (E.164, duplicates, the global blacklist); the API layer (`api/v1/groups.py`) only calls in here.

from __future__ import annotations

from collections import defaultdict
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, get_datetime

from whatsapp_next.exceptions import WANotFoundError, WAValidationError
from whatsapp_next.services import picker

DOCTYPE = "WhatsApp Contact Group"

# the only group fields a payload may carry
FIELDS: tuple[str, ...] = ("group_name", "kind", "description", "disabled")
MAX_ROWS = 20000


def _get(name: str):
	if not frappe.db.exists(DOCTYPE, name):
		frappe.throw(_("Contact group {0} not found").format(name), WANotFoundError)
	return frappe.get_doc(DOCTYPE, name)


def _kinds() -> list[str]:
	df = frappe.get_meta(DOCTYPE).get_field("kind")
	return [o for o in (df.options or "").split("\n") if o] if df else []


def editor(name: str | None = None) -> dict[str, Any]:
	"""What the window opens with: `{group, kinds[], can_write}` — the group (defaults for a new
	one; members are paged separately through `picker.get_group_members`). E: `WANotFoundError`."""
	kinds = _kinds()
	if not name:
		frappe.has_permission(DOCTYPE, "create", throw=True)
		group = {"name": None, "group_name": "", "kind": kinds[0] if kinds else "", "description": "", "disabled": 0}
		group.update({"member_count": 0, "modified": None, "source": "Picker"})
		return {"group": group, "kinds": kinds, "can_write": True}
	doc = _get(name)
	doc.check_permission("read")
	group = {f: doc.get(f) for f in FIELDS}
	group.update({"name": doc.name, "member_count": cint(doc.member_count), "modified": str(doc.modified), "source": doc.source})
	return {"group": group, "kinds": kinds, "can_write": bool(frappe.has_permission(DOCTYPE, "write", doc=doc))}


def _apply(doc, payload: dict) -> None:
	for f in FIELDS:
		if f in payload:
			doc.set(f, cint(payload[f]) if f == "disabled" else payload[f])


def save(payload: dict) -> dict[str, Any]:
	"""Create or update the group, then remove and add members. `payload`: the group fields,
	`name` + `modified` when editing, `add` (picker rows) and `remove` (E.164 keys). A changed
	name renames the group. Refuses to overwrite an edit saved elsewhere since the window opened.
	Returns `{name, modified, added, removed, skipped}`."""
	if not isinstance(payload, dict):
		frappe.throw(_("payload must be an object"), WAValidationError)
	new_name = (payload.get("group_name") or "").strip()
	if not new_name:
		frappe.throw(_("Give the group a name"), WAValidationError)
	payload["group_name"] = new_name
	add = [r for r in payload.get("add") or [] if isinstance(r, dict)]
	remove = [str(k) for k in payload.get("remove") or [] if k]
	if len(add) > MAX_ROWS or len(remove) > MAX_ROWS:
		frappe.throw(_("Up to {0} numbers can change in one save").format(MAX_ROWS), WAValidationError)

	name = payload.get("name")
	if name:
		doc = _get(name)
		doc.check_permission("write")
		opened = payload.get("modified")
		if opened and get_datetime(opened) != get_datetime(doc.modified):
			frappe.throw(
				_("Someone else saved this group after you opened it. Close it and open it again to see their changes."),
				WAValidationError,
			)
		_apply(doc, payload)
		doc.save()
		if new_name != doc.name:
			if frappe.db.exists(DOCTYPE, new_name):
				frappe.throw(_("A group named {0} already exists").format(new_name), WAValidationError)
			doc.name = frappe.rename_doc(DOCTYPE, doc.name, new_name, force=True)
	else:
		frappe.has_permission(DOCTYPE, "create", throw=True)
		if frappe.db.exists(DOCTYPE, new_name):
			frappe.throw(_("A group named {0} already exists").format(new_name), WAValidationError)
		doc = frappe.new_doc(DOCTYPE)
		_apply(doc, payload)
		doc.source = "Picker" if add else "Manual"
		doc.insert()

	removed = 0
	if remove:
		removed = picker.commit_remove(DOCTYPE, doc.name, phone_e164s=remove, user=frappe.session.user)["removed"]
	added = skipped = 0
	# one commit per source, as the picker does, so the audit says where each batch came from
	batches: dict[tuple, list[dict]] = defaultdict(list)
	for row in add:
		batches[(row.get("source_type") or "Manual", row.get("source_name") or None)].append(row)
	for (source_type, source_ref), rows in batches.items():
		if source_type not in picker.SOURCE_TYPES:
			source_type = "Manual"
		r = picker.commit_add(DOCTYPE, doc.name, rows, source_type=source_type, source_ref=source_ref, user=frappe.session.user)
		added += cint(r.get("added"))
		skipped += cint(r.get("skipped_duplicates")) + cint(r.get("skipped_invalid"))
	return {
		"name": doc.name,
		"modified": str(frappe.db.get_value(DOCTYPE, doc.name, "modified")),
		"added": added,
		"removed": removed,
		"skipped": skipped,
	}
