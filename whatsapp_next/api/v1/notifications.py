# Module role: API of the WhatsApp Notification form (backend-plan §4.9, D-016): dry preview of
# one notification against one document (phones masked), field choices for the editor selects,
# and a manual send. Thin wrappers over `services/notifications.py`.

from __future__ import annotations

from typing import Any

import frappe

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import MANAGER
from whatsapp_next.services import notifications, notifications_editor


@api_endpoint(roles=MANAGER)
def preview(name: str, reference_name: str) -> dict[str, Any]:
	"""`{meets_condition, message, recipients[{phone_e164 (masked), source}], errors[]}` for
	notification `name` evaluated against `reference_name`; nothing is sent. P: Manager."""
	frappe.has_permission("WhatsApp Notification", "read", name, throw=True)
	# the preview shows the record's rendered fields: the same read check `send_now` makes
	document_type = frappe.db.get_value("WhatsApp Notification", name, "document_type")
	if document_type and frappe.db.exists(document_type, reference_name):
		frappe.has_permission(document_type, "read", reference_name, throw=True)
	return notifications.preview_for_document(name, reference_name)


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_document_fields(document_type: str) -> dict[str, list[dict[str, Any]]]:
	"""`{date_fields, datetime_fields, phone_fields, link_fields, all_fields}` of `document_type`
	for the editor's selects. P: Manager."""
	return notifications.document_fields(document_type)


@api_endpoint(roles=MANAGER)
def send_now(name: str, reference_name: str) -> dict[str, Any]:
	"""Send notification `name` for `reference_name` now (condition re-checked; one outbound per
	recipient queued at priority 3). Returns `{outbounds[], sent, skipped, error}`. P: Manager."""
	frappe.has_permission("WhatsApp Notification", "read", name, throw=True)
	document_type = frappe.db.get_value("WhatsApp Notification", name, "document_type")
	frappe.has_permission(document_type, "read", reference_name, throw=True)
	result = notifications.send_for_document(name, document_type, reference_name, doc_event="Manual")
	return {
		"outbounds": result.get("outbounds") or [],
		"sent": result.get("sent", 0),
		"skipped": result.get("skipped", 0),
		"error": result.get("error"),
	}


# ---- the editor window (`sanad.ui.NotificationEditor`) --------------------------------------


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_editor(name: str | None = None) -> dict[str, Any]:
	"""What the editor opens with: the notification, its stats, choices, fields and templates. P: Manager."""
	return notifications_editor.editor(name)


@api_endpoint(roles=MANAGER, methods=("GET", "POST"))
def get_document_setup(document_type: str) -> dict[str, Any]:
	"""`{fields, templates}` for a document type chosen in the editor. P: Manager."""
	return notifications_editor.document_setup(document_type)


@api_endpoint(roles=MANAGER)
def preview_draft(payload: dict, reference_name: str | None = None) -> dict[str, Any]:
	"""Try the unsaved draft on one record (the latest when none is given); nothing is sent. P: Manager."""
	return notifications_editor.preview(payload, reference_name)


@api_endpoint(roles=MANAGER)
def send_test(payload: dict, phone: str, reference_name: str | None = None) -> dict[str, Any]:
	"""Send the draft once to `phone`, rendered for one record; audited `Test Send`. P: Manager."""
	return notifications_editor.send_test(payload, phone, reference_name)


@api_endpoint(roles=MANAGER)
def save_editor(payload: dict) -> dict[str, Any]:
	"""Create or update the notification → `{name}`. P: Manager + create / write."""
	return notifications_editor.save(payload)


@api_endpoint(roles=MANAGER)
def delete_notification(name: str) -> dict[str, bool]:
	"""Delete the notification. P: Manager + delete."""
	notifications_editor.delete(name)
	return {"deleted": True}


@api_endpoint(roles=MANAGER, methods=("GET", "POST"), schema={"kind": {"enum": ["document_type", "print_format", "letter_head"]}})
def search(kind: str, txt: str | None = None, document_type: str | None = None) -> list[dict[str, Any]]:
	"""The editor's pickers → `[{value, label, description}]`. P: Manager."""
	return notifications_editor.search(kind, txt, document_type)
