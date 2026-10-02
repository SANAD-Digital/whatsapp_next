# Module role: the notification editor window — what `sanad.ui.NotificationEditor` opens with,
# saves and deletes, plus the live preview of the unsaved draft against one document and the test
# send to one number. The controller keeps every rule (document type, body source, method
# allow-list, condition, recipients); this module maps an allow-listed payload onto the document
# and evaluates it with the same helpers the doc-event job uses (`services/notifications.py`). The
# API layer (`api/v1/notifications.py`) only checks the role and calls in here.

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint

from whatsapp_next.exceptions import WANotFoundError, WAValidationError
from whatsapp_next.services import audit, dispatch, notifications, templates
from whatsapp_next.services.dispatch import OutboundSpec
from whatsapp_next.services.phone import mask, normalize
from whatsapp_next.whatsapp_next.doctype.whatsapp_notification.whatsapp_notification import ALLOWED_METHODS

DOCTYPE = "WhatsApp Notification"
RECIPIENT_DOCTYPE = "WhatsApp Notification Recipient"

# the only fields a payload may carry — never a client fieldname beyond these
FIELDS: tuple[str, ...] = (
	"notification_name",
	"enabled",
	"document_type",
	"event",
	"date_changed",
	"days_in_advance",
	"datetime_changed",
	"minutes_offset",
	"value_changed",
	"method",
	"condition_type",
	"filters",
	"condition",
	"device",
	"template",
	"message",
	"message_type",
	"attach_print",
	"print_format",
	"letter_head",
	"attach_field",
	"set_property_after_alert",
	"property_value",
)
INT_FIELDS = frozenset({"enabled", "days_in_advance", "minutes_offset", "attach_print"})
RECIPIENT_FIELDS: tuple[str, ...] = (
	"recipient_type",
	"receiver_by_document_field",
	"linked_document_field",
	"linked_mobile_fieldname",
	"phone",
	"condition",
)
STAT_FIELDS: tuple[str, ...] = ("send_count", "last_sent_at", "last_error", "last_error_at", "variables_count")
PAYLOAD_KEYS = frozenset({"name", *FIELDS, "recipients"})
RECENT_SENDS = 5


# ---- reads ---------------------------------------------------------------------------------


def _get(name: str):
	if not frappe.db.exists(DOCTYPE, name):
		frappe.throw(_("Notification {0} not found").format(name), WANotFoundError)
	return frappe.get_doc(DOCTYPE, name)


def _options(doctype: str, fieldname: str) -> list[str]:
	df = frappe.get_meta(doctype).get_field(fieldname)
	return [o for o in (df.options or "").split("\n") if o] if df else []


def _values(doc) -> dict[str, Any]:
	out = {f: doc.get(f) for f in FIELDS}
	out["recipients"] = [
		{f: row.get(f) for f in (*RECIPIENT_FIELDS, "phone_e164")} for row in doc.get("recipients") or []
	]
	return out


def templates_for(document_type: str | None = None) -> list[dict[str, Any]]:
	"""Enabled templates a notification on `document_type` can use: the ones written for that
	document type first, then the ones written for none. `[{name, template_name, category,
	reference_doctype, message_type, body}]` — the body cut to a preview."""
	filters: dict[str, Any] = {"disabled": 0}
	rows = frappe.get_list(
		"WhatsApp Template",
		filters=filters,
		fields=["name", "template_name", "category", "reference_doctype", "message_type", "body"],
		order_by="modified desc",
		limit_page_length=200,
	)
	rows = [r for r in rows if not r.reference_doctype or not document_type or r.reference_doctype == document_type]
	rows.sort(key=lambda r: (0 if document_type and r.reference_doctype == document_type else 1))
	for r in rows:
		r.body = (r.body or "")[:280]
	return rows


def editor(name: str | None = None) -> dict[str, Any]:
	"""Everything the window opens with: `{notification, stats, recent[], options, devices[],
	templates[], fields, me{phone}, can_write, can_delete}` — the notification (defaults for a new
	one), what it has done, the choices every control offers, the document type's fields and the
	templates it can use. E: `WANotFoundError`."""
	if name:
		doc = _get(name)
		doc.check_permission("read")
		notification = {"name": doc.name, **_values(doc)}
		stats = {f: doc.get(f) for f in STAT_FIELDS}
		recent = frappe.get_all(
			"WhatsApp Log",
			filters={"notification": doc.name},
			fields=["name", "phone_e164", "display_name", "status", "reference_name", "creation"],
			order_by="creation desc",
			limit=RECENT_SENDS,
		)
	else:
		frappe.has_permission(DOCTYPE, "create", throw=True)
		notification = {f: None for f in FIELDS}
		notification.update(
			{
				"name": None,
				"notification_name": "",
				"enabled": 1,
				"event": "Submit",
				"condition_type": "Filters",
				"message_type": "Text",
				"attach_print": 0,
				"days_in_advance": 1,
				"minutes_offset": 30,
				"device": frappe.db.get_value("WhatsApp Device", {"is_default": 1, "disabled": 0}, "name"),
				"recipients": [],
			}
		)
		stats, recent = {}, []
	devices = frappe.get_all(
		"WhatsApp Device",
		filters={"disabled": 0},
		fields=["name", "device_name", "phone_e164", "status", "is_default"],
		order_by="is_default desc, device_name asc",
	)
	me = frappe.db.get_value("User", frappe.session.user, ["mobile_no", "phone"], as_dict=True) or {}
	dt = notification.get("document_type")
	return {
		"notification": notification,
		"stats": stats,
		"recent": recent,
		"options": {
			"event": _options(DOCTYPE, "event"),
			"message_type": _options(DOCTYPE, "message_type"),
			"recipient_type": _options(RECIPIENT_DOCTYPE, "recipient_type"),
			"method": list(ALLOWED_METHODS),
		},
		"devices": devices,
		"templates": templates_for(dt),
		"fields": notifications.document_fields(dt) if dt and frappe.db.exists("DocType", dt) else None,
		"me": {"phone": normalize(me.get("mobile_no")) or normalize(me.get("phone"))},
		"can_write": bool(frappe.has_permission(DOCTYPE, "write")),
		"can_delete": bool(name and frappe.has_permission(DOCTYPE, "delete", name)),
	}


def document_setup(document_type: str) -> dict[str, Any]:
	"""What changes with the document type: its fields and the templates it can use."""
	if not frappe.db.exists("DocType", document_type):
		frappe.throw(_("DocType {0} not found").format(document_type), WAValidationError)
	return {"fields": notifications.document_fields(document_type), "templates": templates_for(document_type)}


# ---- the draft -----------------------------------------------------------------------------


def _apply(doc, payload: dict) -> None:
	unknown = sorted(set(payload) - PAYLOAD_KEYS)
	if unknown:
		frappe.throw(_("Unknown payload keys: {0}").format(", ".join(unknown)), WAValidationError)
	for f in FIELDS:
		if f not in payload:
			continue
		value = payload[f]
		if f in INT_FIELDS:
			value = cint(value)
		elif f == "filters":
			# the editor sends Frappe's filter list; the field stores it as JSON text
			value = json.dumps(value) if isinstance(value, list) and value else (value or None) if isinstance(value, str) else None
		elif isinstance(value, str) and f not in ("message", "condition"):
			value = value.strip() or None
		doc.set(f, value)
	if doc.notification_name:
		doc.notification_name = doc.notification_name.strip()
	if "recipients" in payload:
		rows = payload.get("recipients") or []
		if not isinstance(rows, list):
			frappe.throw(_("recipients must be a list"), WAValidationError)
		doc.set("recipients", [])
		for row in rows:
			if isinstance(row, dict):
				doc.append("recipients", {f: row.get(f) for f in RECIPIENT_FIELDS if row.get(f) not in (None, "")})


def _draft(payload: dict):
	"""The editor's notification as an unsaved document: the saved one with the payload over it, or new."""
	if not isinstance(payload, dict):
		frappe.throw(_("payload must be an object"), WAValidationError)
	name = payload.get("name")
	# a saved notification is loaded and changed in memory only — nothing here calls save
	doc = _get(name) if name else frappe.new_doc(DOCTYPE)
	_apply(doc, payload)
	return doc


def _problem(doc) -> str | None:
	"""The first rule the draft breaks, in words, or None — the controller's own validation."""
	queued = len(frappe.local.message_log or [])
	try:
		doc.run_method("validate")
	except frappe.ValidationError as exc:
		return str(exc) or _("Check the notification")
	finally:
		if frappe.local.message_log:
			del frappe.local.message_log[queued:]
	return None


def _document(doc, reference_name: str | None):
	"""The record the draft is tried on — the one asked for (read-checked), else the latest."""
	dt = doc.document_type
	if not dt or not frappe.db.exists("DocType", dt):
		return None
	if not reference_name:
		if not frappe.has_permission(dt, "read"):
			return None
		rows = frappe.get_list(dt, fields=["name"], order_by="modified desc", limit_page_length=1)
		reference_name = rows[0].name if rows else None
	if not reference_name or not frappe.db.exists(dt, reference_name):
		return None
	frappe.has_permission(dt, "read", reference_name, throw=True)
	return frappe.get_doc(dt, reference_name)


def _render(notif, doc) -> dict[str, Any]:
	"""Condition, recipients and body of the draft for one record — as the job would send it."""
	queued = len(frappe.local.message_log or [])
	problems: list[str] = []  # collected, never written on the notification
	try:
		meets = notifications.evaluate(notif, doc, notif.event, problems)
		recipients = notifications.resolve_recipients(notif, doc, problems)
		ctx = templates.context_for(doc.doctype, doc.name, {"event": notif.event, "notification": notif.name}, doc=doc)
		if recipients:
			first = recipients[0]
			ctx["recipient"] = notifications.recipient_context(first.phone_e164, first.display_name, first.contact)
		body, error = notifications._body(notif, ctx)
	finally:
		if frappe.local.message_log:
			del frappe.local.message_log[queued:]
	# a condition that cannot run reads as "does not match": say why
	broken = [p for p in problems if p.startswith(("condition:", "filters:"))]
	if broken and not error:
		error = broken[0]
	return {"meets": bool(meets), "recipients": recipients, "body": body, "error": error, "problems": problems}


def _attachment_hint(notif, doc) -> dict[str, Any] | None:
	"""What the message would carry, without building it: a print of the record or a field's file."""
	if cint(notif.attach_print):
		return {"message_type": "Document", "file_name": f"{doc.name}.pdf", "print_format": notif.print_format}
	if notif.attach_field:
		url = doc.get(notif.attach_field)
		return {"message_type": notif.message_type or "Document", "file_name": (url or "").rsplit("/", 1)[-1] or None, "missing": not url}
	return None


def preview(payload: dict, reference_name: str | None = None) -> dict[str, Any]:
	"""Try the draft — saved or not — on one record without sending: `{problem, reference_name,
	meets_condition, message, attachment, recipients[{phone_e164 (masked), source}],
	recipients_count, error}`. Nothing is saved, nothing is sent; the notification's own error
	fields are left alone."""
	notif = _draft(payload)
	problem = _problem(notif)
	out: dict[str, Any] = {"problem": problem, "reference_name": None, "message": None, "recipients": [], "recipients_count": 0}
	dt = notif.document_type
	if dt and frappe.db.exists("DocType", dt) and not frappe.has_permission(dt, "read"):
		# the preview is a read of a record: say so instead of failing the whole window
		out["no_access"] = True
		return out
	doc = _document(notif, reference_name)
	if doc is None:
		return out
	# evaluate under a name no row has: `_record_error` writes on the notification by name, and a
	# preview must leave the saved one's error fields (and a new one's missing name) alone
	notif.name = f"__draft__{notif.name or 'new'}"
	r = _render(notif, doc)
	out.update(
		{
			"reference_name": doc.name,
			"meets_condition": r["meets"],
			"message": r["body"],
			"attachment": _attachment_hint(notif, doc),
			"recipients": [{"phone_e164": mask(x.phone_e164), "source": x.source} for x in r["recipients"][:20]],
			"recipients_count": len(r["recipients"]),
			"error": r["error"],
			"warnings": r["problems"],
		}
	)
	return out


def send_test(payload: dict, phone: str, reference_name: str | None = None) -> dict[str, Any]:
	"""Send the draft once to `phone`, rendered for one record — what its first recipient would
	receive — and nothing else: no counters, no property set, the condition not required.
	Audited `Test Send`. Returns `{outbound, phone_e164}`."""
	phone_e164 = normalize(phone)
	if not phone_e164:
		frappe.throw(_("Enter a valid phone number"), WAValidationError)
	notif = _draft(payload)
	if not notif.get("recipients"):
		# a test needs no recipients of its own: the number is the recipient
		notif.append("recipients", {"recipient_type": "Fixed Number", "phone": phone_e164})
	problem = _problem(notif)
	if problem:
		frappe.throw(problem, WAValidationError)
	doc = _document(notif, reference_name)
	if doc is None:
		frappe.throw(_("There is no {0} to try the notification on yet").format(_(notif.document_type)), WAValidationError)
	saved_name = None if notif.is_new() else notif.name
	notif.name = saved_name or None
	ctx = templates.context_for(doc.doctype, doc.name, {"event": "Test", "notification": saved_name}, doc=doc)
	# the tester's own number: named when the system knows it, never "None"
	ctx["recipient"] = notifications.recipient_context(phone_e164, *dispatch.recipient_identity(phone_e164))
	body, error = notifications._body(notif, ctx)
	if error or not (body or "").strip():
		frappe.throw(_("The message could not be rendered: {0}").format(error or _("it is empty")), WAValidationError)
	attach = notifications._attachment(notif, doc)
	spec = OutboundSpec(
		device=notif.device or None,
		phone=phone_e164,
		body=body if attach["message_type"] == "Text" else None,
		caption=body if attach["message_type"] != "Text" else None,
		source_type="Notification",
		notification=saved_name,
		reference_doctype=doc.doctype,
		reference_name=doc.name,
		**attach,
	)
	outbound = dispatch.create_outbound(spec)
	dispatch.enqueue([outbound], priority=3)
	audit.log(
		"Test Send",
		reference=(DOCTYPE, saved_name) if saved_name else None,
		details={"notification": notif.notification_name, "document": f"{doc.doctype} {doc.name}"},
		count=1,
	)
	return {"outbound": outbound, "phone_e164": phone_e164}


# ---- writes --------------------------------------------------------------------------------


def save(payload: dict) -> dict[str, Any]:
	"""Create or update the notification from the payload; a changed name renames it. Returns
	`{name}`. The controller validates everything."""
	if not isinstance(payload, dict):
		frappe.throw(_("payload must be an object"), WAValidationError)
	name = payload.get("name")
	new_name = (payload.get("notification_name") or "").strip()
	if not new_name:
		frappe.throw(_("Name the notification first"), WAValidationError)
	if name:
		doc = _get(name)
		doc.check_permission("write")
		_apply(doc, payload)
		doc.save()
		if new_name != doc.name:
			if frappe.db.exists(DOCTYPE, new_name):
				frappe.throw(_("A notification named {0} already exists").format(new_name), WAValidationError)
			doc.name = frappe.rename_doc(DOCTYPE, doc.name, new_name, force=True)
			# the doc-event hook caches names per DocType: the old name would be skipped once
			notifications.clear_cache(doc.document_type)
	else:
		frappe.has_permission(DOCTYPE, "create", throw=True)
		if frappe.db.exists(DOCTYPE, new_name):
			frappe.throw(_("A notification named {0} already exists").format(new_name), WAValidationError)
		doc = frappe.new_doc(DOCTYPE)
		_apply(doc, payload)
		doc.insert()
	return {"name": doc.name}


def delete(name: str) -> None:
	"""Delete the notification (its sent messages stay in the log)."""
	doc = _get(name)
	doc.check_permission("delete")
	frappe.delete_doc(DOCTYPE, doc.name)


# ---- pickers -------------------------------------------------------------------------------


def search(kind: str, txt: str | None = None, document_type: str | None = None) -> list[dict[str, Any]]:
	"""The editor's pickers: `document_type`, `print_format`, `letter_head` — `[{value, label,
	description}]`, through `frappe.get_list` so the caller's permissions apply."""
	txt = (txt or "").strip()
	like = ("like", f"%{txt}%") if txt else None
	if kind == "document_type":
		# the reader types the name they see — often the translated one ("فاتورة مبيعات"), which no
		# SQL `like` on `name` can match — so the candidates are matched on both names in Python
		rows = frappe.get_list(
			"DocType",
			filters={"istable": 0, "issingle": 0, "name": ("not like", "WhatsApp %")},
			fields=["name", "module", "is_submittable"],
			order_by="name asc",
			limit_page_length=0,
		)
		q = txt.casefold()

		def rank(r) -> int | None:
			names = (r.name.casefold(), _(r.name).casefold())
			if not q:
				return 2
			if any(n.startswith(q) for n in names):
				return 0
			if any(q in n for n in names):
				return 1
			return None

		ranked = sorted(((rank(r), _(r.name), r) for r in rows if rank(r) is not None), key=lambda x: (x[0], x[1]))
		return [
			{"value": r.name, "label": label, "description": _(r.module) + (" · " + _("Submittable") if r.is_submittable else "")}
			for _rank, label, r in ranked[:20]
		]
	if kind == "print_format":
		filters: dict[str, Any] = {"disabled": 0}
		if document_type:
			filters["doc_type"] = document_type
		rows = frappe.get_list(
			"Print Format", filters=filters, or_filters={"name": like} if like else None, fields=["name"], limit_page_length=20
		)
		return [{"value": r.name, "label": r.name, "description": None} for r in rows]
	if kind == "letter_head":
		rows = frappe.get_list(
			"Letter Head", filters={"disabled": 0}, or_filters={"name": like} if like else None, fields=["name"], limit_page_length=20
		)
		return [{"value": r.name, "label": r.name, "description": None} for r in rows]
	frappe.throw(_("Unknown picker {0}").format(kind), WAValidationError)
