# Module role: the write path of the Settings page (backend-plan §4.1 `settings.save_settings`,
# A-2 of the phase-8 report). The API owns the per-section allow-list; this writes the fields it
# was given (the picker-sources table row by row), saves once and audits `Settings Changed`.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services import audit

SETTINGS = "WhatsApp Settings"
PICKER_SOURCE_FIELDS: tuple[str, ...] = (
	"document_type",
	"label",
	"phone_source",
	"phone_fieldname",
	"contact_fieldname",
	"name_fieldname",
	"filters_json",
	"enabled",
)


def store_secret(fieldname: str, value: str) -> None:
	"""Store one Settings password outside a document save (a sign-up, a fetched webhook secret).

	`set_encrypted_password` alone fills `__Auth` but leaves the field itself empty in `tabSingles`;
	Frappe's `_save_passwords` reads an empty Password field on the next ordinary save of Settings as
	"cleared" and deletes the stored value. So the field also gets the masked placeholder a document
	save would have written — which is how a sign-up's keys vanished the first time Settings was saved.
	"""
	from frappe.utils.password import set_encrypted_password

	set_encrypted_password(SETTINGS, SETTINGS, value, fieldname)
	frappe.db.set_single_value(SETTINGS, fieldname, "*" * len(value), update_modified=False)


def save_fields(values: dict[str, Any], *, section: str, user: str | None = None) -> list[str]:
	"""Write `values` (already allow-listed by the caller) into Settings; returns the fieldnames
	that changed. `picker_sources` replaces the whole table."""
	if not values:
		frappe.throw(_("Nothing to save"), WAValidationError)
	doc = frappe.get_doc(SETTINGS)
	changed: list[str] = []
	for fieldname, value in values.items():
		if fieldname == "picker_sources":
			if not isinstance(value, list):
				frappe.throw(_("picker_sources must be a list of rows"), WAValidationError)
			doc.set("picker_sources", [])
			for row in value:
				doc.append(
					"picker_sources", {f: row.get(f) for f in PICKER_SOURCE_FIELDS if f in (row or {})}
				)
			changed.append(fieldname)
			continue
		if doc.get(fieldname) != value:
			doc.set(fieldname, value)
			changed.append(fieldname)
	if changed:
		doc.flags.ignore_permissions = True
		doc.save(ignore_permissions=True)
		audit.log("Settings Changed", fields_written=changed, details={"section": section}, user=user)
	return changed


def stored_or_default(fieldname: str):
	"""A Settings value, or the field's default when the Settings row was saved before the field
	existed. Frappe hands a never-saved Check back as 0 (not empty), so the stored row is asked."""
	singles = frappe.qb.DocType("Singles")
	stored = (
		frappe.qb.from_(singles)
		.select(singles.value)
		.where((singles.doctype == SETTINGS) & (singles.field == fieldname))
		.run()
	)
	if stored:
		return frappe.get_cached_doc(SETTINGS).get(fieldname)
	df = frappe.get_meta(SETTINGS).get_field(fieldname)
	return df.default if df else None
