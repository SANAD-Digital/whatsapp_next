# Module role: WhatsApp Function controller — an installed catalog function (fields.md §16). Validation
# only: registry check for `handler_registered`, `update_available`, unique setting / output keys, and
# per-row value checks. Install / update / remove live in `api/v1/functions.py` + `services/functions_catalog.py`.

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document

from whatsapp_next.exceptions import WAValidationError

ALLOWED_PARTY_TYPES = ("Customer", "Supplier", "Employee", "Sales Person", "User")


class WhatsAppFunction(Document):
	"""Catalog function with its installed settings and output templates."""

	def validate(self) -> None:
		"""Compute derived flags and check child-table keys and values."""
		self.handler_registered = 1 if handler_exists(self.function_key) else 0
		self.update_available = update_available(self.installed_version, self.latest_version)
		check_unique_rows(self.get("settings"), "key", _("Setting key"))
		check_unique_rows(self.get("outputs"), "output_key", _("Output key"))
		for row in self.get("settings") or []:
			row.validate_value()
		check_party_types(self.get("party_types"))


def update_available(installed: str | None, latest: str | None) -> int:
	"""1 when the catalog's `latest` is a newer version than `installed` (semantic order, so a site
	ahead of its catalog — or `1.10.0` against `1.9.0` — is not "outdated")."""
	if not latest:
		return 0
	from whatsapp_next.services.functions_catalog import version_tuple

	return 1 if version_tuple(latest) > version_tuple(installed or "0") else 0


def handler_exists(function_key: str | None) -> bool:
	"""True when a handler is registered for `function_key` — built in or declared by another app
	through the `whatsapp_function_handlers` hook (`registry.is_registered` loads the hook first, so
	a fresh worker does not mark a hook-registered function as missing)."""
	if not function_key:
		return False
	try:
		from whatsapp_next.functions.registry import is_registered
	except ImportError:
		return False
	return is_registered(function_key)


def check_unique_rows(rows: list | None, fieldname: str, label: str) -> None:
	"""Reject a repeated `fieldname` value within `rows`."""
	seen: set[str] = set()
	for row in rows or []:
		value = (row.get(fieldname) or "").strip()
		if value in seen:
			frappe.throw(_("{0} {1} is repeated (row {2})").format(label, value, row.idx), WAValidationError)
		seen.add(value)


def check_party_types(rows: list | None) -> None:
	"""Every `party_type` row must be one of the five allowed DocTypes (fields.md F-01)."""
	for row in rows or []:
		if row.party_type not in ALLOWED_PARTY_TYPES:
			frappe.throw(
				_("Party type {0} is not allowed; choose one of {1}").format(
					row.party_type, ", ".join(ALLOWED_PARTY_TYPES)
				),
				WAValidationError,
			)
