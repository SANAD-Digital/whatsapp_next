# Module role: tests for WhatsApp Webhook Event — permission matrix (SM/MGR read only, no export),
# `received_at` default, `event_id` uniqueness and the status guard.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAStateConflictError
from whatsapp_next.install import ensure_roles
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_test_user

IGNORE_TEST_RECORD_DEPENDENCIES = ["WhatsApp Device", "WhatsApp Inbound Message", "WhatsApp Log"]

DOCTYPE = "WhatsApp Webhook Event"
PREFIX = "UT-EVT-"


def _insert(**values) -> "frappe.model.document.Document":
	payload = {
		"doctype": DOCTYPE,
		"event_id": PREFIX + frappe.generate_hash(length=8),
		"event_name": "message.sent",
		"payload": {"ok": True},
	}
	payload.update(values)
	with status_writer():
		return frappe.get_doc(payload).insert(ignore_permissions=True, ignore_links=True)


class TestWhatsAppWebhookEvent(IntegrationTestCase):
	@classmethod
	def setUpClass(cls) -> None:
		super().setUpClass()
		ensure_roles()

	def tearDown(self) -> None:
		delete_all(DOCTYPE, {"event_id": ("like", f"{PREFIX}%")})
		super().tearDown()

	def test_permission_matrix(self) -> None:
		expected = {
			"System Manager": (True, False, False, False),
			"WhatsApp Manager": (True, False, False, False),
			"WhatsApp Agent": (False, False, False, False),
			"WhatsApp Viewer": (False, False, False, False),
			"WhatsApp Contact User": (False, False, False, False),
			"_none": (False, False, False, False),
		}
		for role, flags in expected.items():
			user = ensure_test_user(role)
			for ptype, allowed in zip(("read", "write", "create", "delete"), flags, strict=True):
				self.assertEqual(
					bool(frappe.has_permission(DOCTYPE, ptype, user=user)), allowed, f"{role} {ptype}"
				)
		for role in ("System Manager", "WhatsApp Manager"):
			self.assertFalse(frappe.has_permission(DOCTYPE, "export", user=ensure_test_user(role)), role)

	def test_received_at_default_and_status(self) -> None:
		doc = _insert()
		self.assertTrue(doc.received_at)
		self.assertEqual(doc.status, "Received")
		self.assertEqual(doc.duplicate_count, 0)

	def test_event_id_unique(self) -> None:
		doc = _insert()
		with self.assertRaises(frappe.UniqueValidationError):
			_insert(event_id=doc.event_id)

	def test_status_guard(self) -> None:
		doc = _insert()
		doc.status = "Processed"
		with self.assertRaises(WAStateConflictError):
			doc.save(ignore_permissions=True)
		doc = frappe.get_doc(DOCTYPE, doc.name)
		doc.status = "Processed"
		with status_writer():
			doc.save(ignore_permissions=True)
		self.assertEqual(frappe.db.get_value(DOCTYPE, doc.name, "status"), "Processed")
