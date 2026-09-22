# Module role: controller of `WhatsApp Webhook Event`, the raw inbound event store — defaults and
# the status-writer guard. Rows are inserted by webhooks/v1/receiver.py and processed by
# services/webhook.py.

from __future__ import annotations

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
