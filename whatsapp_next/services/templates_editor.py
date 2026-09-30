# Module role: the message template editor window — what `sanad.ui.TemplateWindow` opens with,
# saves and deletes. The controller keeps every rule (the body compiles, a Document template has a
# print format); this module maps an allow-listed payload onto the document, guards against an
# edit made elsewhere since the window opened, and renames on a changed name. The API layer
# (`api/v1/templates.py`) only checks the role and calls in here.

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, get_datetime

from whatsapp_next.exceptions import WANotFoundError, WAValidationError

DOCTYPE = "WhatsApp Template"

# the only fields a payload may carry — never a client fieldname beyond these
FIELDS: tuple[str, ...] = (
	"template_name",
	"category",
	"description",
	"message_type",
	"disabled",
	"body",
	"attachment",
	"print_format",
	"letter_head",
	"file_name_template",
	"reference_doctype",
	"language",
	"sample_context",
)
STAT_FIELDS: tuple[str, ...] = ("use_count", "last_used_at", "modified")


def _get(name: str):
	if not frappe.db.exists(DOCTYPE, name):
		frappe.throw(_("Template {0} not found").format(name), WANotFoundError)
	return frappe.get_doc(DOCTYPE, name)


def _message_types() -> list[str]:
	df = frappe.get_meta(DOCTYPE).get_field("message_type")
	return [o for o in (df.options or "").split("\n") if o] if df else ["Text"]


def _categories() -> list[str]:
	rows = frappe.get_list(
		DOCTYPE, fields=["category"], group_by="category", order_by="category asc", limit=100
	)
	return [r.category for r in rows if r.category]


def editor(name: str | None = None) -> dict[str, Any]:
	"""Everything the window opens with: `{template, categories[], message_types[], can_write,
	can_delete}` — the template (defaults for a new one) and the choices its controls offer.
	E: `WANotFoundError`."""
	if name:
		doc = _get(name)
		doc.check_permission("read")
		template = {"name": doc.name, **{f: doc.get(f) for f in (*FIELDS, *STAT_FIELDS)}}
		can_write = bool(frappe.has_permission(DOCTYPE, "write", doc))
		can_delete = bool(frappe.has_permission(DOCTYPE, "delete", doc))
	else:
		frappe.has_permission(DOCTYPE, "create", throw=True)
		template = {"name": None, **dict.fromkeys(FIELDS), "message_type": "Text", "disabled": 0, "body": ""}
		can_write, can_delete = True, False
	if isinstance(template.get("sample_context"), dict | list):
		template["sample_context"] = json.dumps(template["sample_context"], indent=1, ensure_ascii=False)
	return {
		"template": template,
		"categories": _categories(),
		"message_types": _message_types(),
		"can_write": can_write,
		"can_delete": can_delete,
	}


def _apply(doc, payload: dict) -> None:
	for field in FIELDS:
		if field not in payload:
			continue
		value = payload[field]
		if field == "disabled":
			value = 1 if cint(value) else 0
		elif isinstance(value, str):
			value = value.strip() if field not in ("body", "description") else value
			value = value or None
		doc.set(field, value)
	# a file belongs to one kind of message only: what the type no longer uses is cleared
	if doc.message_type != "Image":
		doc.attachment = None
	if doc.message_type != "Document":
		doc.print_format = doc.letter_head = doc.file_name_template = None


def save(payload: dict) -> dict[str, Any]:
	"""Create or update the template from the payload; a changed name renames it. Refuses to
	overwrite an edit saved elsewhere since the window opened (`modified`). Returns `{name,
	modified}`. The controller validates everything else."""
	if not isinstance(payload, dict):
		frappe.throw(_("payload must be an object"), WAValidationError)
	new_name = (payload.get("template_name") or "").strip()
	if not new_name:
		frappe.throw(_("Give the template a name"), WAValidationError)
	name = payload.get("name")
	if name:
		doc = _get(name)
		doc.check_permission("write")
		opened = payload.get("modified")
		if opened and get_datetime(opened) != get_datetime(doc.modified):
			frappe.throw(
				_(
					"Someone else saved this template after you opened it. Close it and open it again to see their changes."
				),
				WAValidationError,
			)
		_apply(doc, payload)
		doc.save()
		if new_name != doc.name:
			if frappe.db.exists(DOCTYPE, new_name):
				frappe.throw(_("A template named {0} already exists").format(new_name), WAValidationError)
			doc.name = frappe.rename_doc(DOCTYPE, doc.name, new_name, force=True)
	else:
		frappe.has_permission(DOCTYPE, "create", throw=True)
		if frappe.db.exists(DOCTYPE, new_name):
			frappe.throw(_("A template named {0} already exists").format(new_name), WAValidationError)
		doc = frappe.new_doc(DOCTYPE)
		_apply(doc, payload)
		doc.insert()
	return {"name": doc.name, "modified": frappe.db.get_value(DOCTYPE, doc.name, "modified")}


def delete(name: str) -> None:
	"""Delete the template. Frappe refuses while sent messages or campaigns still link to it, and
	says which — the window shows that message and suggests disabling it instead."""
	doc = _get(name)
	doc.check_permission("delete")
	frappe.delete_doc(DOCTYPE, doc.name)
