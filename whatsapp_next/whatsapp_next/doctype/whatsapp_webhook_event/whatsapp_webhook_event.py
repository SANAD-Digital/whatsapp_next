# Module role: controller of `WhatsApp Webhook Event`, the raw inbound event store — defaults and
# the status-writer guard. Rows are inserted by webhooks/v1/receiver.py and processed by
# services/webhook.py.

from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import now_datetime

from whatsapp_next.services.guards import assert_status_writer


class WhatsAppWebhookEvent(Document):
	"""One provider webhook delivery (deduplicated on `event_id`)."""

	def validate(self) -> None:
		"""Fill `received_at` and guard `status`."""
		if not self.received_at:
			self.received_at = now_datetime()
		if not self.status:
			self.status = "Received"
		assert_status_writer(self, ("status",))


# Composite indexes the DocType JSON cannot express (fields.md F-11); single-column ones are
# `search_index` / `unique` in the JSON.
COMPOSITE_INDEXES: tuple[tuple[str, ...], ...] = (
	("event_name", "received_at"),
)
COMPOSITE_UNIQUE: tuple[tuple[str, ...], ...] = (
	("event_name", "event_id"),
)  # one event id spans sent/delivered/read (D-047)


def on_doctype_update() -> None:
	"""Called by Frappe whenever it syncs this DocType (install, and a migrate that changes it):
	create the composite indexes that are missing. Idempotent."""
	for fields in COMPOSITE_INDEXES:
		frappe.db.add_index("WhatsApp Webhook Event", list(fields))
	for fields in COMPOSITE_UNIQUE:
		frappe.db.add_unique("WhatsApp Webhook Event", list(fields))
