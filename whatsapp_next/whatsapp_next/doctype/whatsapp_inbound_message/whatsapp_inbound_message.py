# Module role: controller of `WhatsApp Inbound Message` — sender normalization, derived flags and
# the `command_status` guard. Rows are written by services/inbound.py from webhook events;
# command routing lives in services/commands.py.

from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime

from whatsapp_next.services.guards import assert_status_writer
from whatsapp_next.services.phone import GROUP_SUFFIX, set_phone_pair


class WhatsAppInboundMessage(Document):
	"""One message (or reaction) received on a device."""

	def validate(self) -> None:
		"""Fill defaults, normalize the sender and guard `command_status`."""
		if not self.received_at:
			self.received_at = now_datetime()
		if not self.command_status:
			self.command_status = "None"
		set_phone_pair(self, "phone", "phone_e164", required=False)
		if self.chat_jid:
			self.is_group = 1 if self.chat_jid.strip().lower().endswith(GROUP_SUFFIX) else 0
		assert_status_writer(self, ("command_status",))


# Composite indexes the DocType JSON cannot express (fields.md F-11); single-column ones are
# `search_index` / `unique` in the JSON.
COMPOSITE_INDEXES: tuple[tuple[str, ...], ...] = (
	("device", "received_at"),
	("command", "received_at"),
)
COMPOSITE_UNIQUE: tuple[tuple[str, ...], ...] = (
	("device", "provider_message_id"),
)  # D-029 OQ-B, D-035


def on_doctype_update() -> None:
	"""Called by Frappe whenever it syncs this DocType (install, and a migrate that changes it):
	create the composite indexes that are missing. Idempotent."""
	for fields in COMPOSITE_INDEXES:
		frappe.db.add_index("WhatsApp Inbound Message", list(fields))
	for fields in COMPOSITE_UNIQUE:
		frappe.db.add_unique("WhatsApp Inbound Message", list(fields))
