# Module role: built-in `document_info` function — status and amount of one document of a
# configured DocType, restricted to documents that belong to the sender's linked party. The
# reference shape for catalog functions: settings drive the DocType and party field, inputs
# come from the message, the handler reads a declared field set and never the whole document.

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import cint

from whatsapp_next.functions.context import FunctionContext, FunctionResult
from whatsapp_next.services import read_layer

READ_FIELDS = ("name", "docstatus", "status", "modified", "posting_date", "transaction_date")


def handle(ctx: FunctionContext) -> FunctionResult:
	"""`#doc <name>` → `{doctype, name, status, amount, date}`; refuses documents of another party."""
	doctype = (ctx.settings.get("document_type") or "").strip()
	party_field = (ctx.settings.get("party_field") or "").strip()
	require_party = cint(ctx.settings.get("require_party", 1))
	name = (ctx.args.get("name") or "").strip()
	if not doctype or not frappe.db.exists("DocType", doctype):
		return FunctionResult(error=_("Function is not configured: document_type"))
	if not name:
		return FunctionResult(error=_("Document name is required"))
	meta = frappe.get_meta(doctype)
	fields = [f for f in READ_FIELDS if f == "name" or meta.has_field(f)]
	if party_field and meta.has_field(party_field):
		fields.append(party_field)
	row = frappe.db.get_value(doctype, name, fields, as_dict=True)
	if not row:
		return FunctionResult(error=_("{0} {1} not found").format(_(doctype), name))
	if require_party:
		if not ctx.sender.party_name:
			return FunctionResult(error=_("Your number is not linked to a party"))
		if party_field and row.get(party_field) != ctx.sender.party_name:
			return FunctionResult(error=_("{0} {1} does not belong to you").format(_(doctype), name))
	status = row.get("status") or {0: _("Draft"), 1: _("Submitted"), 2: _("Cancelled")}.get(
		cint(row.get("docstatus"))
	)
	return FunctionResult(
		data={
			"doctype": doctype,
			"name": row["name"],
			"status": status,
			"amount": read_layer.reference_amount(doctype, row["name"]),
			"date": str(row.get("posting_date") or row.get("transaction_date") or "")[:10],
			"party": row.get(party_field) if party_field else None,
		}
	)
