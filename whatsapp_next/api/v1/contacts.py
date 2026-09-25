# Module role: API of the product Contacts screen (backend-plan §4.8, screen 12). Every function is
# a thin wrapper over `services/permissions.py`, the contextual permission layer: `roles=None`
# because the gate is "WhatsApp Contact User OR native Contact permission", checked inside the
# service (`permissions.require`). Only declared field sets are read or written; every elevated
# access is audited by the service.

from __future__ import annotations

from typing import Any

import frappe
from frappe import _

from whatsapp_next.api._common import api_endpoint
from whatsapp_next.api.v1 import _bulk
from whatsapp_next.api.v1._roles import AGENT_UP, CONTACT_USER
from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services import permissions


@api_endpoint(roles=None, methods=("GET", "POST"))
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
	"""Contacts page: READ field set + phones + party links + WhatsApp Number counters. Returns
	`{rows, total, page, page_length}`. `linked` filters on "tied to at least one account" and
	`status` on the contact's own status, both in the query. P: Contact User | Contact read."""
	permissions.require("read")
	return permissions.list_contacts(
		search=search,
		link_doctype=link_doctype,
		link_name=link_name,
		has_whatsapp=has_whatsapp,
		blacklisted=blacklisted,
		linked=linked,
		status=status,
		page=page,
		page_length=page_length,
		order_by=order_by,
	)


@api_endpoint(roles=None, methods=("GET", "POST"))
def get_stats() -> dict[str, int]:
	"""The Contacts screen's own numbers — `{total, linked, unlinked, multi_linked, with_whatsapp,
	blacklisted}` — counted through the same filtered query the list uses, in one audited read.
	P: Contact User | Contact read."""
	permissions.require("read")
	return permissions.contact_stats()


@api_endpoint(roles=None, methods=("GET", "POST"))
def get_contact(name: str) -> dict[str, Any]:
	"""One contact through the READ sets: fields + `phone_nos[]` + `links[]` + number counters.
	P: Contact User | Contact read. E: `WANotFoundError`."""
	permissions.require("read")
	row = permissions.get_contact(name)
	row["numbers"] = permissions.contact_phones(name)
	return row


@api_endpoint(roles=None)
def create_contact(payload: dict) -> dict[str, str]:
	"""Insert a Contact from the WRITE field set (`first_name`, `last_name?`, `salutation?`,
	`designation?`, `company_name?`, `email_id?`, `phone_nos[]`, `links[]`). P: Contact User |
	Contact create. E: `WAValidationError` (unknown key / invalid phone); audited."""
	permissions.require("create")
	return {"name": permissions.create_contact(payload)}


@api_endpoint(roles=None)
def update_contact(name: str, payload: dict) -> dict[str, Any]:
	"""Partial update with the same payload shape (tables replaced as a set when present).
	P: Contact User | Contact write. E: `WANotFoundError`, `WAValidationError`; audited."""
	permissions.require("write")
	permissions.update_contact(name, payload)
	return {"name": name, "fields_written": sorted(payload or {})}


@api_endpoint(roles=None, methods=("GET", "POST"))
def search_party(party_type: str, txt: str | None = None, page: int = 1, page_length: int = 20) -> list[dict]:
	"""`[{name, title}]` of one party DocType (`Customer`, `Supplier`, `Employee`, `Sales Person`).
	P: Contact User | Contact read. E: `WAValidationError` (unsupported party type)."""
	permissions.require("read")
	return permissions.search_party(party_type, txt, page=page, page_length=page_length)


@api_endpoint(roles=None, methods=("GET", "POST"))
def search_company(txt: str | None = None, page_length: int = 20) -> list[dict]:
	"""`[{name, title}]` of the site's own companies, for the contact form's Company link. The
	Company DocType grants no read to a plain Contact User, and a company's name is not a secret:
	the declared field set is `name` and `company_name`, nothing else. P: Contact User | Contact
	read."""
	permissions.require("read")
	length = min(max(int(page_length or 20), 1), 50)
	filters = {"company_name": ("like", f"%{(txt or '').strip()}%")} if (txt or "").strip() else None
	rows = frappe.get_all(
		"Company",
		filters=filters,
		fields=["name", "company_name"],
		order_by="company_name asc",
		limit=length,
		ignore_permissions=True,
	)
	return [{"name": r.name, "title": r.company_name or r.name} for r in rows]


ACTIVITY_FIELDS: tuple[str, ...] = ("name", "action", "summary", "reason", "user", "timestamp", "details")
ACTIVITY_LIMIT = 30


@api_endpoint(roles=None, methods=("GET", "POST"))
def get_activity(name: str) -> list[dict[str, Any]]:
	"""What happened to one contact, newest first, for the drawer's activity timeline: the audit
	rows written on the Contact itself (elevated writes, a number converted into it) and on its
	numbers (linked, conversation confirmed, blocked / unblocked). Only the columns a reader needs
	— never the IP address, never another record's rows. P: Contact User | Contact read."""
	permissions.require("read")
	phones = permissions.contact_phones(name)
	or_filters: list[list[Any]] = [
		["reference_doctype", "=", "Contact"],
		["target_doctype", "=", "Contact"],
	]
	rows = frappe.get_all(
		"WhatsApp Audit Log",
		filters=[["WhatsApp Audit Log", "name", "!=", ""]],
		or_filters=[
			[
				"WhatsApp Audit Log",
				"reference_name",
				"=",
				name,
			],
			["WhatsApp Audit Log", "target_name", "=", name],
			*([["WhatsApp Audit Log", "reference_name", "in", phones]] if phones else []),
		],
		fields=list(ACTIVITY_FIELDS),
		order_by="timestamp desc, name desc",
		limit=ACTIVITY_LIMIT,
	)
	del or_filters
	# a block / unblock is written on the blacklist group, with the number inside `details`
	if phones:
		for key in phones:
			rows += frappe.get_all(
				"WhatsApp Audit Log",
				filters={"action": "Contact Group Members Changed", "details": ("like", f'%"key": "{key}"%')},
				fields=list(ACTIVITY_FIELDS),
				order_by="timestamp desc",
				limit=ACTIVITY_LIMIT,
			)
	seen: set[str] = set()
	out: list[dict[str, Any]] = []
	for r in sorted(rows, key=lambda r: (str(r.timestamp or ""), r.name), reverse=True):
		if r.name in seen:
			continue
		seen.add(r.name)
		details = r.details if isinstance(r.details, dict) else {}
		if isinstance(r.details, str):
			try:
				details = frappe.parse_json(r.details) or {}
			except Exception:
				details = {}
		out.append(
			{
				"action": r.action,
				"summary": r.summary or r.action,
				"reason": r.reason,
				"user": r.user,
				"timestamp": r.timestamp,
				"blocked": details.get("blocked"),
				"confirmed": details.get("confirmed"),
			}
		)
		if len(out) >= ACTIVITY_LIMIT:
			break
	return out


@api_endpoint(roles=CONTACT_USER + AGENT_UP)
def toggle_blacklist(
	blocked: bool, contact: str | None = None, phone: str | None = None, note: str | None = None
) -> dict[str, bool]:
	"""Add to / remove from the global blacklist group (by `phone`, or the contact's primary
	number). P: Contact User, Agent, Manager. E: `WAStateConflictError` when no blacklist group
	is configured, `WAValidationError` for an invalid number."""
	key = phone
	if not key and contact:
		phones = permissions.contact_phones(contact)
		key = phones[0] if phones else None
	if not key:
		frappe.throw(_("A phone number or a contact with a phone is required"), WAValidationError)
	return {"blocked": permissions.toggle_blacklist(key, blocked, note=note)}


@api_endpoint(roles=None, methods=("GET", "POST"))
def get_contact_numbers(contact: str) -> list[dict[str, Any]]:
	"""`[{phone_e164, last_seen, outbound_count, inbound_count, conversation_confirmed}]` for the
	contact's phones that exist in `WhatsApp Number`. P: Contact User | Number read."""
	permissions.require("read")
	keys = permissions.contact_phones(contact)
	if not keys:
		return []
	return frappe.get_all(
		"WhatsApp Number",
		filters={"phone_e164": ("in", keys)},
		fields=["phone_e164", "last_seen", "outbound_count", "inbound_count", "conversation_confirmed"],
		order_by="last_seen desc",
	)


@api_endpoint(roles=None)
def link_many(names: list[str], link_doctype: str, link_name: str) -> dict[str, Any]:
	"""Bulk "contacts link" (09 G-01): add one party link to every contact in `names`; contacts that
	already carry the link are reported in `skipped`. P: Contact User | Contact write."""
	permissions.require("write")

	def one(name: str) -> None:
		if not permissions.add_contact_link(name, link_doctype, link_name):
			raise _bulk.Skip("already linked")

	return _bulk.run_bulk(names, one)
