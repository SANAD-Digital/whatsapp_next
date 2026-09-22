# Module role: tests for WhatsApp Inbound Message — permission matrix (no C/W/D), sender
# normalization (LID senders keep an empty E.164), derived `is_group` and the command_status guard.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAStateConflictError
from whatsapp_next.install import ensure_roles
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_device, ensure_settings, ensure_test_user

IGNORE_TEST_RECORD_DEPENDENCIES = [
	"Contact",
	"WhatsApp Command",
	"WhatsApp Log",
	"WhatsApp Webhook Event",
]

DOCTYPE = "WhatsApp Inbound Message"
PREFIX = "UT-IN-"


def _insert(device: str, **values) -> "frappe.model.document.Document":
	payload = {
		"doctype": DOCTYPE,
		"device": device,
		"phone": "0501234567",
		"message_type": "Text",
		"body": "hello",
		"provider_message_id": PREFIX + frappe.generate_hash(length=8),
	}
	payload.update(values)
	with status_writer():
		return frappe.get_doc(payload).insert(ignore_permissions=True, ignore_links=True)


class TestWhatsAppInboundMessage(IntegrationTestCase):
	@classmethod
	def setUpClass(cls) -> None:
		super().setUpClass()
		ensure_roles()
		ensure_settings()
		cls.device = ensure_device()

	def tearDown(self) -> None:
		delete_all(DOCTYPE, {"provider_message_id": ("like", f"{PREFIX}%")})
		super().tearDown()

	def test_permission_matrix(self) -> None:
		expected = {
			"System Manager": (True, False, False, False),
			"WhatsApp Manager": (True, False, False, False),
			"WhatsApp Agent": (True, False, False, False),
			"WhatsApp Viewer": (True, False, False, False),
			"WhatsApp Contact User": (False, False, False, False),
			"_none": (False, False, False, False),
		}
		for role, flags in expected.items():
			user = ensure_test_user(role)
			for ptype, allowed in zip(("read", "write", "create", "delete"), flags, strict=True):
				self.assertEqual(
					bool(frappe.has_permission(DOCTYPE, ptype, user=user)), allowed, f"{role} {ptype}"
				)

	def test_phone_pair_and_defaults(self) -> None:
		doc = _insert(self.device)
		self.assertEqual(doc.phone_e164, "+966501234567")
		self.assertTrue(doc.received_at)
		self.assertEqual(doc.command_status, "None")
		lid = _insert(self.device, phone=None, sender_jid="123456789@lid")
		self.assertFalse(lid.phone_e164)

	def test_is_group_derived_from_chat_jid(self) -> None:
		group = _insert(self.device, chat_jid="120363012345678@g.us")
		self.assertEqual(group.is_group, 1)
		single = _insert(self.device, chat_jid="966501234567@s.whatsapp.net", is_group=1)
		self.assertEqual(single.is_group, 0)

	def test_command_status_guard(self) -> None:
		doc = _insert(self.device)
		doc.command_status = "Matched"
		with self.assertRaises(WAStateConflictError):
			doc.save(ignore_permissions=True)
		doc = frappe.get_doc(DOCTYPE, doc.name)
		doc.command_status = "Matched"
		with status_writer():
			doc.save(ignore_permissions=True)
		self.assertEqual(frappe.db.get_value(DOCTYPE, doc.name, "command_status"), "Matched")

	def test_provider_message_id_required(self) -> None:
		with self.assertRaises(frappe.MandatoryError):
			_insert(self.device, provider_message_id=None)
