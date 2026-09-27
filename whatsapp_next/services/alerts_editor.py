# Module role: the notification alert editor (D-139) — what `sanad.ui.AlertEditor` opens with,
# saves and deletes, plus the live preview of the unsaved draft and the test send to one number.
# The controller keeps every rule (content, schedule, JSON, recipients, next run); this module maps
# an allow-listed payload onto the document and runs it through `alerts.execute`. The API layer
# (`api/v1/alerts.py`) only checks the role and calls in here.

from __future__ import annotations

import json
import shutil
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, now_datetime

from whatsapp_next.exceptions import WANotFoundError, WAValidationError
from whatsapp_next.services import alerts, alerts_dates, audit
from whatsapp_next.services.phone import normalize
from whatsapp_next.whatsapp_next.doctype.whatsapp_notification_alert.whatsapp_notification_alert import _as_time

DOCTYPE = "WhatsApp Notification Alert"

# the only fields a payload may carry — never a client fieldname beyond these
FIELDS: tuple[str, ...] = (
	"alert_name",
	"enabled",
	"periodicity",
	"day_of_week",
	"day_of_month",
	"month_of_year",
	"notification_time",
	"content_type",
	"report",
	"filters_json",
	"dynamic_filters_json",
	"template",
	"message",
	"attachment_format",
	"print_format",
	"letter_head",
	"language",
	"device",
)
RECIPIENT_FIELDS: tuple[str, ...] = ("recipient_type", "user", "role", "phone", "report_column")
STAT_FIELDS: tuple[str, ...] = ("send_count", "last_sent_at", "next_run_at", "last_error")
PAYLOAD_KEYS = frozenset({"name", *FIELDS, "recipients"})
NEXT_RUNS = 3
RECENT_SENDS = 5

# what a message body may use — the context `alerts.execute` renders with
VARIABLES: tuple[tuple[str, str], ...] = (
	("{{ row_count }}", "Rows in the report"),
	("{{ report }}", "Report name"),
	("{{ alert.alert_name }}", "Alert name"),
	("{{ frappe.utils.nowdate() }}", "Today's date"),
	("{% for r in rows %}{{ loop.index }}. {{ r }}\n{% endfor %}", "One line per row"),
)


# ---- reads ---------------------------------------------------------------------------------


def _get(name: str):
	if not frappe.db.exists(DOCTYPE, name):
		frappe.throw(_("Notification alert {0} not found").format(name), WANotFoundError)
	return frappe.get_doc(DOCTYPE, name)


def _meta_options(fieldname: str) -> list[str]:
	df = frappe.get_meta(DOCTYPE).get_field(fieldname)
	return [o for o in (df.options or "").split("\n") if o] if df else []


def _values(doc) -> dict[str, Any]:
	out = {f: doc.get(f) for f in FIELDS}
	out["notification_time"] = _as_time(doc.notification_time).strftime("%H:%M") if doc.notification_time else None
	out["recipients"] = [
		{f: row.get(f) for f in (*RECIPIENT_FIELDS, "phone_e164")} for row in doc.get("recipients") or []
	]
	return out


def editor(name: str | None = None) -> dict[str, Any]:
	"""Everything the editor opens with: `{alert, stats, options, devices[], templates[], tokens[],
	variables[], recent[], png_available, me{phone}}` — the alert (defaults for a new one), what it
	has done, the choices every control offers and the sends it made last. E: `WANotFoundError`."""
	if name:
		doc = _get(name)
		doc.check_permission("read")
		alert = {"name": doc.name, **_values(doc)}
		stats = {f: doc.get(f) for f in STAT_FIELDS}
		recent = frappe.get_all(
			"WhatsApp Log",
			filters={"notification_alert": doc.name},
			fields=["name", "phone_e164", "display_name", "status", "message_type", "creation"],
			order_by="creation desc",
			limit=RECENT_SENDS,
		)
	else:
		frappe.has_permission(DOCTYPE, "create", throw=True)
		alert = {
			"name": None,
			"alert_name": "",
			"enabled": 1,
			"periodicity": "Daily",
			"day_of_week": "Sunday",
			"day_of_month": 1,
			"month_of_year": "January",
			"notification_time": "08:00",
			"content_type": "Report",
			"report": None,
			"filters_json": None,
			"dynamic_filters_json": None,
			"template": None,
			"message": _("{{ report }}: {{ row_count }} rows"),
			"attachment_format": "PDF",
			"print_format": None,
			"letter_head": None,
			"language": None,
			"device": frappe.db.get_value("WhatsApp Device", {"is_default": 1, "disabled": 0}, "name"),
			"recipients": [],
		}
		stats, recent = {}, []
	devices = frappe.get_all(
		"WhatsApp Device",
		filters={"disabled": 0},
		fields=["name", "device_name", "phone_e164", "status", "is_default"],
		order_by="is_default desc, device_name asc",
	)
	templates = frappe.get_all(
		"WhatsApp Template",
		filters={"disabled": 0},
		fields=["name", "template_name", "category"],
		order_by="template_name asc",
		limit=200,
	)
	me = frappe.db.get_value("User", frappe.session.user, ["mobile_no", "phone"], as_dict=True) or {}
	return {
		"alert": alert,
		"stats": stats,
		"recent": recent,
		"options": {
			"periodicity": _meta_options("periodicity"),
			"day_of_week": _meta_options("day_of_week"),
			"month_of_year": _meta_options("month_of_year"),
			"content_type": _meta_options("content_type"),
			"attachment_format": _meta_options("attachment_format"),
			"recipient_type": _meta_options_child("recipient_type"),
		},
		"devices": devices,
		"templates": templates,
		"tokens": [
			{"name": t, "example": str(alerts_dates.resolve(t.replace(":N", ":7")))} for t in alerts_dates.TOKENS
		],
		"variables": [{"code": code, "label": _(label)} for code, label in VARIABLES],
		"png_available": bool(shutil.which(alerts.PNG_BINARY)),
		"me": {"phone": normalize(me.get("mobile_no")) or normalize(me.get("phone"))},
		"can_write": bool(frappe.has_permission(DOCTYPE, "write")),
		"can_delete": bool(name and frappe.has_permission(DOCTYPE, "delete", name)),
	}


def _meta_options_child(fieldname: str) -> list[str]:
	df = frappe.get_meta("WhatsApp Notification Alert Recipient").get_field(fieldname)
	return [o for o in (df.options or "").split("\n") if o] if df else []


# ---- the draft -----------------------------------------------------------------------------


def _json_text(value: Any) -> str | None:
	if value in (None, "", {}, []):
		return None
	if isinstance(value, str):
		return value
	return json.dumps(value, ensure_ascii=False)


def _apply(doc, payload: dict) -> None:
	unknown = sorted(set(payload) - PAYLOAD_KEYS)
	if unknown:
		frappe.throw(_("Unknown payload keys: {0}").format(", ".join(unknown)), WAValidationError)
	for f in FIELDS:
		if f not in payload:
			continue
		value = payload[f]
		if f in ("filters_json", "dynamic_filters_json"):
			value = _json_text(value)
		elif f in ("enabled", "day_of_month"):
			value = cint(value)
		elif isinstance(value, str):
			value = value.strip() or None if f != "message" else value
		doc.set(f, value)
	if doc.alert_name:
		doc.alert_name = doc.alert_name.strip()
	if "recipients" in payload:
		rows = payload.get("recipients") or []
		if not isinstance(rows, list):
			frappe.throw(_("recipients must be a list"), WAValidationError)
		doc.set("recipients", [])
		for row in rows:
			if not isinstance(row, dict):
				continue
			doc.append("recipients", {f: row.get(f) for f in RECIPIENT_FIELDS if row.get(f) not in (None, "")})


def _draft(payload: dict):
	"""The editor's alert as an unsaved document: the saved one with the payload over it, or new."""
	if not isinstance(payload, dict):
		frappe.throw(_("payload must be an object"), WAValidationError)
	name = payload.get("name")
	# a saved alert is loaded and changed in memory only — nothing here calls save
	doc = _get(name) if name else frappe.new_doc(DOCTYPE)
	_apply(doc, payload)
	return doc


def _problem(doc) -> str | None:
	"""The first rule the draft breaks, in words, or None — the controller's own validation."""
	queued = len(frappe.local.message_log or [])
	try:
		doc.run_method("validate")
	except frappe.ValidationError as exc:
		return str(exc) or _("Check the alert")
	finally:
		if frappe.local.message_log:
			del frappe.local.message_log[queued:]
	return None


def _next_runs(doc) -> list[str]:
	"""The next three occurrences, or none while the schedule is incomplete."""
	try:
		at, out = now_datetime(), []
		for _i in range(NEXT_RUNS):
			at = doc.compute_next_run(at)
			out.append(str(at))
		return out
	except Exception:
		return []


def preview(payload: dict) -> dict[str, Any]:
	"""Run the draft — saved or not — without sending: `{problem, next_runs[], row_count, columns[],
	recipients[{phone_e164, source, rows}], recipients_count, message, attachment{file_name,
	mime_type, message_type}, error}`. Nothing is saved, nothing is sent."""
	doc = _draft(payload)
	problem = _problem(doc)
	out: dict[str, Any] = {"problem": problem, "next_runs": _next_runs(doc)}
	if doc.content_type == "Report" and not doc.report:
		out.update({"row_count": 0, "recipients": [], "recipients_count": 0, "message": None})
		return out
	queued = len(frappe.local.message_log or [])
	try:
		run = alerts.execute(doc, preview=True)
	finally:
		if frappe.local.message_log:
			del frappe.local.message_log[queued:]
	first = run.recipients[0] if run.recipients else {}
	out.update(
		{
			"row_count": run.rows,
			"column_count": run.columns,
			"recipients": [
				{k: r.get(k) for k in ("phone_e164", "source", "rows")} for r in run.recipients[:50]
			],
			"recipients_count": len(run.recipients),
			"message": run.body,
			"attachment": {k: first.get(k) for k in ("file_name", "mime_type", "message_type")}
			if first.get("file_name")
			else None,
			"error": run.error,
		}
	)
	return out


def send_test(payload: dict, phone: str) -> dict[str, Any]:
	"""Send the draft once to `phone` — what its first recipient would receive — and nothing else:
	no counters, no schedule. Audited `Alert Test Sent`. Returns `{outbound, phone_e164, error}`."""
	phone_e164 = normalize(phone)
	if not phone_e164:
		frappe.throw(_("Enter a valid phone number"), WAValidationError)
	doc = _draft(payload)
	problem = _problem(doc)
	if problem and not doc.get("recipients"):
		# a test needs no recipients of its own: the number is the recipient
		doc.append("recipients", {"recipient_type": "Phone", "phone": phone_e164})
		problem = _problem(doc)
	if problem:
		frappe.throw(problem, WAValidationError)
	run = alerts.execute(doc, test_phone=phone_e164)
	if run.error:
		if "wkhtmlto" in run.error:
			frappe.throw(
				_("The report file could not be built: wkhtmltopdf is not installed on the server. Send the test with \"No file\", or install it."),
				WAValidationError,
			)
		frappe.throw(_("The test could not be sent: {0}").format(run.error), WAValidationError)
	audit.log(
		"Alert Test Sent",
		reference=(DOCTYPE, doc.name) if not doc.is_new() else None,
		details={"alert": doc.alert_name, "message_type": (run.recipients or [{}])[0].get("message_type")},
		count=len(run.outbound),
	)
	return {"outbound": run.outbound[0] if run.outbound else None, "phone_e164": phone_e164, "error": None}


# ---- writes --------------------------------------------------------------------------------


def save(payload: dict) -> dict[str, Any]:
	"""Create or update the alert from the payload; a changed name renames it. Returns
	`{name, next_run_at}`. The controller validates everything."""
	if not isinstance(payload, dict):
		frappe.throw(_("payload must be an object"), WAValidationError)
	name = payload.get("name")
	if name:
		doc = _get(name)
		doc.check_permission("write")
		new_name = (payload.get("alert_name") or "").strip()
		_apply(doc, payload)
		doc.save()
		if new_name and new_name != doc.name:
			if frappe.db.exists(DOCTYPE, new_name):
				frappe.throw(_("An alert named {0} already exists").format(new_name), WAValidationError)
			doc.name = frappe.rename_doc(DOCTYPE, doc.name, new_name, force=True)
	else:
		frappe.has_permission(DOCTYPE, "create", throw=True)
		doc = frappe.new_doc(DOCTYPE)
		_apply(doc, payload)
		if doc.alert_name and frappe.db.exists(DOCTYPE, doc.alert_name):
			frappe.throw(_("An alert named {0} already exists").format(doc.alert_name), WAValidationError)
		doc.insert()
	return {"name": doc.name, "next_run_at": frappe.db.get_value(DOCTYPE, doc.name, "next_run_at")}


def set_enabled(name: str, enabled: int) -> dict[str, Any]:
	"""Switch the alert on or off; `next_run_at` is recomputed by the controller."""
	doc = _get(name)
	doc.check_permission("write")
	doc.enabled = 1 if cint(enabled) else 0
	doc.save()
	return {"name": doc.name, "enabled": doc.enabled, "next_run_at": doc.next_run_at}


def delete(name: str) -> None:
	"""Delete the alert (its sent messages stay in the log)."""
	doc = _get(name)
	doc.check_permission("delete")
	frappe.delete_doc(DOCTYPE, doc.name)


# ---- pickers -------------------------------------------------------------------------------


def search(kind: str, txt: str | None = None) -> list[dict[str, Any]]:
	"""The editor's pickers: `report`, `user`, `role`, `print_format`, `letter_head`, `language` —
	`[{value, label, description}]`, through `frappe.get_list` so the caller's permissions apply."""
	txt = (txt or "").strip()
	like = ("like", f"%{txt}%") if txt else None
	if kind == "report":
		rows = frappe.get_list(
			"Report",
			filters={"disabled": 0, **({"name": like} if like else {})},
			fields=["name", "ref_doctype", "report_type"],
			order_by="name asc",
			limit_page_length=20,
		)
		return [{"value": r.name, "label": _(r.name), "description": f"{_(r.ref_doctype)} · {_(r.report_type)}"} for r in rows]
	if kind == "user":
		or_filters = {"full_name": like, "name": like, "mobile_no": like} if like else None
		rows = frappe.get_list(
			"User",
			filters={"enabled": 1, "user_type": "System User"},
			or_filters=or_filters,
			fields=["name", "full_name", "mobile_no"],
			order_by="full_name asc",
			limit_page_length=20,
		)
		return [
			{"value": r.name, "label": r.full_name or r.name, "description": r.mobile_no or _("No mobile number")}
			for r in rows
		]
	if kind == "role":
		rows = frappe.get_list(
			"Role",
			filters={"disabled": 0, "desk_access": 1, **({"name": like} if like else {})},
			fields=["name"],
			order_by="name asc",
			limit_page_length=20,
		)
		return [{"value": r.name, "label": _(r.name), "description": None} for r in rows]
	if kind in ("print_format", "letter_head", "language"):
		doctype, field = {
			"print_format": ("Print Format", "name"),
			"letter_head": ("Letter Head", "name"),
			"language": ("Language", "language_name"),
		}[kind]
		filters: dict[str, Any] = {}
		if kind == "print_format":
			filters["disabled"] = 0
		if kind == "letter_head":
			filters["disabled"] = 0
		or_filters = {"name": like, field: like} if like else None
		rows = frappe.get_list(
			doctype, filters=filters, or_filters=or_filters, fields=list({"name", field}), limit_page_length=20
		)
		return [{"value": r.name, "label": r.get(field) or r.name, "description": None} for r in rows]
	frappe.throw(_("Unknown picker {0}").format(kind), WAValidationError)

