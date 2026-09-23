# Module role: API of the Template editor (backend-plan §4.9, screen 10): sandboxed preview,
# variable hints and a sample record picker. Thin wrappers over `services/templates.py`.

from __future__ import annotations

from typing import Any

import frappe

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1._roles import AGENT_UP
from whatsapp_next.services import templates


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
		ctx = templates.context_for(doctype, reference_name, extra=sample_context)
	else:
		ctx = templates.sample_context(doctype, sample_context)
	result = templates.render(source, ctx)
	return {"body": result.text, "errors": [result.error] if result.error else []}


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
	if not frappe.db.exists("DocType", reference_doctype) or frappe.get_meta(reference_doctype).issingle:
		return {"name": None}
	rows = frappe.get_list(reference_doctype, pluck="name", order_by="modified desc", limit=1)
	return {"name": rows[0] if rows else None}
