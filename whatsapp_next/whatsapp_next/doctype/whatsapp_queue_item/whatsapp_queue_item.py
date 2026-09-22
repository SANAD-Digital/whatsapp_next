# Module role: controller of `WhatsApp Queue Item`, the dispatch state of one WhatsApp Log row
# (D-027, Frappe's Communication / Email Queue split) — defaults and the status-writer guard.
# Claiming, retries and state transitions belong to services/dispatch.py.

from __future__ import annotations

import frappe
from frappe.model.document import Document
from frappe.utils import cint, now_datetime

from whatsapp_next.services.guards import assert_status_writer


class WhatsAppQueueItem(Document):
	"""Dispatch state (attempts, schedule, pause / delete / dead letter) of one outbound message."""

	def validate(self) -> None:
		"""Fill denormalized defaults and guard `status`."""
		if not self.client_ref:
			self.client_ref = self.outbound_message
		if not cint(self.max_attempts):
			self.max_attempts = cint(frappe.db.get_single_value("WhatsApp Settings", "max_attempts")) or 1
		if not self.scheduled_at:
			self.scheduled_at = now_datetime()
		if not self.status:
			self.status = "Queued"
		assert_status_writer(self, ("status",))
