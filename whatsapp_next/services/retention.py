# Module role: retention / cleanup (backend-plan §12, cron `0 3 * * *`, `long`). Deletes rows
# older than the Settings retention days table by table in the documented order (Webhook Event
# → Queue Item → WhatsApp Log → Inbound → Audit Log), 1 000 names per statement with a commit
# per batch, blanks processed webhook payloads early, and writes one `Retention Purge` audit row
# per table. PII never reaches the Error Log.

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import frappe
from frappe.utils import add_days, add_to_date, cint, now_datetime

from whatsapp_next.services import audit

BATCH = 1000
TERMINAL_QUEUE = ("Completed", "Deleted", "Dead Letter")

# (doctype, settings field, date field, extra filters)
PLAN: tuple[tuple[str, str, str, dict[str, Any]], ...] = (
	("WhatsApp Webhook Event", "webhook_event_retention_days", "received_at", {}),
	("WhatsApp Queue Item", "queue_retention_days", "modified", {"status": ("in", list(TERMINAL_QUEUE))}),
	(
		"WhatsApp Log",
		"outbound_retention_days",
		"creation",
		{"status": ("in", ["Sent", "Delivered", "Read", "Failed", "Cancelled"])},
	),
	("WhatsApp Inbound Message", "inbound_retention_days", "received_at", {}),
	("WhatsApp Audit Log", "audit_retention_days", "timestamp", {}),
)


@dataclass
class PurgeReport:
	deleted: dict[str, int] = field(default_factory=dict)
	payloads_blanked: int = 0
	skipped: list[str] = field(default_factory=list)


def _delete_files_of(doctype: str, names: list[str]) -> int:
	"""Private files attached to the rows (rendered PDFs) go with them."""
	files = frappe.get_all(
		"File", filters={"attached_to_doctype": doctype, "attached_to_name": ("in", names)}, pluck="name"
	)
	for f in files:
		try:
			frappe.delete_doc("File", f, ignore_permissions=True, force=True, delete_permanently=True)
		except Exception:
			pass
	return len(files)


def purge_table(
	doctype: str,
	days: int,
	date_field: str,
	*,
	filters: dict[str, Any] | None = None,
	batch: int = BATCH,
	commit: bool = True,
) -> int:
	"""Delete rows of `doctype` whose `date_field` is older than `days` (0 = never). Returns the count."""
	days = cint(days)
	if days <= 0:
		return 0
	cutoff = add_days(now_datetime(), -days)
	total = 0
	while True:
		names = frappe.get_all(
			doctype,
			filters={**(filters or {}), date_field: ("<", cutoff)},
			pluck="name",
			limit=batch,
			order_by=f"{date_field} asc",
		)
		if not names:
			break
		if doctype == "WhatsApp Log":
			_delete_files_of(doctype, names)
		frappe.db.delete(doctype, {"name": ("in", names)})
		total += len(names)
		if commit:
			frappe.db.commit()
		if len(names) < batch:
			break
	return total


def blank_processed_payloads(older_than_days: int = 1) -> int:
	"""`payload = NULL` on `Processed` `message.*` webhook events older than a day."""
	cutoff = add_to_date(now_datetime(), days=-cint(older_than_days) or -1)
	names = frappe.get_all(
		"WhatsApp Webhook Event",
		filters={
			"status": "Processed",
			"event_name": ("like", "message.%"),
			"payload": ("is", "set"),
			"received_at": ("<", cutoff),
		},
		pluck="name",
		limit=BATCH * 10,
	)
	if names:
		frappe.db.set_value(
			"WhatsApp Webhook Event", {"name": ("in", names)}, "payload", None, update_modified=False
		)
	return len(names)


def purge(*, commit: bool = True) -> PurgeReport:
	"""Cron `0 3 * * *` (`long`, `wa-retention`): run the plan in order; audit per table."""
	settings = frappe.get_single("WhatsApp Settings")
	report = PurgeReport()
	report.payloads_blanked = blank_processed_payloads()
	for doctype, setting, date_field, filters in PLAN:
		days = cint(settings.get(setting))
		if days <= 0:
			report.skipped.append(doctype)
			continue
		n = purge_table(doctype, days, date_field, filters=filters, commit=commit)
		report.deleted[doctype] = n
		if n:
			audit.log(
				"Retention Purge",
				severity="Info",
				count=n,
				user="Administrator",
				details={"doctype": doctype, "days": days},
			)
	if commit:
		frappe.db.commit()
	return report
