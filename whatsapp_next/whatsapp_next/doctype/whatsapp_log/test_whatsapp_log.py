# Module role: tests for WhatsApp Log (outbound message of record) — permission matrix (no
# C/W/D for any role), recipient normalization, status guard and source consistency rules.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAInvalidPhoneError, WAStateConflictError, WAValidationError
from whatsapp_next.install import ensure_roles
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_device, ensure_settings, ensure_test_user

IGNORE_TEST_RECORD_DEPENDENCIES = [
	"Contact",
	"Print Format",
	"Letter Head",
	"Language",
	"DocType",
	"WhatsApp Campaign",
	"WhatsApp Notification",
	"WhatsApp Notification Alert",
	"WhatsApp Command",
	"WhatsApp Inbound Message",
	"WhatsApp Queue Item",
	"WhatsApp Template",
]

DOCTYPE = "WhatsApp Log"


def _insert(device: str, **values) -> "frappe.model.document.Document":
	payload = {
		"doctype": DOCTYPE,
		"device": device,
		"recipient_type": "Individual",
		"phone": "0501234567",
		"message_type": "Text",
		"body": "unit test",
		"source_type": "API",
	}
	payload.update(values)
	with status_writer():
		return frappe.get_doc(payload).insert(ignore_permissions=True, ignore_links=True)


class TestWhatsAppLog(IntegrationTestCase):
	@classmethod
	def setUpClass(cls) -> None:
		super().setUpClass()
		ensure_roles()
		ensure_settings()
		cls.device = ensure_device()

	def tearDown(self) -> None:
		delete_all(DOCTYPE, {"source_type": "API"})
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

	def test_phone_pair_normalized(self) -> None:
		doc = _insert(self.device)
		self.assertEqual(doc.phone_e164, "+966501234567")
		self.assertEqual(doc.status, "Unsent")
		with self.assertRaises(WAInvalidPhoneError):
			_insert(self.device, phone="not a phone")
		with self.assertRaises(WAValidationError):
			_insert(self.device, recipient_type="Group", phone=None, jid=None)
		group = _insert(self.device, recipient_type="Group", phone=None, jid="120363012345678@g.us")
		self.assertEqual(group.phone_e164, "120363012345678@g.us")

	def test_status_guard(self) -> None:
		doc = _insert(self.device)
		doc.status = "Queued"
		with self.assertRaises(WAStateConflictError):
			doc.save(ignore_permissions=True)
		doc = frappe.get_doc(DOCTYPE, doc.name)
		doc.status = "Queued"
		with status_writer():
			doc.save(ignore_permissions=True)
		self.assertEqual(frappe.db.get_value(DOCTYPE, doc.name, "status"), "Queued")

	def test_source_rules(self) -> None:
		with self.assertRaises(WAValidationError):
			_insert(self.device, campaign="WA-CAMP-2026-00001", source_type="API")
		with self.assertRaises(WAValidationError):
			_insert(self.device, reference_name="SINV-0001")
		doc = _insert(self.device, reference_doctype="WhatsApp Device", reference_name=self.device)
		self.assertEqual(doc.reference_name, self.device)
