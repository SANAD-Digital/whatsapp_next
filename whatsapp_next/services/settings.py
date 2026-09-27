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
