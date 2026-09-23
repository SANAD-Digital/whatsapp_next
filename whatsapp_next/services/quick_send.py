# Module role: Quick Send / Form / API composition (backend-plan §3 `quick_send.py`). Wraps
# `dispatch.create_outbound` + `enqueue(priority=1)` and provides the recipient / template
# context the QuickSend component needs. Sending itself is always the dispatcher's job.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import cint

from whatsapp_next.exceptions import WAInvalidPhoneError, WAValidationError
from whatsapp_next.services import dispatch, templates
from whatsapp_next.services.dispatch import OutboundSpec
from whatsapp_next.services.phone import classify, is_group_or_lid, normalize

QUICK_SOURCES = frozenset({"Quick Send", "Form", "API", "Simulator"})


def compose(spec: OutboundSpec, user: str | None = None) -> tuple[str, str]:
	"""Create and enqueue one message at priority 1; returns `(outbound, queue_item)`."""
	if spec.source_type not in QUICK_SOURCES:
		frappe.throw(
			_("Quick send source must be one of {0}").format(", ".join(sorted(QUICK_SOURCES))),
			WAValidationError,
		)
	return dispatch.create_and_enqueue(spec, user=user, priority=1)


def warnings_for(device: str | None) -> list[str]:
	"""Non-blocking conditions the UI shows after queuing (`device_offline`, `queue_paused`)."""
	out: list[str] = []
	settings = frappe.get_cached_doc("WhatsApp Settings")
	if cint(settings.queue_paused):
		out.append("queue_paused")
	if device:
		st = frappe.db.get_value("WhatsApp Device", device, ["status", "disabled"], as_dict=True)
		if not st or st.status != "Connected" or cint(st.disabled):
			out.append("device_offline")
	return out


def resolve_recipient(
	phone: str | None = None, contact: str | None = None, number: str | None = None
) -> dict[str, Any]:
	"""`{phone_e164, jid, display_name, contact, known, blacklisted}` for the composer header."""
	from whatsapp_next.services import permissions, read_layer

	key: str | None = None
	display_name = None
	if number:
		row = frappe.db.get_value(
			"WhatsApp Number", number, ["phone_e164", "display_name", "contact"], as_dict=True
		)
		if not row:
			frappe.throw(_("WhatsApp Number {0} not found").format(number), WAInvalidPhoneError)
		key, display_name, contact = row.phone_e164, row.display_name, row.contact or contact
	elif contact:
		phones = permissions.contact_phones(contact)
		if not phones and not phone:
			frappe.throw(_("Contact {0} has no WhatsApp number").format(contact), WAInvalidPhoneError)
		key = normalize(phone) if phone else phones[0]
		display_name = frappe.db.get_value("Contact", contact, "full_name")
	elif phone:
		kind, key = classify(phone)
		if not kind:
			frappe.throw(_("Invalid WhatsApp number: {0}").format(phone), WAInvalidPhoneError)
		contact = permissions.resolve_contact_by_phone(key) if kind == "Individual" else None
		if contact:
			display_name = frappe.db.get_value("Contact", contact, "full_name")
	if not key:
		frappe.throw(_("A phone, contact or WhatsApp number is required"), WAInvalidPhoneError)
	is_jid = is_group_or_lid(key)
	return {
		"phone_e164": None if is_jid else key,
		"jid": key if is_jid else None,
		"display_name": display_name,
		"contact": contact,
		"known": key in read_layer.known_keys([key]),
		"blacklisted": dispatch._blacklisted(key),
	}


def preview(
	template: str | None = None,
	body: str | None = None,
	reference_doctype: str | None = None,
	reference_name: str | None = None,
	context: dict[str, Any] | None = None,
) -> dict[str, Any]:
	"""`{body, errors[]}` for the composer preview (template body or ad-hoc body)."""
	source = body
	if template and not body:
		source = frappe.db.get_value("WhatsApp Template", template, "body")
		if source is None:
			return {"body": "", "errors": [_("WhatsApp Template {0} not found").format(template)]}
	ctx = context or (
		templates.context_for(reference_doctype, reference_name)
		if reference_doctype and reference_name
		else templates.sample_context(reference_doctype)
	)
	result = templates.render(source, ctx)
	return {"body": result.text, "errors": [result.error] if result.error else []}


def get_context(
	phone: str | None = None,
	contact: str | None = None,
	number: str | None = None,
	reference_doctype: str | None = None,
	reference_name: str | None = None,
) -> dict[str, Any]:
	"""Composer bootstrap (`api.quick_send.get_context`): enabled devices, the default device,
	usable templates (generic ones plus those bound to `reference_doctype`), the resolved
	recipient when a phone / contact / number was given, and the known-number policy."""
	settings = frappe.get_cached_doc("WhatsApp Settings")
	devices = frappe.get_all(
		"WhatsApp Device",
		filters={"disabled": 0},
		fields=["name", "device_name", "status", "is_default", "phone_e164"],
		order_by="is_default desc, device_name asc",
	)
	rows = frappe.get_all(
		"WhatsApp Template",
		filters={"disabled": 0},
		fields=["name", "template_name", "message_type", "category", "reference_doctype"],
		order_by="template_name asc",
	)
	if reference_doctype:
		rows = [t for t in rows if not t.reference_doctype or t.reference_doctype == reference_doctype]
	recipient = resolve_recipient(phone, contact, number) if (phone or contact or number) else None
	return {
		"devices": devices,
		"default_device": settings.default_device,
		"templates": rows,
		"recipient": recipient,
		"reference": {"doctype": reference_doctype, "name": reference_name}
		if reference_doctype and reference_name
		else None,
		"policy": {"send_only_to_known_numbers": bool(cint(settings.send_only_to_known_numbers))},
	}
