# Module role: controller of `WhatsApp Template` — compile-checks the Jinja body on save and
# requires a Print Format for Document templates. Rendering happens in services at send time.

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils.jinja import validate_template

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services import standards


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

	# ---- standard content (`services/standards.py`): what a fixture sync may change ----------

	@staticmethod
	def prepare_for_import(docdict: dict) -> None:
		"""Frappe import hook: a shipped record keeps what the site owns."""
		standards.prepare_for_import(docdict)

	def before_import(self) -> None:
		"""Frappe import hook: a record kept as the owner's is re-inserted as it is."""
		standards.before_import(self)

	def after_insert(self) -> None:
		"""Finish a fixture import of a shipped record (no-op for any other insert)."""
		standards.after_insert(self)
