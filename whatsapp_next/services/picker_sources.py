# Module role: the brains of the picker-source editor (owner, 2026-10-19: "it does not sense the fields
# or their types"). It reads a DocType's meta and its data and answers what a person would otherwise
# have to know by heart: which screens can give the contact picker numbers at all, which field of a
# screen holds the number (and how many records fill it), which one names the record, which links to
# a Contact, and — for a source as it is being edited — how many records it reaches and how many of
# those have a number WhatsApp can use. Nothing here writes; the editor saves through
# `settings.save_settings(section="picker")`, whose rules stay the only ones.

from __future__ import annotations

import json
import re
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services.phone import normalize

# a field whose name says it holds a number, when its type does not
PHONE_NAME = re.compile(r"(^|_)(mobile|phone|whatsapp|cell|tel|contact_no|mobile_no|phone_no)(_|$)", re.I)
# a field whose name says it names the record
NAME_NAME = re.compile(r"(^|_)(name|full_name|title|subject)(_|$)", re.I)
# screens the picker already offers in its own tabs, or that hold no one to message
SKIP_DOCTYPES = {"Contact", "Address", "Communication", "Email Account", "Comment", "Version", "Activity Log"}
SAMPLE = 3


def _is_phone_field(df) -> bool:
	if (df.fieldname or "").endswith("_ext"):
		return False  # an extension is not a number
	if df.fieldtype == "Phone" or (df.fieldtype == "Data" and (df.options or "") == "Phone"):
		return True
	# a stored text field named like a number — "Read Only" too: ERPNext fetches the customer's
	# `mobile_no` from its primary contact into one
	name = df.fieldname or ""
	return df.fieldtype in ("Data", "Read Only") and bool(PHONE_NAME.search(name)) and not name.endswith("_ext")


def _filled(doctype: str, fieldname: str) -> int:
	"""How many records fill `fieldname` (a count, never the values)."""
	return frappe.db.count(doctype, filters=[[fieldname, "is", "set"]])


def candidates() -> list[dict[str, Any]]:
	"""The regular screens that can give the picker numbers: those with a phone field or a link to a
	Contact, best first (most phone fields, then a contact link). `[{document_type, label, module,
	phone_fields, contact_link}]`."""
	found: dict[str, dict[str, Any]] = {}
	for table in ("DocField", "Custom Field"):
		parent = "parent" if table == "DocField" else "dt"
		rows = frappe.get_all(
			table,
			filters=[["fieldtype", "in", ("Phone", "Data", "Read Only", "Link")]],
			fields=[f"{parent} as doctype", "fieldname", "fieldtype", "options"],
			limit_page_length=0,
		)
		for r in rows:
			phone = _is_phone_field(r)
			contact = r.fieldtype == "Link" and r.options == "Contact"
			if not (phone or contact) or r.doctype in SKIP_DOCTYPES:
				continue
			row = found.setdefault(r.doctype, {"document_type": r.doctype, "phone_fields": 0, "contact_link": False})
			row["phone_fields"] += 1 if phone else 0
			row["contact_link"] = row["contact_link"] or contact
	if not found:
		return []
	meta = {
		d.name: d
		for d in frappe.get_all(
			"DocType",
			# this app's own records (messages, logs, devices) are not people to pick
			filters={"name": ("in", list(found)), "istable": 0, "issingle": 0, "is_virtual": 0, "module": ("!=", "WhatsApp Next")},
			fields=["name", "module"],
		)
	}
	out = []
	for name, row in found.items():
		if name not in meta:
			continue
		row["label"] = _(name)
		row["module"] = meta[name].module
		out.append(row)
	out.sort(key=lambda r: (-r["phone_fields"], not r["contact_link"], r["label"]))
	return out


def analyze(document_type: str) -> dict[str, Any]:
	"""What the editor offers for one screen, with its best guess for each choice.

	`{document_type, label, total, title_field, phone_fields[], name_fields[], contact_fields[],
	suggestion{label, phone_source, phone_fieldname, contact_fieldname, name_fieldname}}`. Each
	phone field carries how many records fill it, so the busiest one is the guess."""
	meta = _meta(document_type)
	total = frappe.db.count(document_type)
	title_field = meta.get_title_field()
	phones, names, contacts = [], [], []
	for df in meta.fields:
		if df.fieldtype in ("Section Break", "Column Break", "Tab Break", "HTML", "Button") or cint(df.permlevel):
			continue
		label = _(df.label or df.fieldname)
		if _is_phone_field(df):
			phones.append({"fieldname": df.fieldname, "label": label, "fieldtype": "Phone" if df.options == "Phone" else df.fieldtype, "filled": _filled(document_type, df.fieldname) if total else 0})
			continue
		elif df.fieldtype == "Link" and df.options == "Contact":
			contacts.append({"fieldname": df.fieldname, "label": label, "filled": _filled(document_type, df.fieldname) if total else 0})
		if df.fieldtype in ("Data", "Link", "Small Text") and not _is_phone_field(df) and (
			df.fieldname == title_field or NAME_NAME.search(df.fieldname or "") or df.in_list_view
		):
			names.append({"fieldname": df.fieldname, "label": label, "title": df.fieldname == title_field})
	names.sort(key=lambda f: (not f["title"], not NAME_NAME.search(f["fieldname"]), f["label"]))
	if not any(f["fieldname"] == "name" for f in names):
		names.append({"fieldname": "name", "label": _("ID"), "title": title_field in (None, "name")})

	# the busiest field; on a tie the one named for WhatsApp, then a mobile, then a Phone-typed one
	def rank(f):
		name = f["fieldname"].lower()
		return (f["filled"], "whatsapp" in name, "mobile" in name, f["fieldtype"] == "Phone")

	phones.sort(key=rank, reverse=True)
	best_phone = phones[0] if phones else None
	best_contact = max(contacts, key=lambda f: f["filled"], default=None)
	by_contact = bool(best_contact) and (not best_phone or best_contact["filled"] > best_phone["filled"])
	return {
		"document_type": document_type,
		"label": _(document_type),
		"total": total,
		"title_field": title_field,
		"phone_fields": phones,
		"name_fields": names,
		"contact_fields": sorted(contacts, key=lambda f: -f["filled"]),
		"suggestion": {
			"label": _(document_type),
			"phone_source": "Linked Contact" if by_contact else "Field",
			"phone_fieldname": None if by_contact or not best_phone else best_phone["fieldname"],
			"contact_fieldname": best_contact["fieldname"] if by_contact else None,
			"name_fieldname": names[0]["fieldname"] if names else "name",
		},
	}


def preview(source: dict[str, Any] | str) -> dict[str, Any]:
	"""How a source as it is being edited reaches people: `{total, with_number, sample[{label,
	phone}]}` — the records its server filters keep, how many of those have a number WhatsApp can
	use, and the first few of them."""
	from whatsapp_next.services.permissions import _phones_for, validate_filters

	if isinstance(source, str):
		source = json.loads(source or "{}")
	document_type = (source or {}).get("document_type")
	meta = _meta(document_type)
	try:
		filters = validate_filters(meta, source.get("filters_json") or [])
	except (ValueError, TypeError) as exc:
		frappe.throw(_("Invalid filters: {0}").format(exc), WAValidationError)
	filters = [[document_type, *f] for f in filters]
	total = frappe.db.count(document_type, filters=filters)

	name_field = source.get("name_fieldname") or meta.get_title_field() or "name"
	if name_field != "name" and not meta.has_field(name_field):
		name_field = "name"
	if source.get("phone_source") == "Linked Contact":
		field = source.get("contact_fieldname")
		if not (field and meta.has_field(field)):
			return {"total": total, "with_number": 0, "sample": []}
		rows = frappe.get_all(document_type, filters=filters + [[document_type, field, "is", "set"]], fields=[f"`{name_field}` as label", f"`{field}` as contact"], limit_page_length=500)
		phones = _phones_for(sorted({r.contact for r in rows}))
		for r in rows:
			first = next(iter(phones.get(r.contact) or []), None)
			r.phone = first["phone"] if first else None
	else:
		field = source.get("phone_fieldname")
		if not (field and meta.has_field(field)):
			return {"total": total, "with_number": 0, "sample": []}
		rows = frappe.get_all(document_type, filters=filters + [[document_type, field, "is", "set"]], fields=[f"`{name_field}` as label", f"`{field}` as phone"], limit_page_length=500)
	usable = [r for r in rows if r.get("phone") and normalize(r.phone)]
	# counted on at most 500 records: enough to say whether the choice works, cheap on a big table
	with_number = len(usable) if len(rows) < 500 else round(len(usable) / len(rows) * frappe.db.count(document_type, filters=filters + [[document_type, field, "is", "set"]]))
	return {
		"total": total,
		"with_number": with_number,
		"sample": [{"label": str(r.label or ""), "phone": normalize(r.phone)} for r in usable[:SAMPLE]],
	}


def _meta(document_type: str | None):
	if not document_type or not frappe.db.exists("DocType", document_type):
		frappe.throw(_("DocType {0} not found").format(document_type or ""), WAValidationError)
	meta = frappe.get_meta(document_type)
	if meta.istable or meta.issingle:
		frappe.throw(_("{0} must be a regular DocType").format(document_type), WAValidationError)
	return meta
