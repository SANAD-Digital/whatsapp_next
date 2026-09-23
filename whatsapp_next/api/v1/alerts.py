# Module role: API of the WhatsApp Notification Alert form (backend-plan §4.9, D-016): job-free
# preview, "run now" (enqueued on `long`), report column choices and the dynamic-filter token
# reference. Thin wrappers over `services/alerts.py` and `services/alerts_dates.py`.

from __future__ import annotations

from typing import Any

import frappe

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import MANAGER
from whatsapp_next.services import alerts, alerts_dates


@api_endpoint(roles=MANAGER)
def preview(name: str) -> dict[str, Any]:
	"""Render the alert without sending: `{row_count, message, recipients_count, attachment_name,
	error}`. P: Manager."""
	frappe.has_permission("WhatsApp Notification Alert", "read", name, throw=True)
	run = alerts.run_alert(name, preview=True)
	first = run.recipients[0] if run.recipients else {}
	return {
		"row_count": run.rows,
		"message": run.body,
		"recipients_count": len(run.recipients),
		"attachment_name": first.get("file_name"),
		"error": run.error,
	}


@api_endpoint(roles=MANAGER)
def run_now(name: str) -> dict[str, str | None]:
	"""Enqueue `alerts.run_alert` on the `long` queue; returns `{job_id}`. P: Manager."""
	frappe.has_permission("WhatsApp Notification Alert", "read", name, throw=True)
	job = frappe.enqueue(
		"whatsapp_next.services.alerts.run_alert",
		name=name,
		queue="long",
		job_id=f"wa-alert-now-{name}",
		deduplicate=True,
		enqueue_after_commit=True,
		timeout=900,
	)
	return {"job_id": getattr(job, "id", None)}


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_report_columns(report: str, filters: dict | None = None) -> list[dict[str, Any]]:
	"""`[{fieldname, label, fieldtype}]` of `report` run with `filters` (empty when the report
	cannot run or the caller may not run it — `query_report.run` checks). P: Manager."""
	return alerts.report_columns(report, filters=filters)


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_dynamic_filter_reference() -> list[dict[str, str | None]]:
	"""`[{name, example}]` for every dynamic-filter token of `alerts_dates.TOKENS` (`N` tokens are
	exemplified with 7). P: Manager."""
	return [
		{"name": token, "example": alerts_dates.resolve(token.replace(":N", ":7"))}
		for token in alerts_dates.TOKENS
	]
