# Module role: what every editor service checks in the payload its window sends — that it is an
# object, that it names no field the service does not take, that a record was not saved elsewhere
# since the window opened — plus the options of a Select field and a child table replaced from
# rows. One place, so every editor answers the same way with the same (translated) words.

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

import frappe
from frappe import _
from frappe.utils import get_datetime

from whatsapp_next.exceptions import WAValidationError


def require_object(payload: Any) -> dict:
	"""The payload, refused unless it is an object."""
	if not isinstance(payload, dict):
		frappe.throw(_("payload must be an object"), WAValidationError)
	return payload


def reject_unknown(payload: dict, allowed: Iterable[str]) -> None:
	"""Refuse a payload naming a key outside ``allowed`` — never a field name taken from the client."""
	unknown = sorted(set(payload) - set(allowed))
	if unknown:
		frappe.throw(_("Unknown payload keys: {0}").format(", ".join(unknown)), WAValidationError)


def select_options(doctype: str, fieldname: str, default: list[str] | None = None) -> list[str]:
	"""A Select field's options from the DocType meta; ``default`` (or nothing) when it is missing."""
	df = frappe.get_meta(doctype).get_field(fieldname)
	if not df:
		return list(default or [])
	return [o for o in (df.options or "").split("\n") if o]


def replace_recipients(doc, rows: Any, fields: Iterable[str]) -> None:
	"""Replace ``doc``'s ``recipients`` table with ``rows``, keeping only ``fields`` that hold a
	value; anything in ``rows`` that is not an object is skipped."""
	rows = rows or []
	if not isinstance(rows, list):
		frappe.throw(_("recipients must be a list"), WAValidationError)
	fields = tuple(fields)
	doc.set("recipients", [])
	for row in rows:
		if isinstance(row, dict):
			doc.append("recipients", {f: row.get(f) for f in fields if row.get(f) not in (None, "")})


def refuse_stale(doc, opened: Any, message: str) -> None:
	"""Refuse to overwrite an edit saved elsewhere after the window opened (``opened`` is the
	``modified`` the window was given); ``message`` says so in the editor's own words."""
	if opened and get_datetime(opened) != get_datetime(doc.modified):
		frappe.throw(message, WAValidationError)
