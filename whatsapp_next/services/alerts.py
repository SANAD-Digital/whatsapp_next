# Module role: WhatsApp Notification Alert runs (D-016, backend-plan §11): due-alert selection
# (cron `*/15`), report execution through `frappe.desk.query_report.run` with static + dynamic
# filters, HTML → PDF/PNG attachment, body from Template or inline message, recipients expanded
# from User / Role / Phone / Report Column, one outbound per recipient at priority 3. Never
# blocks: every failure lands in `last_error` and an Error Log without report rows.

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, now_datetime

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services import alerts_dates, attachments, dispatch, report_render, templates
from whatsapp_next.services.dispatch import OutboundSpec
from whatsapp_next.services.phone import normalize

MAX_COLUMN_RECIPIENTS = 200
PNG_BINARY = "wkhtmltoimage"


@dataclass
class Recipient:
	phone_e164: str
	display_name: str | None = None
	contact: str | None = None
	source: str = "Phone"
	column_value: Any = None  # for Report Column recipients: rows are filtered to this value


@dataclass
class AlertRun:
	alert: str
	preview: bool
	recipients: list[dict[str, Any]] = field(default_factory=list)
	outbound: list[str] = field(default_factory=list)
	rows: int = 0
	columns: int = 0
	body: str | None = None
	attachment: str | None = None
	error: str | None = None
	next_run_at: Any = None


# ---- schedule ----------------------------------------------------------------------------


def compute_next_run(alert) -> Any:
	"""Delegates to the controller (single source of the periodicity rules)."""
	doc = (
		alert if hasattr(alert, "compute_next_run") else frappe.get_doc("WhatsApp Notification Alert", alert)
	)
	return doc.compute_next_run()


def run_due_alerts() -> list[str]:
	"""Cron `*/15`: enqueue `run_alert` for every enabled alert whose `next_run_at` has passed."""
	due = frappe.get_all(
		"WhatsApp Notification Alert",
		filters={"enabled": 1, "next_run_at": ("<=", now_datetime())},
		pluck="name",
	)
	for name in due:
		frappe.enqueue(
			"whatsapp_next.services.alerts.run_alert",
			name=name,
			queue="long",
			job_id=f"wa-alert-{name}",
			deduplicate=True,
			timeout=900,
		)
	return due


# ---- filters -----------------------------------------------------------------------------


def _load_json(value: Any) -> Any:
	if not value:
		return None
	if isinstance(value, str):
		try:
			return json.loads(value)
		except ValueError:
			frappe.throw(_("Filters must be valid JSON"), WAValidationError)
	return value


def resolve_filters(alert) -> dict[str, Any]:
	"""Static `filters_json` (object) merged with `dynamic_filters_json` (`{field: token}`,
	tokens per `alerts_dates.TOKENS`); dynamic values win."""
	filters: dict[str, Any] = {}
	static = _load_json(getattr(alert, "filters_json", None))
	if isinstance(static, dict):
		filters.update(static)
	elif isinstance(static, list):
		for item in static:
			if isinstance(item, list | tuple) and len(item) >= 3:
				filters[item[-3] if len(item) == 4 else item[0]] = item[-1]
	dynamic = _load_json(getattr(alert, "dynamic_filters_json", None))
	if isinstance(dynamic, dict):
		for k, v in dynamic.items():
			filters[k] = alerts_dates.resolve(v)
	return filters


# ---- recipients --------------------------------------------------------------------------


def _user_phone(user: str) -> str | None:
	row = frappe.db.get_value("User", user, ["mobile_no", "phone", "enabled"], as_dict=True)
	if not row or not cint(row.enabled):
		return None
	return normalize(row.mobile_no) or normalize(row.phone)


def expand_recipients(
	alert, rows: list[Any] | None = None, columns: list[Any] | None = None
) -> list[Recipient]:
	"""User → `User.mobile_no`; Role → enabled users of the role; Phone → the number; Report
	Column → one recipient per distinct value of that column (rows filtered later)."""
	out: list[Recipient] = []
	seen: set[tuple[str, Any]] = set()

	def add(
		phone: str | None, source: str, display_name: str | None = None, column_value: Any = None
	) -> None:
		if not phone or (phone, column_value) in seen:
			return
		seen.add((phone, column_value))
		out.append(
			Recipient(phone_e164=phone, display_name=display_name, source=source, column_value=column_value)
		)

	for row in alert.get("recipients") or []:
		if row.recipient_type == "User" and row.user:
			add(_user_phone(row.user), "User", frappe.db.get_value("User", row.user, "full_name"))
		elif row.recipient_type == "Role" and row.role:
			for user in frappe.get_all(
				"Has Role", filters={"role": row.role, "parenttype": "User"}, pluck="parent"
			):
				add(_user_phone(user), "Role", frappe.db.get_value("User", user, "full_name"))
		elif row.recipient_type == "Phone":
			add(row.phone_e164 or normalize(row.phone), "Phone")
		elif row.recipient_type == "Report Column" and row.report_column and rows is not None:
			cols = report_render.normalize_columns(columns or [])
			idx = next(
				(
					i
					for i, c in enumerate(cols)
					if c["fieldname"] == row.report_column or c["label"] == row.report_column
				),
				None,
			)
			values: list[Any] = []
			for r in rows:
				v = (
					r.get(row.report_column)
					if isinstance(r, dict)
					else (r[idx] if idx is not None and idx < len(r) else None)
				)
				if v not in (None, "") and v not in values:
					values.append(v)
			for v in values[:MAX_COLUMN_RECIPIENTS]:
				add(normalize(str(v)), "Report Column", column_value=v)
	return out


def _rows_for(recipient: Recipient, rows: list[Any], columns: list[Any], column: str | None) -> list[Any]:
	if recipient.source != "Report Column" or not column:
		return rows
	cols = report_render.normalize_columns(columns)
	idx = next((i for i, c in enumerate(cols) if c["fieldname"] == column or c["label"] == column), None)
	return [
		r
		for r in rows
		if (r.get(column) if isinstance(r, dict) else (r[idx] if idx is not None and idx < len(r) else None))
		== recipient.column_value
	]


# ---- run ---------------------------------------------------------------------------------


def _run_report(alert, filters: dict[str, Any]) -> tuple[list[Any], list[Any]]:
	from frappe.desk.query_report import run

	result = run(alert.report, filters=filters, ignore_prepared_report=True)
	return list(result.get("columns") or []), list(result.get("result") or [])


def run_alert(name: str, *, preview: bool = False) -> AlertRun:
	"""Job (`long`, `wa-alert-{name}`): execute, render, attach, send. `preview=True` renders
	everything and returns it without creating outbound rows or touching counters."""
	alert = frappe.get_doc("WhatsApp Notification Alert", name)
	run = execute(alert, preview=preview)
	if not preview:
		run.next_run_at = alert.compute_next_run()
		values: dict[str, Any] = {"next_run_at": run.next_run_at, "last_error": run.error}
		if run.outbound:
			values.update(
				{"send_count": cint(alert.send_count) + len(run.outbound), "last_sent_at": now_datetime()}
			)
		frappe.db.set_value("WhatsApp Notification Alert", name, values, update_modified=False)
	return run


def execute(alert, *, preview: bool = False, test_phone: str | None = None) -> AlertRun:
	"""Run one alert document — saved or a draft the editor built — and return what it did.
	`preview` renders everything without creating outbound rows. `test_phone` sends to that one
	number only, what the first recipient would receive (their rows, when the recipient is a report
	column). Never touches the alert's counters; `run_alert` does that for a scheduled run."""
	name = alert.name if not alert.is_new() else None
	run = AlertRun(alert=name or alert.alert_name, preview=preview)
	try:
		filters = resolve_filters(alert)
		columns: list[Any] = []
		rows: list[Any] = []
		if alert.content_type == "Report":
			columns, rows = _run_report(alert, filters)
		run.rows, run.columns = len(rows), len(columns)
		recipients = expand_recipients(alert, rows, columns)
		if test_phone:
			first = recipients[0] if recipients else Recipient(phone_e164=test_phone)
			recipients = [
				Recipient(phone_e164=test_phone, source="Test", column_value=first.column_value)
			]
			if first.source == "Report Column":
				recipients[0].source = "Report Column"
		column = next(
			(r.report_column for r in alert.get("recipients") or [] if r.recipient_type == "Report Column"),
			None,
		)
		source = frappe.db.get_value("WhatsApp Template", alert.template, "body") if alert.template else None
		source = source or alert.message
		for recipient in recipients:
			r_rows = _rows_for(recipient, rows, columns, column)
			ctx = templates.context_for(
				None,
				None,
				{
					"rows": r_rows,
					"columns": report_render.normalize_columns(columns),
					"report": alert.report,
					"alert": alert.as_dict(),
					"filters": filters,
					"row_count": len(r_rows),
				},
				doc=frappe._dict(),
				recipient={"phone_e164": recipient.phone_e164, "display_name": recipient.display_name},
			)
			rendered = templates.render(source, ctx)
			body = rendered.text if rendered.ok else _("Report {0}").format(alert.report or alert.alert_name)
			attach: dict[str, Any] = {"message_type": "Text"}
			if preview and alert.content_type == "Report" and alert.attachment_format in ("PDF", "PNG"):
				# a preview names the file it would attach; building it is the run's job
				png = alert.attachment_format == "PNG" and bool(shutil.which(PNG_BINARY))
				attach = {
					"message_type": "Image" if png else "Document",
					"file_name": f"{frappe.scrub(alert.alert_name or 'alert')}.{'png' if png else 'pdf'}",
					"mime_type": "image/png" if png else "application/pdf",
				}
			elif alert.content_type == "Report" and alert.attachment_format in ("PDF", "PNG"):
				html_text = report_render.report_html(columns, r_rows, alert, filters=filters)
				content = report_render.report_png(html_text) if alert.attachment_format == "PNG" else None
				if content:
					file_name, mime, mtype = f"{frappe.scrub(alert.alert_name)}.png", "image/png", "Image"
				else:
					content, file_name, mime, mtype = (
						report_render.report_pdf(html_text, alert),
						f"{frappe.scrub(alert.alert_name)}.pdf",
						"application/pdf",
						"Document",
					)
				if preview:
					attach = {
						"message_type": mtype,
						"file_name": file_name,
						"mime_type": mime,
						"size": len(content),
					}
				else:
					url = attachments.save_private_file(
						content, file_name, ("WhatsApp Notification Alert", name) if name else None
					)
					attach = {
						"message_type": mtype,
						"attachment": url,
						"file_name": file_name,
						"mime_type": mime,
					}
			run.recipients.append(
				{
					"phone_e164": recipient.phone_e164,
					"source": recipient.source,
					"rows": len(r_rows),
					"body": body,
					**{k: v for k, v in attach.items() if k != "attachment"},
				}
			)
			run.body = run.body or body
			if preview:
				continue
			spec = OutboundSpec(
				device=alert.device or None,
				phone=recipient.phone_e164,
				body=body if attach["message_type"] == "Text" else None,
				caption=body if attach["message_type"] != "Text" else None,
				source_type="Notification Alert",
				notification_alert=name,
				display_name=recipient.display_name,
				message_type=attach["message_type"],
				attachment=attach.get("attachment"),
				file_name=attach.get("file_name"),
				mime_type=attach.get("mime_type"),
			)
			outbound = dispatch.create_outbound(spec)
			dispatch.enqueue([outbound], priority=3)
			run.outbound.append(outbound)
			run.attachment = attach.get("attachment") or run.attachment
	except Exception as exc:
		run.error = f"{type(exc).__name__}: {str(exc)[:300]}"
		frappe.log_error(title="WhatsApp alert failed", message=f"alert={name} {type(exc).__name__}")
	return run


def report_columns(report: str, filters: dict[str, Any] | None = None) -> list[dict[str, Any]]:
	"""Column choices for the Report Column recipient type (runs the report with `filters`, or
	none); an unrunnable report yields an empty list."""
	from frappe.desk.query_report import run

	try:
		result = run(report, filters=filters or {}, ignore_prepared_report=True)
	except Exception:
		return []
	return [
		{"fieldname": c["fieldname"], "label": c["label"], "fieldtype": c["fieldtype"]}
		for c in report_render.normalize_columns(result.get("columns") or [])
	]
