# Module role: controller of `WhatsApp Inbound Message` — sender normalization, derived flags and
# the `command_status` guard. Rows are written by services/inbound.py from webhook events;
# command routing lives in services/commands.py.

from __future__ import annotations

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
