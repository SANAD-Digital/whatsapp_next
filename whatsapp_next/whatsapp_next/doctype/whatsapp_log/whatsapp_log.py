# Module role: controller of `WhatsApp Log`, the outbound message of record (D-027) — recipient
# normalization, source consistency and the status-writer guard. Dispatch, retries and status
# transitions belong to services/dispatch.py.

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services.guards import assert_status_writer
from whatsapp_next.services.phone import set_phone_pair


class WhatsAppLog(Document):
	"""One outbound WhatsApp message and its delivery history."""

	def validate(self) -> None:
		"""Normalize the recipient, check source links and guard `status`."""
		if not self.status:
			self.status = "Unsent"
		self._validate_recipient()
		self._validate_source()
		assert_status_writer(self, ("status",))

	def _validate_recipient(self) -> None:
		if self.recipient_type == "Group":
			if not self.jid:
				frappe.throw(_("JID is required for Group recipients"), WAValidationError)
			set_phone_pair(self, "phone", "phone_e164", required=True, jid_field="jid")
			return
		set_phone_pair(self, "phone", "phone_e164", required=True)

	def _validate_source(self) -> None:
		if self.campaign and self.source_type != "Campaign":
			frappe.throw(_("Source must be Campaign when a Campaign is linked"), WAValidationError)
		if self.reference_name and not self.reference_doctype:
			frappe.throw(_("Reference DocType is required with a Reference Name"), WAValidationError)


# Composite indexes the DocType JSON cannot express (fields.md F-11); single-column ones are
# `search_index` / `unique` in the JSON.
COMPOSITE_INDEXES: tuple[tuple[str, ...], ...] = (
	("device", "creation"),
	("reference_doctype", "reference_name"),
	("status", "scheduled_at"),
	("command", "creation"),
	("notification", "creation"),
)


def on_doctype_update() -> None:
	"""Called by Frappe whenever it syncs this DocType (install, and a migrate that changes it):
	create the composite indexes that are missing. Idempotent."""
	for fields in COMPOSITE_INDEXES:
		frappe.db.add_index("WhatsApp Log", list(fields))
