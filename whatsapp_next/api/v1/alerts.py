# Module role: API of the WhatsApp Notification Alert form (backend-plan §4.9, D-016) and of its
# editor window (D-139): job-free preview, "run now" (enqueued on `long`), report column choices,
# the dynamic-filter token reference, and the editor's open / preview-draft / test / save / delete /
# enable / pickers. Thin wrappers over `services/alerts.py`, `services/alerts_dates.py` and
# `services/alerts_editor.py`.

from __future__ import annotations

from typing import Any

import frappe

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import MANAGER
from whatsapp_next.services import alerts, alerts_dates, alerts_editor


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


# ---- the editor window (D-139) ----------------------------------------------------------------


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_editor(name: str | None = None) -> dict[str, Any]:
	"""What the editor opens with (`alerts_editor.editor`). P: Manager + read / create."""
	return alerts_editor.editor(name or None)


@api_endpoint(roles=MANAGER)
def preview_draft(payload: dict) -> dict[str, Any]:
	"""Run the editor's draft without sending (`alerts_editor.preview`). P: Manager."""
	return alerts_editor.preview(payload)


@api_endpoint(roles=MANAGER)
def send_test(payload: dict, phone: str) -> dict[str, Any]:
	"""Send the draft once to `phone`; audited `Alert Test Sent`. P: Manager."""
	return alerts_editor.send_test(payload, phone)


@api_endpoint(roles=MANAGER)
def save_editor(payload: dict) -> dict[str, Any]:
	"""Create or update the alert (`alerts_editor.save`). P: Manager + write / create."""
	return alerts_editor.save(payload)


@api_endpoint(roles=MANAGER)
def set_enabled(name: str, enabled: int) -> dict[str, Any]:
	"""Switch the alert on or off. P: Manager + write."""
	return alerts_editor.set_enabled(name, enabled)


@api_endpoint(roles=MANAGER)
def delete_alert(name: str) -> dict[str, bool]:
	"""Delete the alert. P: Manager + delete."""
	alerts_editor.delete(name)
	return {"deleted": True}


@api_endpoint(
	roles=MANAGER,
	methods=("GET", "POST"),
	schema={"kind": {"enum": ["report", "user", "role", "print_format", "letter_head", "language"]}},
)
def search(kind: str, txt: str | None = None) -> list[dict[str, Any]]:
	"""The editor's pickers (`alerts_editor.search`). P: Manager; the caller's own permissions."""
	return alerts_editor.search(kind, txt)
