# Module role: WhatsApp Notification doc-event sends (D-016, backend-plan §11). The
# `doc_events["*"]` hook returns in microseconds for DocTypes without notifications (per-DocType
# cache), evaluates the condition without ever blocking the document (errors are recorded on the
# notification), and only *enqueues* `send_for_document` after commit. The job re-loads the
# document, re-checks the condition, renders body and attachment, resolves recipients and hands
# each message to the dispatcher at priority 3. Scheduler entry points handle the
# Days/Minutes Before/After events.

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import frappe
from frappe import _
from frappe.utils import add_days, add_to_date, cint, get_datetime, now_datetime, nowdate

from whatsapp_next.exceptions import WANotFoundError, WAValidationError
from whatsapp_next.services import attachments, dispatch, templates
from whatsapp_next.services.dispatch import OutboundSpec
from whatsapp_next.services.guards import field_changed
from whatsapp_next.services.phone import normalize

CACHE_PREFIX = "wa:notif:"
HANDLED_EVENTS = ("validate", "on_update", "on_submit", "on_cancel", "after_insert", "on_change")
EVENT_BY_METHOD = {
	"after_insert": ("New",),
	"on_update": ("Save", "Value Change"),
	"on_change": ("Value Change",),
	"on_submit": ("Submit",),
	"on_cancel": ("Cancel",),
}
SCHEDULED_EVENTS = ("Days Before", "Days After", "Minutes Before", "Minutes After")
BATCH_PER_RUN = 500
OFFSET_WINDOW_MINUTES = 5


@dataclass(frozen=True)
class Recipient:
	phone_e164: str
	display_name: str | None = None
	contact: str | None = None
	source: str = "Fixed Number"


# ---- cache -------------------------------------------------------------------------------


def cache_key(doctype: str) -> str:
	"""Cache key holding the list of enabled notification names for `doctype`."""
	return f"{CACHE_PREFIX}{doctype}"


def active_for(doctype: str) -> list[str]:
	"""Names of enabled WhatsApp Notification rows for `doctype` (cached; empty list cached too)."""
	cached = frappe.cache.get_value(cache_key(doctype))
	if cached is not None:
		return cached
	names: list[str] = []
	if frappe.db.table_exists("WhatsApp Notification"):
		names = frappe.get_all(
			"WhatsApp Notification", filters={"document_type": doctype, "enabled": 1}, pluck="name"
		)
	frappe.cache.set_value(cache_key(doctype), names)
	return names


def clear_cache(doctype: str | None = None) -> None:
	"""Invalidate the per-DocType cache (all DocTypes when `doctype` is None)."""
	if doctype:
		frappe.cache.delete_value(cache_key(doctype))
		return
	frappe.cache.delete_keys(CACHE_PREFIX)


# ---- hook --------------------------------------------------------------------------------


def _record_error(notification: str, error: str) -> None:
	frappe.db.set_value(
		"WhatsApp Notification",
		notification,
		{"last_error": error[:500], "last_error_at": now_datetime()},
		update_modified=False,
	)


def evaluate(notification, doc, event: str) -> bool:
	"""`condition` (Python expression over `doc`) with `frappe.safe_eval`; any failure is stored
	on the notification and counts as False — the document is never blocked."""
	condition = (notification.condition or "").strip()
	if not condition:
		return True
	try:
		return bool(
			frappe.safe_eval(condition, None, {"doc": doc.as_dict() if hasattr(doc, "as_dict") else doc})
		)
	except Exception as exc:
		_record_error(notification.name, f"condition: {type(exc).__name__}: {str(exc)[:200]}")
		frappe.log_error(
			title="WhatsApp notification: condition failed",
			message=f"notification={notification.name} doctype={doc.doctype}",
		)
		return False


def _event_matches(notification, doc, method: str) -> bool:
	events = EVENT_BY_METHOD.get(method, ())
	if notification.event == "Method":
		return (notification.method or "") == method
	if notification.event not in events:
		return False
	if notification.event == "New":
		return True
	if notification.event == "Save":
		return not getattr(doc.flags, "in_insert", False) and not doc.is_new()
	if notification.event == "Value Change":
		field = notification.value_changed
		if not field or getattr(doc.flags, "in_insert", False):
			return False
		before = doc.get_doc_before_save()
		return before is not None and field_changed(before, doc, field)
	return True


def on_doc_event(doc, method: str | None = None) -> None:
	"""`doc_events["*"]` entry point. Returns immediately when nothing is configured for the DocType."""
	if method not in HANDLED_EVENTS:
		return
	if frappe.flags.in_install or frappe.flags.in_migrate or frappe.flags.in_patch:
		return
	if doc.doctype.startswith("WhatsApp ") or (getattr(doc, "flags", None) and doc.flags.in_wa_notification):
		return
	names = active_for(doc.doctype)
	if not names:
		return
	if method == "validate":
		return  # validate is handled only by explicit Method notifications
	for name in names:
		try:
			notification = frappe.get_cached_doc("WhatsApp Notification", name)
		except frappe.DoesNotExistError:
			clear_cache(doc.doctype)
			continue
		if not cint(notification.enabled) or notification.event in SCHEDULED_EVENTS:
			continue
		if not _event_matches(notification, doc, method):
			continue
		if not evaluate(notification, doc, notification.event):
			continue
		frappe.enqueue(
			"whatsapp_next.services.notifications.send_for_document",
			notification=name,
			doctype=doc.doctype,
			name=doc.name,
			event=notification.event,
			queue="short",
			job_id=f"wa-notif-{name}-{doc.name}-{notification.event}",
			deduplicate=True,
			enqueue_after_commit=True,
			timeout=120,
		)


# ---- recipients ---------------------------------------------------------------------------


def _contact_primary_phone(contact: str | None) -> str | None:
	if not contact:
		return None
	from whatsapp_next.services.permissions import contact_phones

	phones = contact_phones(contact)
	return phones[0] if phones else None


def _phone_from_field(doc, fieldname: str | None) -> tuple[str | None, str | None]:
	"""`(phone_e164, contact)` from a phone field, a Link-to-Contact field, or a Link to a
	document that has a `contact`/`mobile_no` field."""
	if not fieldname:
		return None, None
	value = doc.get(fieldname)
	if not value:
		return None, None
	df = doc.meta.get_field(fieldname)
	if df and df.fieldtype in ("Link", "Dynamic Link"):
		target = df.options if df.fieldtype == "Link" else doc.get(df.options)
		if target == "Contact":
			return _contact_primary_phone(value), value
		if target and frappe.db.exists("DocType", target):
			meta = frappe.get_meta(target)
			for f in ("mobile_no", "phone", "whatsapp_no", "contact_mobile", "phone_no"):
				if meta.has_field(f):
					v = frappe.db.get_value(target, value, f)
					if v and normalize(v):
						return normalize(v), None
			if meta.has_field("contact"):
				c = frappe.db.get_value(target, value, "contact")
				return _contact_primary_phone(c), c
		return None, None
	return normalize(str(value)), None


def resolve_recipients(notification, doc) -> list[Recipient]:
	"""Recipients per row type (row `condition` honoured); invalid numbers are skipped and the
	last one is recorded on the notification. De-duplicated on `phone_e164`."""
	out: list[Recipient] = []
	seen: set[str] = set()
	errors: list[str] = []
	for row in notification.get("recipients") or []:
		if row.condition and not evaluate(
			frappe._dict(name=notification.name, condition=row.condition), doc, "recipient"
		):
			continue
		phone = contact = None
		if row.recipient_type == "Document Field":
			phone, contact = _phone_from_field(doc, row.receiver_by_document_field)
		elif row.recipient_type == "Linked Document Field":
			linked = doc.get(row.linked_document_field) if row.linked_document_field else None
			df = doc.meta.get_field(row.linked_document_field) if row.linked_document_field else None
			if (
				linked
				and df
				and df.fieldtype == "Link"
				and row.linked_mobile_fieldname
				and frappe.get_meta(df.options).has_field(row.linked_mobile_fieldname)
			):
				phone = normalize(frappe.db.get_value(df.options, linked, row.linked_mobile_fieldname))
		elif row.recipient_type == "Fixed Number":
			phone = row.phone_e164 or normalize(row.phone)
		if not phone:
			errors.append(f"row {row.idx}: no valid number")
			continue
		if phone in seen:
			continue
		seen.add(phone)
		out.append(
			Recipient(
				phone_e164=phone,
				contact=contact,
				source=row.recipient_type,
				display_name=frappe.db.get_value("Contact", contact, "full_name") if contact else None,
			)
		)
	if errors:
		_record_error(notification.name, "; ".join(errors))
	return out


# ---- job -----------------------------------------------------------------------------------


def _body(notification, ctx: dict[str, Any]) -> tuple[str | None, str | None]:
	source = None
	if notification.template:
		source = frappe.db.get_value("WhatsApp Template", notification.template, "body")
	if not source:
		source = notification.message
	result = templates.render(source, ctx)
	return (result.text if result.ok else None), result.error


def _attachment(notification, doc) -> dict[str, Any]:
	if cint(notification.attach_print):
		pdf = attachments.render_print_pdf(
			doc.doctype,
			doc.name,
			print_format=notification.print_format or None,
			letter_head=notification.letter_head or None,
			file_name=doc.name,
		)
		url = attachments.save_private_file(pdf.content, pdf.file_name, (doc.doctype, doc.name))
		return {
			"message_type": "Document",
			"attachment": url,
			"file_name": pdf.file_name,
			"mime_type": pdf.mime_type,
		}
	if notification.attach_field and doc.get(notification.attach_field):
		url = doc.get(notification.attach_field)
		meta = attachments.file_meta(url)
		return {
			"message_type": notification.message_type
			if notification.message_type in ("Document", "Image")
			else "Document",
			"attachment": url,
			"file_name": meta["file_name"],
			"mime_type": meta["mime_type"],
		}
	return {"message_type": "Text"}


def send_for_document(notification: str, doctype: str, name: str, event: str) -> dict[str, Any]:
	"""Job (`short`): re-load, re-check the condition, render, attach, resolve recipients and
	queue one outbound per recipient at priority 3. Returns `{sent, skipped, error}`."""
	notif = frappe.get_doc("WhatsApp Notification", notification)
	if not cint(notif.enabled) or not frappe.db.exists(doctype, name):
		return {"sent": 0, "skipped": 1, "error": None}
	doc = frappe.get_doc(doctype, name)
	doc.flags.in_wa_notification = True
	if not evaluate(notif, doc, event):
		return {"sent": 0, "skipped": 1, "error": None}
	ctx = templates.context_for(doctype, name, {"event": event, "notification": notif.name}, doc=doc)
	body, render_error = _body(notif, ctx)
	if render_error or not (body or "").strip():
		_record_error(notification, f"template: {render_error or 'empty body'}")
		return {"sent": 0, "skipped": 1, "error": render_error or "empty body"}
	try:
		attach = _attachment(notif, doc)
	except Exception as exc:
		_record_error(notification, f"attachment: {type(exc).__name__}: {str(exc)[:200]}")
		return {"sent": 0, "skipped": 1, "error": str(exc)[:200]}
	recipients = resolve_recipients(notif, doc)
	sent = 0
	last_error = None
	outbounds: list[str] = []
	for r in recipients:
		ctx["recipient"] = frappe._dict(
			phone_e164=r.phone_e164, display_name=r.display_name, contact=r.contact
		)
		spec = OutboundSpec(
			device=notif.device or None,
			phone=r.phone_e164,
			body=body if attach["message_type"] == "Text" else None,
			caption=body if attach["message_type"] != "Text" else None,
			source_type="Notification",
			notification=notif.name,
			reference_doctype=doctype,
			reference_name=name,
			display_name=r.display_name,
			contact=r.contact,
			**{k: v for k, v in attach.items()},
		)
		try:
			outbound = dispatch.create_outbound(spec)
			dispatch.enqueue([outbound], priority=3)
			outbounds.append(outbound)
			sent += 1
		except Exception as exc:
			last_error = f"{type(exc).__name__}: {str(exc)[:200]}"
	if notif.set_property_after_alert and sent:
		try:
			frappe.db.set_value(
				doctype, name, notif.set_property_after_alert, notif.property_value, update_modified=False
			)
		except Exception as exc:
			last_error = f"set_property: {str(exc)[:200]}"
	values: dict[str, Any] = {"send_count": cint(notif.send_count) + sent}
	if sent:
		values["last_sent_at"] = now_datetime()
	if last_error:
		values.update({"last_error": last_error[:500], "last_error_at": now_datetime()})
	frappe.db.set_value("WhatsApp Notification", notification, values, update_modified=False)
	return {"sent": sent, "skipped": len(recipients) - sent, "error": last_error, "outbounds": outbounds}


# ---- editor helpers (api.v1.notifications) -------------------------------------------------

_FIELD_EXCLUDED_TYPES = frozenset(
	{
		"Section Break",
		"Column Break",
		"Tab Break",
		"HTML",
		"Button",
		"Fold",
		"Heading",
		"Table",
		"Table MultiSelect",
	}
)
_PHONE_FIELD_RE = ("phone", "mobile", "whatsapp", "contact_no")


def document_fields(document_type: str) -> dict[str, list[dict[str, Any]]]:
	"""Field choices for the Notification editor selects: `{date_fields, datetime_fields,
	phone_fields, link_fields, all_fields}` as `{fieldname, label, fieldtype, options}` rows."""
	if not frappe.db.exists("DocType", document_type):
		frappe.throw(_("DocType {0} not found").format(document_type), WAValidationError)
	meta = frappe.get_meta(document_type)
	out: dict[str, list[dict[str, Any]]] = {
		"date_fields": [],
		"datetime_fields": [],
		"phone_fields": [],
		"link_fields": [],
		"all_fields": [],
	}
	for df in meta.fields:
		if df.fieldtype in _FIELD_EXCLUDED_TYPES or not df.fieldname:
			continue
		row = {
			"fieldname": df.fieldname,
			"label": df.label or df.fieldname,
			"fieldtype": df.fieldtype,
			"options": df.options if df.fieldtype in ("Link", "Dynamic Link") else None,
		}
		out["all_fields"].append(row)
		if df.fieldtype == "Date":
			out["date_fields"].append(row)
		elif df.fieldtype == "Datetime":
			out["datetime_fields"].append(row)
		elif df.fieldtype in ("Link", "Dynamic Link"):
			out["link_fields"].append(row)
		if df.fieldtype in ("Data", "Phone") and (
			df.options == "Phone" or any(k in df.fieldname.lower() for k in _PHONE_FIELD_RE)
		):
			out["phone_fields"].append(row)
	return out


def preview_for_document(notification: str, reference_name: str) -> dict[str, Any]:
	"""Dry evaluation of one notification against one document: condition, rendered body and
	the resolved recipients (phones masked). Nothing is sent or queued."""
	from whatsapp_next.services.phone import mask

	notif = frappe.get_doc("WhatsApp Notification", notification)
	errors: list[str] = []
	if not frappe.db.exists(notif.document_type, reference_name):
		frappe.throw(_("{0} {1} not found").format(_(notif.document_type), reference_name), WANotFoundError)
	doc = frappe.get_doc(notif.document_type, reference_name)
	meets = evaluate(notif, doc, notif.event)
	recipients = resolve_recipients(notif, doc)
	ctx = templates.context_for(
		notif.document_type, reference_name, {"event": notif.event, "notification": notif.name}, doc=doc
	)
	if recipients:  # render as the job would for the first recipient
		first = recipients[0]
		ctx["recipient"] = frappe._dict(
			phone_e164=first.phone_e164, display_name=first.display_name, contact=first.contact
		)
	body, render_error = _body(notif, ctx)
	if render_error:
		errors.append(f"template: {render_error}")
	last_error = frappe.db.get_value("WhatsApp Notification", notification, "last_error")
	if last_error and last_error.startswith(("condition:", "row ")):
		errors.append(last_error)
	return {
		"meets_condition": bool(meets),
		"message": body or "",
		"recipients": [{"phone_e164": mask(r.phone_e164), "source": r.source} for r in recipients],
		"errors": errors,
	}


# ---- scheduled events ----------------------------------------------------------------------


def documents_due(notification) -> list[str]:
	"""Names of documents whose date / datetime field hits the notification's offset now."""
	doctype = notification.document_type
	if notification.event in ("Days Before", "Days After"):
		field = notification.date_changed
		if not field:
			return []
		delta = cint(notification.days_in_advance) * (1 if notification.event == "Days Before" else -1)
		target = add_days(nowdate(), delta)
		filters = {field: target}
	else:
		field = notification.datetime_changed
		if not field:
			return []
		offset = cint(notification.minutes_offset) * (1 if notification.event == "Minutes Before" else -1)
		upper = add_to_date(now_datetime(), minutes=offset)
		lower = add_to_date(upper, minutes=-OFFSET_WINDOW_MINUTES)
		filters = {field: ("between", [get_datetime(lower), get_datetime(upper)])}
	if frappe.get_meta(doctype).is_submittable:
		filters["docstatus"] = 1
	return frappe.get_all(
		doctype, filters=filters, pluck="name", limit=BATCH_PER_RUN, ignore_permissions=True
	)


def _trigger(events: tuple[str, ...]) -> int:
	n = 0
	for row in frappe.get_all(
		"WhatsApp Notification", filters={"enabled": 1, "event": ("in", list(events))}, pluck="name"
	):
		notif = frappe.get_cached_doc("WhatsApp Notification", row)
		for name in documents_due(notif):
			frappe.enqueue(
				"whatsapp_next.services.notifications.send_for_document",
				notification=notif.name,
				doctype=notif.document_type,
				name=name,
				event=notif.event,
				queue="short",
				job_id=f"wa-notif-{notif.name}-{name}-{notif.event}",
				deduplicate=True,
				timeout=120,
			)
			n += 1
	return n


def trigger_daily() -> int:
	"""Scheduler `daily`: Days Before / Days After."""
	return _trigger(("Days Before", "Days After"))


def trigger_offset() -> int:
	"""Cron `*/5`: Minutes Before / Minutes After."""
	return _trigger(("Minutes Before", "Minutes After"))
