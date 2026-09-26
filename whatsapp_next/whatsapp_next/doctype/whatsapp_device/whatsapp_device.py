# Module role: controller of `WhatsApp Device` — phone-pair normalization, the single-default
# rule and the status-writer guard. Device lifecycle (create / pair / disconnect / status) is
# driven by services/devices.py through the provider; nothing here talks to the platform.

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services.guards import assert_status_writer, is_status_writer
from whatsapp_next.services.phone import set_phone_pair


class WhatsAppDevice(Document):
	"""A WhatsApp device paired through the active provider."""

	def before_insert(self) -> None:
		"""A device exists on the provider before it exists here (02 §6): only the device service,
		inside `status_writer()`, inserts one. Desk "New", Data Import and the REST API are refused."""
		if not is_status_writer():
			frappe.throw(
				_("Devices are added from the Devices page, which registers them with the platform first."),
				WAValidationError,
			)

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
