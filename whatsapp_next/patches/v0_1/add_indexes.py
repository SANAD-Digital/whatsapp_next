# Module role: composite (and composite-unique) indexes that DocType JSON cannot express
# (fields.md F-11, RC-02; 02 §3). Idempotent: safe from `bench migrate`, `after_migrate` and
# `after_install`. Single-column indexes live in the JSON (`search_index` / `unique`).

from __future__ import annotations

import frappe

# (doctype, fields) — plain composite indexes.
COMPOSITE_INDEXES: tuple[tuple[str, tuple[str, ...]], ...] = (
	("WhatsApp Log", ("device", "creation")),
	("WhatsApp Log", ("reference_doctype", "reference_name")),
	("WhatsApp Log", ("status", "scheduled_at")),
	("WhatsApp Log", ("command", "creation")),
	("WhatsApp Log", ("notification", "creation")),
	("WhatsApp Inbound Message", ("device", "received_at")),
	("WhatsApp Inbound Message", ("command", "received_at")),
	("WhatsApp Queue Item", ("status", "scheduled_at", "priority")),
	("WhatsApp Queue Item", ("device", "status")),
	("WhatsApp Audit Log", ("reference_doctype", "reference_name")),
	("WhatsApp Audit Log", ("user", "creation")),
	("WhatsApp Notification", ("document_type", "event", "enabled")),
	("WhatsApp Notification Alert", ("enabled", "next_run_at")),
	("WhatsApp Webhook Event", ("event_name", "received_at")),
)

# (doctype, fields) — composite UNIQUE constraints (fields.md OQ-B, decided D-029).
COMPOSITE_UNIQUE: tuple[tuple[str, tuple[str, ...]], ...] = (
	("WhatsApp Inbound Message", ("device", "provider_message_id")),
)


def execute() -> None:
	"""Create every composite index / unique constraint that is missing."""
	for doctype, fields in COMPOSITE_INDEXES:
		if not frappe.db.table_exists(doctype):
			continue
		frappe.db.add_index(doctype, list(fields))
	for doctype, fields in COMPOSITE_UNIQUE:
		if not frappe.db.table_exists(doctype):
			continue
		frappe.db.add_unique(doctype, list(fields))


def expected_indexes() -> list[tuple[str, str]]:
	"""`(doctype, index_name)` pairs the test suite asserts on."""
	out = [(dt, frappe.db.get_index_name(list(fields))) for dt, fields in COMPOSITE_INDEXES]
	out += [(dt, "unique_" + "_".join(fields)) for dt, fields in COMPOSITE_UNIQUE]
	return out
