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
		self.update_available = (
			1 if self.latest_version and self.latest_version != self.installed_version else 0
		)
		check_unique_rows(self.get("settings"), "key", _("Setting key"))
		check_unique_rows(self.get("outputs"), "output_key", _("Output key"))
		for row in self.get("settings") or []:
			row.validate_value()
		check_party_types(self.get("party_types"))


def handler_exists(function_key: str | None) -> bool:
	"""True when `function_key` is registered in `whatsapp_next.functions.registry.FUNCTION_HANDLERS`."""
	if not function_key:
		return False
	try:
		from whatsapp_next.functions.registry import FUNCTION_HANDLERS
	except ImportError:
		return False
	return function_key in (FUNCTION_HANDLERS or {})


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
