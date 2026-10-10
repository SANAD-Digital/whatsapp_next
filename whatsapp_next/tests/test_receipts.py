# Read receipts and "typing…" (services/receipts): sent with the JIDs the message came with, never
# for simulated or imported messages, and per the Settings modes.

from __future__ import annotations

from unittest.mock import MagicMock, patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.services import receipts


class TestReceipts(IntegrationTestCase):
	def setUp(self):
		self.device = frappe.db.get_value("WhatsApp Device", {}, "name")
		if not self.device:
			self.skipTest("needs a device")
		self.provider = MagicMock()

	def _inbound(self, **values):
		doc = frappe.get_doc({"doctype": "WhatsApp Inbound Message", "device": self.device, "message_type": "Text",
			"body": "hi", "provider_message_id": f"R-{frappe.generate_hash(length=8)}", "command_status": "None",
			"chat_jid": "1203630001@g.us", "sender_jid": "39883435471066@lid", "is_group": 1, **values})
		doc.flags.ignore_mandatory = True
		doc.insert(ignore_permissions=True)
		return doc

	def _settings(self, **values):
		for k, v in values.items():
			frappe.db.set_single_value("WhatsApp Settings", k, v)
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")

	def test_receipt_uses_the_jids_as_received(self):
		doc = self._inbound()
		with patch("whatsapp_next.providers.registry.get_provider", return_value=self.provider):
			self.assertTrue(receipts.mark_read(doc.name))
		args = self.provider.mark_read.call_args.args
		self.assertEqual(args[1:], ("1203630001@g.us", [doc.provider_message_id], "39883435471066@lid"))

	def test_nothing_for_simulated_or_imported(self):
		for values in ({"is_simulated": 1}, {"is_history": 1}):
			doc = self._inbound(**values)
			with patch("whatsapp_next.providers.registry.get_provider", return_value=self.provider):
				self.assertFalse(receipts.mark_read(doc.name))
				self.assertFalse(receipts.typing(doc.name))
		self.provider.mark_read.assert_not_called()

	def test_modes(self):
		doc = self._inbound()
		self._settings(mark_read_mode="When a command replies", typing_indicator=0)
		with patch("whatsapp_next.providers.registry.get_provider", return_value=self.provider), patch("frappe.enqueue") as enqueue:
			receipts.on_received(doc.name)
			enqueue.assert_not_called()
			receipts.on_command_replied(doc.name)
			self.assertEqual(self.provider.mark_read.call_count, 1)
			self.assertFalse(receipts.typing(doc.name))
			self._settings(mark_read_mode="Every received message", typing_indicator=1)
			receipts.on_received(doc.name)
			enqueue.assert_called_once()
			self.assertTrue(receipts.typing(doc.name))
			self._settings(mark_read_mode="Never")
			receipts.on_command_replied(doc.name)
		self.assertEqual(self.provider.mark_read.call_count, 1)
		self.provider.send_presence.assert_called_once()
