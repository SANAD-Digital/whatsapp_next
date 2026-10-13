# Module role: WhatsApp Function controller — an installed function: the Server Script that holds it and
# its WA-FUNCTION header as installed (fields.md §16, WHATSAPP_NEXT_INTEGRATION §3.1). Validation only:
# the script is a function script, `values` is an object of the header's parameters. Install / update /
# remove live in `api/v1/functions.py` + `services/functions_catalog.py`.

from __future__ import annotations

import json

import frappe
from frappe import _
from frappe.model.document import Document

from whatsapp_next.exceptions import WAValidationError

ALLOWED_PARTY_TYPES = ("Customer", "Supplier", "Employee", "Sales Person", "User")


class WhatsAppFunction(Document):
	"""A function installed from its Server Script."""

	def validate(self) -> None:
		"""The script's API method starts with `wa_fn_`; `values` names header parameters only."""
		from whatsapp_next.services import function_header as fh

		method = (
			frappe.db.get_value("Server Script", self.server_script, "api_method")
			if self.server_script
			else None
		)
		if not (method or "").startswith(fh.API_PREFIX):
			frappe.throw(
				_("Server Script {0} is not a function: its API method must start with {1}").format(
					self.server_script, fh.API_PREFIX
				),
				WAValidationError,
			)
		self.check_values()

	def check_values(self) -> None:
		from whatsapp_next.services import function_header as fh
		from whatsapp_next.services.functions_catalog import manifest_of

		if not self.get("values"):
			return
		try:
			values = json.loads(self.values) if isinstance(self.values, str) else self.values
		except ValueError:
			frappe.throw(_("Values must be valid JSON"), WAValidationError)
		if not isinstance(values, dict):
			frappe.throw(_("Values must be a JSON object"), WAValidationError)
		names = {p["name"] for p in fh.command_params(manifest_of(self))}
		unknown = sorted(set(values) - names)
		if unknown:
			frappe.throw(
				_("Unknown parameters for function {0}: {1}").format(self.name, ", ".join(unknown)),
				WAValidationError,
			)


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
