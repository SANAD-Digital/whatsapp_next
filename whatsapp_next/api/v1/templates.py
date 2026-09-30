# Module role: API of the Template editor (backend-plan §4.9, screen 10): sandboxed preview,
# variable hints and a sample record picker, plus the editor window's open / save / delete. Thin
# wrappers over `services/templates.py` and `services/templates_editor.py`.

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.model.document import Document

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import AGENT_UP, MANAGER
from whatsapp_next.services import templates, templates_editor


@api_endpoint(roles=AGENT_UP)
def preview(
	template: str | None = None,
	body: str | None = None,
	reference_doctype: str | None = None,
	reference_name: str | None = None,
	sample_context: dict | None = None,
) -> dict[str, Any]:
	"""Render `body` (or the saved `template`'s body) against `reference_name` — or, without a
	record, the latest readable one overlaid with `sample_context`. Returns `{body, errors[]}`;
	render errors are returned, never raised. P: Agent, Manager."""
	source = body
	doctype = reference_doctype
	if template and not source:
		# the saved body is read as the caller: a template they cannot open is not previewed
		frappe.has_permission("WhatsApp Template", "read", template, throw=True)
		row = frappe.db.get_value(
			"WhatsApp Template", template, ["body", "reference_doctype", "sample_context"], as_dict=True
		)
		if row:
			source = row.body
			doctype = doctype or row.reference_doctype
			sample_context = sample_context if sample_context is not None else row.sample_context
	errors = templates.compile_check(source)
	if errors:
		return {"body": "", "errors": errors}
	if reference_name and doctype:
		frappe.has_permission(doctype, "read", reference_name, throw=True)
		doc = frappe.get_doc(doctype, reference_name)
		_readable_only(doc)
		# a real record is the `doc`; the template's sample values fill only the other names
		extra = {k: v for k, v in (_parsed(sample_context) or {}).items() if k != "doc"}
		ctx = templates.context_for(
			doctype, reference_name, extra=extra or None, doc=doc, recipient=_sample_recipient()
		)
	else:
		ctx = _sample_context(doctype, sample_context)
	result = templates.render(source, ctx)
	errors = [result.error] if result.error else []
	if doctype and not reference_name and not frappe.has_permission(doctype, "read"):
		errors.append(
			_("You cannot read {0} records, so the preview fills its fields with nothing.").format(_(doctype))
		)
	return {"body": result.text, "errors": errors}


def _readable_only(doc) -> None:
	"""Drop the values of fields above the caller's permission levels (and mask masked ones), as
	the form does: record-level read is not field-level read."""
	if not isinstance(doc, Document):
		return
	doc.apply_fieldlevel_read_permissions()
	# Frappe drops the attribute; a template reading it would print Jinja's "no such element":
	# the hidden value reads as empty instead
	for row in [doc, *(c for t in doc.meta.get_table_fields() for c in doc.get(t.fieldname) or [])]:
		for df in row.meta.fields:
			if df.fieldname and df.fieldtype not in frappe.model.table_fields and not hasattr(row, df.fieldname):
				setattr(row, df.fieldname, "")


def _sample_recipient() -> dict[str, str]:
	"""The recipient a preview writes to — the same one `templates.sample_context` fills."""
	return frappe._dict(phone_e164="+966500000000", display_name=_("Recipient"))


def _parsed(value) -> dict[str, Any] | None:
	if isinstance(value, dict) or not value:
		return value or None
	try:
		parsed = json.loads(value)
	except (TypeError, ValueError):
		return None
	return parsed if isinstance(parsed, dict) else None


def _sample_context(doctype: str | None, sample: str | dict | None) -> dict[str, Any]:
	"""`templates.sample_context` with the sample record read at the caller's field levels: the
	record is loaded without the template's `doc` overlay, filtered, then overlaid here."""
	parsed = dict(_parsed(sample) or {})
	overlay = parsed.pop("doc", None)
	ctx = templates.sample_context(doctype, parsed or None)
	_readable_only(ctx.get("doc"))
	if isinstance(overlay, dict):
		base = ctx["doc"].as_dict() if isinstance(ctx.get("doc"), Document) else dict(ctx.get("doc") or {})
		base.update(overlay)
		ctx["doc"] = frappe._dict(base)
	if not isinstance(ctx.get("doc"), Document):
		# no record to read: a field the sample does not give prints nothing, not "None"
		ctx["doc"] = _Placeholder(ctx.get("doc") or {})
	return ctx


class _Placeholder(frappe._dict):
	"""A sample `doc` without a record behind it: unknown fields read as empty text."""

	def __getattr__(self, key):
		value = self.get(key)
		return "" if value is None else value


@api_endpoint(roles=AGENT_UP, methods=("GET", "POST"))
def list_variables(reference_doctype: str | None = None) -> list[dict[str, str]]:
	"""`[{name, label, fieldtype}]` variable hints for the editor (`doc.<field>` plus the base
	context names). P: Agent, Manager."""
	meta = (
		frappe.get_meta(reference_doctype)
		if reference_doctype and frappe.db.exists("DocType", reference_doctype)
		else None
	)
	out: list[dict[str, str]] = []
	for name in templates.variables(reference_doctype):
		label, fieldtype = name, "Data"
		if meta and name.startswith("doc.") and "[" not in name:
			df = meta.get_field(name[4:])
			if df:
				label, fieldtype = df.label or name, df.fieldtype
		out.append({"name": name, "label": label, "fieldtype": fieldtype})
	return out


@api_endpoint(roles=AGENT_UP, methods=("GET", "POST"))
def pick_sample(reference_doctype: str) -> dict[str, str | None]:
	"""`{name}` of the latest record of `reference_doctype` the caller may read (None when the
	DocType has none). P: Agent, Manager."""
	if (
		not frappe.db.exists("DocType", reference_doctype)
		or frappe.get_meta(reference_doctype).issingle
		or not frappe.has_permission(reference_doctype, "read")
	):
		return {"name": None}
	rows = frappe.get_list(reference_doctype, pluck="name", order_by="modified desc", limit=1)
	return {"name": rows[0] if rows else None}


# ---- the editor window --------------------------------------------------------------------------


@api_endpoint(roles=AGENT_UP, methods=("GET", "POST"))
def get_editor(name: str | None = None) -> dict[str, Any]:
	"""What the editor window opens with (`templates_editor.editor`); read-only for an Agent.
	P: Agent (read), Manager (read / create)."""
	return templates_editor.editor(name or None)


@api_endpoint(roles=MANAGER)
def save_editor(payload: dict) -> dict[str, Any]:
	"""Create or update the template (`templates_editor.save`). P: Manager + write / create."""
	return templates_editor.save(payload)


@api_endpoint(roles=MANAGER)
def delete_template(name: str) -> dict[str, bool]:
	"""Delete the template. P: Manager + delete."""
	templates_editor.delete(name)
	return {"deleted": True}
