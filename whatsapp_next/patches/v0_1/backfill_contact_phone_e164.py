# Module role: one-time backfill of `Contact Phone.wa_phone_e164` (D-028). The custom field is a
# fixture, so on a fresh install the column may not exist yet when this patch runs; the patch
# then creates the field itself (idempotent) before backfilling.

from __future__ import annotations

import frappe

from whatsapp_next.services.phone import normalize

BATCH = 2000


def ensure_custom_field() -> None:
	"""Create `Contact Phone-wa_phone_e164` when the fixture has not been synced yet."""
	if frappe.db.exists("Custom Field", "Contact Phone-wa_phone_e164"):
		return
	from frappe.custom.doctype.custom_field.custom_field import create_custom_field

	create_custom_field(
		"Contact Phone",
		{
			"fieldname": "wa_phone_e164",
			"label": "WhatsApp Phone (E.164)",
			"fieldtype": "Data",
			"insert_after": "is_primary_mobile_no",
			"hidden": 1,
			"read_only": 1,
			"search_index": 1,
			"no_copy": 1,
			"module": "WhatsApp Next",
			"description": "Normalized E.164 value of `phone`, maintained by whatsapp_next (Contact.validate).",
		},
		ignore_validate=True,
	)


def execute() -> None:
	"""Fill `wa_phone_e164` for every Contact Phone row that still lacks it."""
	if not frappe.db.exists("DocType", "Contact Phone"):
		return
	ensure_custom_field()
	frappe.reload_doc("contacts", "doctype", "contact_phone")
	if not frappe.db.has_column("Contact Phone", "wa_phone_e164"):
		return
	start = 0
	while True:
		rows = frappe.get_all(
			"Contact Phone",
			filters={"wa_phone_e164": ("is", "not set"), "phone": ("is", "set")},
			fields=["name", "phone"],
			limit_start=start,
			limit_page_length=BATCH,
			order_by="name",
		)
		if not rows:
			break
		for row in rows:
			e164 = normalize(row.phone)
			if e164:
				frappe.db.set_value("Contact Phone", row.name, "wa_phone_e164", e164, update_modified=False)
		if len(rows) < BATCH:
			break
		start += BATCH
	frappe.db.commit()
