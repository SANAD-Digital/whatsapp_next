# Module role: child of WhatsApp Function — one installed setting (key/type/default/value). The parent
# calls `validate_value()` per row because Frappe does not run `validate` on child rows by itself.

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document

from whatsapp_next.exceptions import WAValidationError


class WhatsAppFunctionSetting(Document):
	"""One setting of an installed function; `value` is validated against `fieldtype` / `choices`."""

	def choice_list(self) -> list[str]:
		"""Return the `choices` lines stripped and without blanks."""
		return [c.strip() for c in (self.choices or "").splitlines() if c.strip()]

	def validate_value(self) -> None:
		"""Coerce and check `value` for the declared `fieldtype` (Check → 0/1, Int → int, Select → in choices)."""
		value = self.value
		if value is None or str(value).strip() == "":
			return
		value = str(value).strip()
		if self.fieldtype == "Check":
			if value not in ("0", "1"):
				frappe.throw(
					_("Setting {0} must be 0 or 1, not {1}").format(self.key, value),
					WAValidationError,
				)
		elif self.fieldtype == "Int":
			try:
				int(value)
			except ValueError:
				frappe.throw(
					_("Setting {0} must be an integer, not {1}").format(self.key, value),
					WAValidationError,
				)
		elif self.fieldtype == "Select":
			choices = self.choice_list()
			if choices and value not in choices:
				frappe.throw(
					_("Setting {0} must be one of {1}").format(self.key, ", ".join(choices)),
					WAValidationError,
				)
		self.value = value
