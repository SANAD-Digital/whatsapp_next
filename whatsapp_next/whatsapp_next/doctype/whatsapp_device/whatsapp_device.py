# Module role: controller of `WhatsApp Device` — phone-pair normalization, the single-default
# rule and the status-writer guard. Device lifecycle (create / pair / disconnect / status) is
# driven by services/devices.py through the provider; nothing here talks to the platform.

from __future__ import annotations

import frappe
from frappe.model.document import Document

from whatsapp_next.services.guards import assert_status_writer
from whatsapp_next.services.phone import set_phone_pair


class WhatsAppDevice(Document):
	"""A WhatsApp device paired through the active provider."""

	def validate(self) -> None:
		"""Normalize the phone pair and guard `status` against non-service writers."""
		set_phone_pair(self, "phone", "phone_e164", required=False)
		assert_status_writer(self, ("status",))

	def on_update(self) -> None:
		"""Keep exactly one default device: this one wins when flagged."""
		if self.is_default:
			self._clear_other_defaults()

	def _clear_other_defaults(self) -> None:
		others = frappe.get_all(
			"WhatsApp Device",
			filters={"is_default": 1, "name": ("!=", self.name)},
			pluck="name",
		)
		for name in others:
			frappe.db.set_value("WhatsApp Device", name, "is_default", 0, update_modified=False)
