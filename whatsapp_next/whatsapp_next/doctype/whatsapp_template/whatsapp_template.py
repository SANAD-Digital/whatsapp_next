# Module role: controller of `WhatsApp Template` — compile-checks the Jinja body on save and
# requires a Print Format for Document templates. Rendering happens in services at send time.

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils.jinja import validate_template

from whatsapp_next.exceptions import WAValidationError


class WhatsAppTemplate(Document):
	"""A reusable message body (Jinja) with optional document / image attachment."""

	def validate(self) -> None:
		"""Reject templates that cannot compile or lack the pieces their type needs."""
		self._validate_body()
		if self.message_type == "Document" and not self.print_format:
			frappe.throw(_("Print Format is required for Document templates"), WAValidationError)

	def _validate_body(self) -> None:
		try:
			validate_template(self.body)
		except frappe.ValidationError as exc:
			frappe.throw(_("Template body does not compile: {0}").format(exc), WAValidationError)
