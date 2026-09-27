# Module role: the contextual permission layer (security.md "Contextual permission layer",
# backend-plan §9, D-044). A `WhatsApp Contact User` has no rows in the core `Contact` permission
# matrix; product screens reach Contact only through the functions here, which:
#   1. elevate against a **declared** field set (module constants, never client-supplied),
#   2. filter **in the query**, never only in the view,
#   3. audit every elevated read/write under the real session user (`frappe.set_user` is never
#      called here).
# This is the only module allowed to write core `Contact`. `api/v1/contacts.py`, `numbers.py`
# and `picker.py` are thin wrappers over these functions.

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any

import frappe
from frappe import _
from frappe.query_builder.functions import Count
from frappe.utils import cint, now_datetime
from pypika import Order
from pypika.terms import ExistsCriterion

from whatsapp_next.exceptions import (
	WANotFoundError,
	WAPermissionError,
	WAStateConflictError,
	WAValidationError,
)
from whatsapp_next.services import audit
from whatsapp_next.services.phone import classify, normalize

ELEVATED_ROLE = "WhatsApp Contact User"

# Party DocTypes a Contact may be linked to from product screens (backend-plan §9).
PARTY_TYPES: tuple[str, ...] = ("Customer", "Supplier", "Employee", "Sales Person")

# Declared field sets — never accepted from the client.
CONTACT_READ_FIELDS: tuple[str, ...] = (
	"name",
	"first_name",
	"last_name",
	"full_name",
	"salutation",
	"designation",
	"company_name",
	"email_id",
	"image",
	"status",
	"modified",
)
CONTACT_PHONE_READ_FIELDS: tuple[str, ...] = (
	"phone",
	"is_primary_mobile_no",
	"is_primary_phone",
	"wa_phone_e164",
)
CONTACT_LINK_READ_FIELDS: tuple[str, ...] = ("link_doctype", "link_name", "link_title")
CONTACT_WRITE_FIELDS: tuple[str, ...] = (
	"first_name",
	"last_name",
	"salutation",
	"designation",
	"company_name",
	"email_id",
)
CONTACT_PHONE_WRITE_FIELDS: tuple[str, ...] = ("phone", "is_primary_mobile_no")
CONTACT_LINK_WRITE_FIELDS: tuple[str, ...] = ("link_doctype", "link_name")
# Sub-table keys accepted in a create/update payload (rows replaced as a set).
CONTACT_TABLE_KEYS: tuple[str, ...] = ("phone_nos", "links")

CONTACT_SEARCH_FIELDS: tuple[str, ...] = ("name", "full_name", "image")
ORDERABLE_FIELDS: frozenset[str] = frozenset(CONTACT_READ_FIELDS)

# Standard columns every DocType has; allowed in client filters besides meta fields.
STANDARD_FIELDS: frozenset[str] = frozenset({"name", "owner", "creation", "modified", "docstatus", "idx"})
FILTER_OPERATORS: frozenset[str] = frozenset(
	{"=", "!=", "in", "not in", "like", "not like", ">", "<", ">=", "<=", "between", "is"}
)

MAX_PAGE_LENGTH = 200


# --------------------------------------------------------------------------------------------
# Elevation
# --------------------------------------------------------------------------------------------


def contact_open_to_all() -> list[str]:
	"""The rights role `All` still holds on the core `Contact` DocType (level 0), in the effective
	permissions (Custom DocPerm when the site customised them).

	The contextual layer assumes a WhatsApp Contact User has no native Contact access, but Frappe
	ships `Contact` with `All` read / write / create (R-028). Removing that row is the site
	admin's step in the Role Permission Manager, never the app's (owner, D-125); this only
	reports it, for the Settings banner and the install / migrate warning."""
	rows = [p for p in frappe.get_meta("Contact").permissions if p.role == "All" and not cint(p.permlevel)]
	return [ptype for ptype in ("read", "write", "create", "delete") if any(cint(p.get(ptype)) for p in rows)]


def is_contact_user(user: str | None = None) -> bool:
	"""True when the (session) user holds the contextual role."""
	return ELEVATED_ROLE in frappe.get_roles(user or frappe.session.user)


def can_elevate(ptype: str = "read", user: str | None = None) -> bool:
	"""Contextual role **or** native permission on Contact for `ptype`."""
	user = user or frappe.session.user
	if user == "Guest":
		return False
	if is_contact_user(user):
		return True
	return bool(frappe.has_permission("Contact", ptype, user=user))


def require(ptype: str = "read") -> None:
	"""Raise `WAPermissionError` unless `can_elevate(ptype)`."""
	if not can_elevate(ptype):
		frappe.throw(_("Not permitted to {0} contacts").format(_(ptype)), WAPermissionError)


def _audit_read(*, count: int | None = None, **details: Any) -> None:
	"""Audit an elevated read — only for users acting through the contextual role (D-029 OQ-3)."""
	if is_contact_user():
		audit.log("Elevated Contact Read", count=count, details=details or None, severity="Info")


def _audit_write(contact: str, fields_written: Iterable[str], *, reason: str | None = None) -> None:
	audit.log(
		"Elevated Contact Write",
		reference=("Contact", contact),
		fields_written=fields_written,
		reason=reason,
	)


def _page(page: int | None, page_length: int | None) -> tuple[int, int]:
	length = min(max(cint(page_length) or 20, 1), MAX_PAGE_LENGTH)
	start = (max(cint(page) or 1, 1) - 1) * length
	return start, length


# --------------------------------------------------------------------------------------------
# Reads
# --------------------------------------------------------------------------------------------


def _phones_for(contacts: list[str]) -> dict[str, list[dict[str, Any]]]:
	if not contacts:
		return {}
	rows = frappe.get_all(
		"Contact Phone",
		filters={"parenttype": "Contact", "parent": ("in", contacts)},
		fields=["parent", *CONTACT_PHONE_READ_FIELDS],
		order_by="is_primary_mobile_no desc, idx asc",
		ignore_permissions=True,
	)
	out: dict[str, list[dict[str, Any]]] = {c: [] for c in contacts}
	for r in rows:
		parent = r.pop("parent")
		out[parent].append(r)
	return out


def _links_for(contacts: list[str]) -> dict[str, list[dict[str, Any]]]:
	if not contacts:
		return {}
	rows = frappe.get_all(
		"Dynamic Link",
		filters={
			"parenttype": "Contact",
			"parent": ("in", contacts),
			"link_doctype": ("in", list(PARTY_TYPES)),
		},
		fields=["parent", *CONTACT_LINK_READ_FIELDS],
		order_by="idx asc",
		ignore_permissions=True,
	)
	out: dict[str, list[dict[str, Any]]] = {c: [] for c in contacts}
	for r in rows:
		parent = r.pop("parent")
		out[parent].append(r)
	return out


def _number_stats_for(phones: dict[str, list[dict[str, Any]]]) -> dict[str, dict[str, Any]]:
	"""`WhatsApp Number` counters joined on `Contact Phone.wa_phone_e164` (best row per contact)."""
	keys = sorted({p["wa_phone_e164"] for rows in phones.values() for p in rows if p.get("wa_phone_e164")})
	if not keys:
		return {}
	numbers = {
		n["phone_e164"]: n
		for n in frappe.get_all(
			"WhatsApp Number",
			filters={"phone_e164": ("in", keys)},
			fields=[
				"phone_e164",
				"last_seen",
				"last_direction",
				"outbound_count",
				"inbound_count",
				"conversation_confirmed",
				"link_status",
			],
			ignore_permissions=True,
		)
	}
	out: dict[str, dict[str, Any]] = {}
	for contact, rows in phones.items():
		hits = [numbers[p["wa_phone_e164"]] for p in rows if p.get("wa_phone_e164") in numbers]
		if not hits:
			continue
		best = max(hits, key=lambda n: (n.get("last_seen") is not None, n.get("last_seen") or ""))
		out[contact] = {
			"has_whatsapp": 1,
			"last_seen": best.get("last_seen"),
			"last_direction": best.get("last_direction"),
			"outbound_count": sum(cint(n.get("outbound_count")) for n in hits),
			"inbound_count": sum(cint(n.get("inbound_count")) for n in hits),
			"conversation_confirmed": max(cint(n.get("conversation_confirmed")) for n in hits),
		}
	return out


def _blacklist_group() -> str | None:
	return frappe.db.get_single_value("WhatsApp Settings", "global_blacklist_group") or None


def _blacklisted_keys(keys: Iterable[str]) -> set[str]:
	group = _blacklist_group()
	keys = [k for k in keys if k]
	if not group or not keys:
		return set()
	return set(
		frappe.get_all(
			"WhatsApp Contact Group Member",
			filters={"parent": group, "parenttype": "WhatsApp Contact Group", "phone_e164": ("in", keys)},
			pluck="phone_e164",
			ignore_permissions=True,
		)
	)


def _attach_children(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
	names = [r["name"] for r in rows]
	phones = _phones_for(names)
	links = _links_for(names)
	stats = _number_stats_for(phones)
	black = _blacklisted_keys(
		p["wa_phone_e164"] for ps in phones.values() for p in ps if p.get("wa_phone_e164")
	)
	for r in rows:
		r["phone_nos"] = phones.get(r["name"], [])
		r["links"] = links.get(r["name"], [])
		r.update(stats.get(r["name"], {"has_whatsapp": 0}))
		r["blacklisted"] = int(any(p.get("wa_phone_e164") in black for p in r["phone_nos"]))
	return rows


def _contact_query(
	search: str | None = None,
	link_doctype: str | None = None,
	link_name: str | None = None,
	has_whatsapp: bool | None = None,
	blacklisted: bool | None = None,
	linked: bool | None = None,
	status: str | None = None,
):
	"""The filtered Contact query (condition 2: filtering happens here, not in the view)."""
	C = frappe.qb.DocType("Contact")
	P = frappe.qb.DocType("Contact Phone")
	q = frappe.qb.from_(C)
	if search:
		txt = f"%{search.strip()}%"
		digits = normalize(search) or search.strip()
		phone_match = (
			frappe.qb.from_(P)
			.select(P.name)
			.where((P.parenttype == "Contact") & (P.parent == C.name))
			.where(P.phone.like(txt) | P.wa_phone_e164.like(f"%{digits}%"))
		)
		q = q.where(C.full_name.like(txt) | C.email_id.like(txt) | ExistsCriterion(phone_match))
	if link_doctype:
		if link_doctype not in PARTY_TYPES:
			frappe.throw(_("Unsupported party type {0}").format(link_doctype), WAValidationError)
		D = frappe.qb.DocType("Dynamic Link")
		link_match = (
			frappe.qb.from_(D)
			.select(D.name)
			.where((D.parenttype == "Contact") & (D.parent == C.name) & (D.link_doctype == link_doctype))
		)
		if link_name:
			link_match = link_match.where(D.link_name == link_name)
		q = q.where(ExistsCriterion(link_match))
	if has_whatsapp is not None:
		N = frappe.qb.DocType("WhatsApp Number")
		known = (
			frappe.qb.from_(P)
			.join(N)
			.on(N.phone_e164 == P.wa_phone_e164)
			.select(P.name)
			.where((P.parenttype == "Contact") & (P.parent == C.name))
		)
		q = q.where(ExistsCriterion(known) if has_whatsapp else ~ExistsCriterion(known))
	if blacklisted is not None:
		group = _blacklist_group()
		if group:
			M = frappe.qb.DocType("WhatsApp Contact Group Member")
			black = (
				frappe.qb.from_(P)
				.join(M)
				.on(M.phone_e164 == P.wa_phone_e164)
				.select(P.name)
				.where((P.parenttype == "Contact") & (P.parent == C.name) & (M.parent == group))
			)
			q = q.where(ExistsCriterion(black) if blacklisted else ~ExistsCriterion(black))
		elif blacklisted:
			q = q.where(C.name.isnull())  # no blacklist configured → nothing matches
	if linked is not None:
		# "is this contact tied to an account at all" — the screen's «حالة الربط» filter, answered
		# in the query so a Contact User never sees a row the layer would have hidden
		D = frappe.qb.DocType("Dynamic Link")
		any_link = (
			frappe.qb.from_(D)
			.select(D.name)
			.where((D.parenttype == "Contact") & (D.parent == C.name) & (D.link_doctype.isin(list(PARTY_TYPES))))
		)
		q = q.where(ExistsCriterion(any_link) if linked else ~ExistsCriterion(any_link))
	if status:
		q = q.where(C.status == status)
	return q, C


def list_contacts(
	search: str | None = None,
	link_doctype: str | None = None,
	link_name: str | None = None,
	has_whatsapp: bool | None = None,
	blacklisted: bool | None = None,
	linked: bool | None = None,
	status: str | None = None,
	page: int = 1,
	page_length: int = 20,
	order_by: str = "modified desc",
) -> dict[str, Any]:
	"""Contacts page for the product Contacts screen: READ field sets + phones + party links +
	WhatsApp Number counters. Returns `{rows, total, page, page_length}`."""
	require("read")
	field, _sep, direction = (order_by or "modified desc").strip().partition(" ")
	if field not in ORDERABLE_FIELDS or direction.lower() not in ("", "asc", "desc"):
		frappe.throw(_("Cannot order by {0}").format(order_by), WAValidationError)
	start, length = _page(page, page_length)
	q, C = _contact_query(search, link_doctype, link_name, has_whatsapp, blacklisted, linked, status)
	total = q.select(Count("*")).run()[0][0]
	order_col = getattr(C, field)
	rows = (
		q.select(*[getattr(C, f) for f in CONTACT_READ_FIELDS])
		.orderby(order_col, order=Order.asc if direction.lower() == "asc" else Order.desc)
		.orderby(C.name)
		.limit(length)
		.offset(start)
		.run(as_dict=True)
	)
	_attach_children(rows)
	_audit_read(
		count=len(rows),
		filters=[
			k
			for k, v in {
				"search": search,
				"link_doctype": link_doctype,
				"link_name": link_name,
				"has_whatsapp": has_whatsapp,
				"blacklisted": blacklisted,
				"linked": linked,
				"status": status,
			}.items()
			if v not in (None, "")
		],
	)
	return {"rows": rows, "total": int(total), "page": max(cint(page) or 1, 1), "page_length": length}


def get_contact(name: str) -> dict[str, Any]:
	"""One contact through the READ sets (never the whole document)."""
	require("read")
	row = frappe.db.get_value("Contact", name, list(CONTACT_READ_FIELDS), as_dict=True)
	if not row:
		frappe.throw(_("Contact {0} not found").format(name), WANotFoundError)
	_attach_children([row])
	_audit_read(count=1, contact=name)
	return row


def contact_stats() -> dict[str, int]:
	"""The Contacts screen's own numbers, in one read instead of four paged ones.

	`linked` counts the contacts tied to at least one account, `multi_linked` those tied to more
	than one, and every count is taken through the same filtered query the list uses — so a Contact
	User's numbers describe exactly the rows that user may see. One audit row, not four.
	"""
	require("read")
	C = frappe.qb.DocType("Contact")
	D = frappe.qb.DocType("Dynamic Link")

	def total_of(**kwargs) -> int:
		q, _c = _contact_query(**kwargs)
		return int(q.select(Count("*")).run()[0][0])

	links = (
		frappe.qb.from_(D)
		.select(D.parent, Count("*").as_("n"))
		.where((D.parenttype == "Contact") & (D.link_doctype.isin(list(PARTY_TYPES))))
		.groupby(D.parent)
		.run(as_dict=True)
	)
	names = {row["parent"] for row in links}
	multi = {row["parent"] for row in links if cint(row["n"]) > 1}
	# a link row may point at a contact this user cannot see: count only the ones in the query
	visible = {
		row[0]
		for row in _contact_query()[0].select(C.name).run()
	}
	stats = {
		"total": total_of(),
		"linked": len(names & visible),
		"multi_linked": len(multi & visible),
		"with_whatsapp": total_of(has_whatsapp=True),
		"blacklisted": total_of(blacklisted=True),
	}
	stats["unlinked"] = max(0, stats["total"] - stats["linked"])
	_audit_read(count=stats["total"], filters=["stats"])
	return stats


def count_contacts(txt: str | None = None) -> int:
	"""Number of contacts `search_contacts(txt)` would page through (same query, no audit row)."""
	require("read")
	q, _c = _contact_query(search=txt)
	return cint(q.select(Count("*")).run()[0][0])


def search_contacts(txt: str | None = None, page: int = 1, page_length: int = 20) -> list[dict[str, Any]]:
	"""ContactPicker source 2: `name, full_name, image` + phones for contacts matching `txt`."""
	require("read")
	start, length = _page(page, page_length)
	q, C = _contact_query(search=txt)
	rows = (
		q.select(*[getattr(C, f) for f in CONTACT_SEARCH_FIELDS])
		.orderby(C.full_name)
		.orderby(C.name)
		.limit(length)
		.offset(start)
		.run(as_dict=True)
	)
	phones = _phones_for([r["name"] for r in rows])
	for r in rows:
		r["phone_nos"] = phones.get(r["name"], [])
	_audit_read(count=len(rows), search=bool(txt))
	return rows


def search_party(
	party_type: str, txt: str | None = None, page: int = 1, page_length: int = 20
) -> list[dict[str, Any]]:
	"""`{name, title}` rows of one party DocType (name + its title field only)."""
	require("read")
	if party_type not in PARTY_TYPES:
		frappe.throw(_("Unsupported party type {0}").format(party_type), WAValidationError)
	meta = frappe.get_meta(party_type)
	title_field = meta.get_title_field() if meta.get_title_field() != "name" else None
	start, length = _page(page, page_length)
	filters: list[list[Any]] = []
	or_filters: list[list[Any]] = []
	if meta.has_field("disabled"):
		filters.append([party_type, "disabled", "=", 0])
	if meta.has_field("status") and party_type == "Employee":
		filters.append([party_type, "status", "=", "Active"])
	if txt:
		like = f"%{txt.strip()}%"
		or_filters.append([party_type, "name", "like", like])
		if title_field:
			or_filters.append([party_type, title_field, "like", like])
	fields = ["name"] + ([f"`{title_field}` as title"] if title_field else [])
	rows = frappe.get_all(
		party_type,
		filters=filters,
		or_filters=or_filters,
		fields=fields,
		order_by=f"{title_field or 'name'} asc",
		start=start,
		page_length=length,
		ignore_permissions=True,
	)
	for r in rows:
		r.setdefault("title", r["name"])
	_audit_read(count=len(rows), party_type=party_type)
	return rows


# --------------------------------------------------------------------------------------------
# Picker source 3 — system DocType rows
# --------------------------------------------------------------------------------------------


def _normalize_filter_item(item: Any) -> list[Any]:
	"""`[field, op, value]` / `[doctype, field, op, value]` / `[field, value]` → `[field, op, value]`."""
	if isinstance(item, list | tuple):
		if len(item) == 4:
			item = item[1:]
		if len(item) == 2:
			item = [item[0], "=", item[1]]
		if len(item) == 3:
			return [item[0], item[1], item[2]]
	raise ValueError(_("filter must be [field, operator, value]"))


def validate_filters(meta, filters: Any) -> list[list[Any]]:
	"""Normalize `filters` (list or dict) and check every fieldname / operator against `meta`.
	Raises `ValueError` — callers wrap it into `WAValidationError`."""
	if not filters:
		return []
	if isinstance(filters, str):
		filters = json.loads(filters)
	items: list[Any]
	if isinstance(filters, dict):
		items = [
			[k, *v] if isinstance(v, list | tuple) and len(v) == 2 else [k, "=", v]
			for k, v in filters.items()
		]
	elif isinstance(filters, list):
		items = list(filters)
	else:
		raise ValueError(_("filters must be a list or an object"))
	out: list[list[Any]] = []
	for item in items:
		field, op, value = _normalize_filter_item(item)
		op = str(op).strip().lower()
		if not isinstance(field, str) or (field not in STANDARD_FIELDS and not meta.has_field(field)):
			raise ValueError(_("unknown field {0}").format(field))
		if op not in FILTER_OPERATORS:
			raise ValueError(_("operator {0} is not allowed").format(op))
		if isinstance(value, dict):
			raise ValueError(_("filter values cannot be objects"))
		out.append([field, op, value])
	return out


def _picker_source(document_type: str):
	settings = frappe.get_cached_doc("WhatsApp Settings")
	for row in settings.get("picker_sources") or []:
		if row.document_type == document_type and cint(row.enabled):
			return row
	frappe.throw(_("{0} is not an enabled picker source").format(document_type), WAPermissionError)


def list_doctype_rows(
	document_type: str,
	filters: Any = None,
	page: int = 1,
	page_length: int = 50,
) -> dict[str, Any]:
	"""ContactPicker source 3: `{name, label, phone, phone_e164, contact}` rows of an enabled
	picker DocType. Client filters are validated and **merged with the source's server filters**
	(`filters_json`, gap G-1); the read is elevated (`ignore_permissions`) but limited to
	`PICKER_ROW_FIELDS`."""
	require("read")
	source = _picker_source(document_type)
	meta = frappe.get_meta(document_type)
	try:
		client_filters = validate_filters(meta, filters)
		server_filters = validate_filters(
			meta, json.loads(source.filters_json) if source.filters_json else []
		)
	except (ValueError, TypeError) as exc:
		frappe.throw(_("Invalid filters: {0}").format(exc), WAValidationError)
	merged = [[document_type, *f] for f in server_filters + client_filters]

	title_field = source.name_fieldname or meta.get_title_field()
	if title_field and title_field != "name" and not meta.has_field(title_field):
		title_field = None
	fields = ["name"]
	if title_field and title_field != "name":
		fields.append(f"`{title_field}` as label")
	phone_field = contact_field = None
	if source.phone_source == "Field" and source.phone_fieldname and meta.has_field(source.phone_fieldname):
		phone_field = source.phone_fieldname
		fields.append(f"`{phone_field}` as phone")
	elif source.phone_source == "Linked Contact":
		contact_field = source.contact_fieldname or next(
			(f.fieldname for f in meta.get_link_fields() if f.options == "Contact"), None
		)
		if contact_field and meta.has_field(contact_field):
			fields.append(f"`{contact_field}` as contact")
		else:
			contact_field = None
	start, length = _page(page, page_length)
	rows = frappe.get_all(
		document_type,
		filters=merged,
		fields=fields,
		order_by=f"{title_field or 'name'} asc",
		start=start,
		page_length=length,
		ignore_permissions=True,
	)
	if contact_field:
		phones = _phones_for(sorted({r["contact"] for r in rows if r.get("contact")}))
		for r in rows:
			primary = next(iter(phones.get(r.get("contact") or "", [])), None)
			r["phone"] = primary["phone"] if primary else None
	for r in rows:
		r.setdefault("label", r["name"])
		r.setdefault("contact", None)
		r["phone_e164"] = normalize(r.get("phone")) if r.get("phone") else None
	_audit_read(count=len(rows), document_type=document_type)
	total = frappe.db.count(document_type, filters=merged)
	return {"rows": rows, "total": total, "page": max(cint(page) or 1, 1), "page_length": length}


# --------------------------------------------------------------------------------------------
# Internal (system) helpers
# --------------------------------------------------------------------------------------------


def contact_phones(contact: str) -> list[str]:
	"""E.164 phones of one contact (caller's context; no elevation, no audit)."""
	return [
		p
		for p in frappe.get_all(
			"Contact Phone",
			filters={"parenttype": "Contact", "parent": contact},
			pluck="wa_phone_e164",
			order_by="is_primary_mobile_no desc, idx asc",
			ignore_permissions=True,
		)
		if p
	]


def resolve_contact_by_phone(phone_e164: str | None) -> str | None:
	"""Contact whose `Contact Phone.wa_phone_e164` equals the key (system use: inbound, numbers)."""
	key = normalize(phone_e164) if phone_e164 else None
	if not key:
		return None
	rows = frappe.get_all(
		"Contact Phone",
		filters={"parenttype": "Contact", "wa_phone_e164": key},
		pluck="parent",
		order_by="is_primary_mobile_no desc, creation asc",
		limit=1,
		ignore_permissions=True,
	)
	return rows[0] if rows else None


# --------------------------------------------------------------------------------------------
# Writes
# --------------------------------------------------------------------------------------------


def _check_keys(payload: dict[str, Any], allowed: Iterable[str], label: str) -> None:
	unknown = sorted(set(payload) - set(allowed))
	if unknown:
		frappe.throw(_("{0}: unknown fields {1}").format(label, ", ".join(unknown)), WAValidationError)


def _validated_payload(
	payload: dict[str, Any] | None,
) -> tuple[dict[str, Any], list[dict] | None, list[dict] | None]:
	"""Split a create/update payload into scalar fields, phone rows and link rows; reject unknown keys."""
	if not isinstance(payload, dict):
		frappe.throw(_("payload must be an object"), WAValidationError)
	_check_keys(payload, (*CONTACT_WRITE_FIELDS, *CONTACT_TABLE_KEYS), "Contact")
	scalars = {k: payload[k] for k in CONTACT_WRITE_FIELDS if k in payload}
	phones = links = None
	if "phone_nos" in payload:
		phones = []
		for i, row in enumerate(payload.get("phone_nos") or [], start=1):
			if not isinstance(row, dict):
				frappe.throw(_("phone_nos[{0}] must be an object").format(i), WAValidationError)
			_check_keys(row, CONTACT_PHONE_WRITE_FIELDS, f"phone_nos[{i}]")
			if not normalize(row.get("phone")):
				frappe.throw(_("phone_nos[{0}]: invalid phone number").format(i), WAValidationError)
			phones.append(
				{"phone": row["phone"], "is_primary_mobile_no": cint(row.get("is_primary_mobile_no"))}
			)
		if phones and not any(p["is_primary_mobile_no"] for p in phones):
			phones[0]["is_primary_mobile_no"] = 1
	if "links" in payload:
		links = []
		for i, row in enumerate(payload.get("links") or [], start=1):
			if not isinstance(row, dict):
				frappe.throw(_("links[{0}] must be an object").format(i), WAValidationError)
			_check_keys(row, CONTACT_LINK_WRITE_FIELDS, f"links[{i}]")
			if row.get("link_doctype") not in PARTY_TYPES:
				frappe.throw(_("links[{0}]: unsupported party type").format(i), WAValidationError)
			if not row.get("link_name") or not frappe.db.exists(row["link_doctype"], row["link_name"]):
				frappe.throw(
					_("links[{0}]: {1} not found").format(i, row.get("link_name")), WAValidationError
				)
			links.append({"link_doctype": row["link_doctype"], "link_name": row["link_name"]})
	return scalars, phones, links


def _apply_tables(doc, phones: list[dict] | None, links: list[dict] | None) -> list[str]:
	written: list[str] = []
	if phones is not None:
		doc.set("phone_nos", [])
		for p in phones:
			doc.append("phone_nos", p)
		written.append("phone_nos")
	if links is not None:
		# Keep links to non-party DocTypes untouched; replace the party links as a set.
		kept = [
			{"link_doctype": r.link_doctype, "link_name": r.link_name}
			for r in doc.get("links") or []
			if r.link_doctype not in PARTY_TYPES
		]
		doc.set("links", [])
		for r in kept + links:
			doc.append("links", r)
		written.append("links")
	return written


def create_contact(payload: dict[str, Any]) -> str:
	"""Insert a Contact from the WRITE sets only, as the session user; audited."""
	require("create")
	scalars, phones, links = _validated_payload(payload)
	if not scalars.get("first_name"):
		frappe.throw(_("first_name is required"), WAValidationError)
	doc = frappe.get_doc({"doctype": "Contact", **scalars})
	written = list(scalars) + _apply_tables(doc, phones, links)
	doc.flags.ignore_permissions = True
	doc.insert(ignore_permissions=True)
	_audit_write(doc.name, written, reason="create")
	return doc.name


def update_contact(name: str, payload: dict[str, Any]) -> str:
	"""Update WRITE-set fields of a Contact as the session user; phone / link rows are replaced as
	a set when present in `payload`; audited with the fieldnames written."""
	require("write")
	scalars, phones, links = _validated_payload(payload)
	if not frappe.db.exists("Contact", name):
		frappe.throw(_("Contact {0} not found").format(name), WANotFoundError)
	doc = frappe.get_doc("Contact", name)
	written = [k for k, v in scalars.items() if (doc.get(k) or None) != (v or None)]
	for k in written:
		doc.set(k, scalars[k])
	written += _apply_tables(doc, phones, links)
	if not written:
		return name
	doc.flags.ignore_permissions = True
	doc.save(ignore_permissions=True)
	_audit_write(name, written, reason="update")
	return name


def link_number(phone_e164: str, contact: str, user: str | None = None) -> str:
	"""Link a `WhatsApp Number` row to a Contact (`contact, link_status, linked_by, linked_at,
	display_name`); audited `Number Linked`."""
	require("write")
	kind, key = classify(phone_e164)
	if not kind or not frappe.db.exists("WhatsApp Number", key):
		frappe.throw(_("WhatsApp Number {0} not found").format(phone_e164), WANotFoundError)
	full_name = frappe.db.get_value("Contact", contact, "full_name")
	if full_name is None:
		frappe.throw(_("Contact {0} not found").format(contact), WANotFoundError)
	values = {
		"contact": contact,
		"link_status": "Linked",
		"linked_by": user or frappe.session.user,
		"linked_at": now_datetime(),
		"display_name": full_name or frappe.db.get_value("WhatsApp Number", key, "display_name"),
	}
	frappe.db.set_value("WhatsApp Number", key, values, update_modified=True)
	audit.log(
		"Number Linked",
		reference=("WhatsApp Number", key),
		target=("Contact", contact),
		fields_written=values.keys(),
		user=user,
	)
	return key


def convert_number(
	phone_e164: str,
	first_name: str,
	last_name: str | None = None,
	party_type: str | None = None,
	party_name: str | None = None,
	user: str | None = None,
) -> str:
	"""Create a Contact from a `WhatsApp Number` (phone row from the number, optional party link)
	and link the number to it; audited `Number Converted` + `Elevated Contact Write`."""
	require("create")
	kind, key = classify(phone_e164)
	if kind != "Individual" or not frappe.db.exists("WhatsApp Number", key):
		frappe.throw(
			_("WhatsApp Number {0} not found or not an individual number").format(phone_e164), WANotFoundError
		)
	existing = frappe.db.get_value("WhatsApp Number", key, "contact")
	if existing:
		frappe.throw(_("Number {0} is already linked to {1}").format(key, existing), WAStateConflictError)
	payload: dict[str, Any] = {
		"first_name": first_name,
		"last_name": last_name,
		"phone_nos": [{"phone": key, "is_primary_mobile_no": 1}],
	}
	if party_type or party_name:
		payload["links"] = [{"link_doctype": party_type, "link_name": party_name}]
	contact = create_contact({k: v for k, v in payload.items() if v is not None})
	link_number(key, contact, user=user)
	audit.log("Number Converted", reference=("WhatsApp Number", key), target=("Contact", contact), user=user)
	return contact


def add_contact_link(name: str, link_doctype: str, link_name: str) -> list[str]:
	"""Add one party link to a Contact (bulk "contacts link", 09 G-01) through `update_contact`;
	returns the fieldnames written (empty when the link already exists)."""
	require("write")
	if not frappe.db.exists("Contact", name):
		frappe.throw(_("Contact {0} not found").format(name), WANotFoundError)
	current = [
		{"link_doctype": r["link_doctype"], "link_name": r["link_name"]}
		for r in _links_for([name]).get(name, [])
	]
	if any(r["link_doctype"] == link_doctype and r["link_name"] == link_name for r in current):
		return []
	update_contact(name, {"links": [*current, {"link_doctype": link_doctype, "link_name": link_name}]})
	return ["links"]


def unlink_number(phone_e164: str, user: str | None = None) -> str:
	"""Detach a `WhatsApp Number` from its Contact (`contact`, `linked_by`, `linked_at` cleared,
	`link_status` = Not Linked); audited `Number Linked` with `details.unlinked=1`. The role gate
	(Manager) is the API's; the Contact itself is not touched."""
	kind, key = classify(phone_e164)
	if not kind or not frappe.db.exists("WhatsApp Number", key):
		frappe.throw(_("WhatsApp Number {0} not found").format(phone_e164), WANotFoundError)
	previous = frappe.db.get_value("WhatsApp Number", key, "contact")
	values = {"contact": None, "link_status": "Not Linked", "linked_by": None, "linked_at": None}
	frappe.db.set_value("WhatsApp Number", key, values, update_modified=True)
	audit.log(
		"Number Linked",
		reference=("WhatsApp Number", key),
		target=("Contact", previous) if previous else None,
		fields_written=values.keys(),
		details={"unlinked": 1},
		user=user,
	)
	return key


def confirm_conversation(
	phone_e164: str, confirmed: bool, note: str | None = None, user: str | None = None
) -> bool:
	"""Set / clear `conversation_confirmed` (+ by / at / note) on a `WhatsApp Number`; audited
	`Conversation Confirmed`. Returns the resulting flag."""
	kind, key = classify(phone_e164)
	if not kind or not frappe.db.exists("WhatsApp Number", key):
		frappe.throw(_("WhatsApp Number {0} not found").format(phone_e164), WANotFoundError)
	who = user or frappe.session.user
	values = {
		"conversation_confirmed": 1 if confirmed else 0,
		"conversation_confirmed_by": who if confirmed else None,
		"conversation_confirmed_at": now_datetime() if confirmed else None,
		"conversation_note": (note or "")[:500] or None,
	}
	frappe.db.set_value("WhatsApp Number", key, values, update_modified=True)
	audit.log(
		"Conversation Confirmed",
		reference=("WhatsApp Number", key),
		fields_written=values.keys(),
		reason=note,
		details={"confirmed": bool(confirmed)},
		user=user,
	)
	return bool(confirmed)


def conversation_log(phone_e164: str, limit: int = 50) -> list[dict[str, Any]]:
	"""The number's conversation-state history (09 G-06), newest first: `[{at, user, user_name,
	confirmed, note}]` from its `Conversation Confirmed` audit rows. Only these columns — never the
	IP address or the raw row — so a Contact User may read it. P: Contact read."""
	require("read")
	kind, key = classify(phone_e164)
	if not kind or not frappe.db.exists("WhatsApp Number", key):
		frappe.throw(_("WhatsApp Number {0} not found").format(phone_e164), WANotFoundError)
	rows = frappe.get_all(
		"WhatsApp Audit Log",
		filters={"action": "Conversation Confirmed", "reference_doctype": "WhatsApp Number", "reference_name": key},
		fields=["timestamp", "creation", "user", "reason", "details"],
		order_by="creation desc",
		limit=cint(limit) or 50,
	)
	names = {u: frappe.utils.get_fullname(u) for u in {r.user for r in rows if r.user}}
	out = []
	for r in rows:
		try:
			details = json.loads(r.details) if isinstance(r.details, str) else (r.details or {})
		except ValueError:
			details = {}
		out.append(
			{
				"at": r.timestamp or r.creation,
				"user": r.user,
				"user_name": names.get(r.user) or r.user,
				"confirmed": bool(details.get("confirmed")),
				"note": r.reason,
			}
		)
	return out


def toggle_blacklist(key: str, blocked: bool, note: str | None = None, user: str | None = None) -> bool:
	"""Add to / remove from the global blacklist group; returns the resulting state. Requires
	write on `WhatsApp Contact Group` (CU, AGT, MGR); audited `Contact Group Members Changed`."""
	if not frappe.has_permission("WhatsApp Contact Group", "write"):
		frappe.throw(_("Not permitted to change the blacklist"), WAPermissionError)
	kind, norm = classify(key)
	if not kind:
		frappe.throw(_("Invalid WhatsApp number or JID"), WAValidationError)
	group_name = _blacklist_group()
	if not group_name:
		frappe.throw(_("No global blacklist group is configured in WhatsApp Settings"), WAStateConflictError)
	group = frappe.get_doc("WhatsApp Contact Group", group_name)
	rows = [r for r in group.get("members") or [] if r.phone_e164 == norm]
	if bool(blocked) == bool(rows):
		return bool(rows)  # already in the requested state
	if blocked:
		group.append(
			"members",
			{
				"phone": norm,
				"phone_e164": norm,
				"source_type": "Manual",
				"note": note,
				"contact": resolve_contact_by_phone(norm) if kind == "Individual" else None,
			},
		)
	else:
		for r in rows:
			group.remove(r)
	group.flags.ignore_permissions = True
	group.save(ignore_permissions=True)
	audit.log(
		"Contact Group Members Changed",
		reference=("WhatsApp Contact Group", group_name),
		count=1,
		reason=note,
		details={"blocked": bool(blocked), "key": norm},
		user=user,
	)
	return bool(blocked)
