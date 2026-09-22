# Module role: controller of `WhatsApp Number`, the materialized distinct-numbers table (one row per
# E.164 number or group / LID JID). Validates the key, derives `number_type` and `link_status`.
# Upserts come from services/numbers_materializer.py; link / convert from api.v1.numbers.

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document

from whatsapp_next.exceptions import WAInvalidPhoneError
from whatsapp_next.services.phone import classify


class WhatsAppNumber(Document):
	"""A distinct WhatsApp number (or JID) seen in outbound / inbound traffic."""

	def before_insert(self) -> None:
		"""Normalize the key before `autoname` uses `phone_e164` as the document name."""
		self._normalize_key()

	def validate(self) -> None:
		"""Normalize the key and recompute `link_status` from `contact`."""
		self._normalize_key()
		self.link_status = "Linked" if self.contact else "Not Linked"

	def _normalize_key(self) -> None:
		raw = self.phone_e164 or self.jid or self.phone
		kind, key = classify(raw)
		if not kind:
			frappe.throw(_("Invalid WhatsApp number or JID"), WAInvalidPhoneError)
		self.phone_e164 = key
		self.number_type = kind
		if kind != "Individual" and not self.jid:
			self.jid = key
