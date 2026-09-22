# Module role: tests for WhatsApp Queue Item — permission matrix (no C/W/D), defaults copied from
# the outbound row / Settings, the status guard and the 1:1 uniqueness on outbound_message.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAStateConflictError
from whatsapp_next.install import ensure_roles
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_device, ensure_settings, ensure_test_user

IGNORE_TEST_RECORD_DEPENDENCIES = ["User", "WhatsApp Campaign", "WhatsApp Log"]

DOCTYPE = "WhatsApp Queue Item"


def _outbound(device: str) -> str:
	with status_writer():
		doc = frappe.get_doc(
			{
				"doctype": "WhatsApp Log",
				"device": device,
				"recipient_type": "Individual",
				"phone": "+966501234567",
				"message_type": "Text",
				"body": "queue test",
				"source_type": "API",
			}
		).insert(ignore_permissions=True, ignore_links=True)
	return doc.name


def _insert(device: str, outbound: str, **values) -> "frappe.model.document.Document":
	payload = {"doctype": DOCTYPE, "outbound_message": outbound, "device": device}
	payload.update(values)
	with status_writer():
		return frappe.get_doc(payload).insert(ignore_permissions=True, ignore_links=True)


class TestWhatsAppQueueItem(IntegrationTestCase):
	@classmethod
	def setUpClass(cls) -> None:
		super().setUpClass()
		ensure_roles()
		ensure_settings(max_attempts=3)
		cls.device = ensure_device()

	def tearDown(self) -> None:
		delete_all(DOCTYPE)
		delete_all("WhatsApp Log", {"source_type": "API"})
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

	def test_defaults(self) -> None:
		outbound = _outbound(self.device)
		doc = _insert(self.device, outbound, phone_e164="+966501234567")
		self.assertEqual(doc.client_ref, outbound)
		self.assertEqual(doc.max_attempts, 3)
		self.assertEqual(doc.priority, 5)
		self.assertEqual(doc.status, "Queued")
		self.assertTrue(doc.scheduled_at)
		self.assertEqual(doc.phone_e164, "+966501234567")

	def test_status_guard(self) -> None:
		doc = _insert(self.device, _outbound(self.device))
		doc.status = "Paused"
		with self.assertRaises(WAStateConflictError):
			doc.save(ignore_permissions=True)
		doc = frappe.get_doc(DOCTYPE, doc.name)
		doc.status = "Paused"
		with status_writer():
			doc.save(ignore_permissions=True)
		self.assertEqual(frappe.db.get_value(DOCTYPE, doc.name, "status"), "Paused")

	def test_outbound_message_is_unique(self) -> None:
		outbound = _outbound(self.device)
		_insert(self.device, outbound)
		with self.assertRaises(frappe.UniqueValidationError):
			_insert(self.device, outbound)
