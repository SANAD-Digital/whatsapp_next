# Module role: tests for WhatsApp Campaign — permission matrix (02 §6), recipient normalization, message
# requirement, rate limit, status guard (RC-04) and the edit lock outside Draft / Scheduled.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAInvalidPhoneError, WAStateConflictError, WAValidationError
from whatsapp_next.install import ensure_roles
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_device, ensure_settings, ensure_test_user

DT = "WhatsApp Campaign"
# Link targets are real site data (or sibling DocTypes); no fixture generation needed.
IGNORE_TEST_RECORD_DEPENDENCIES = [
	"WhatsApp Device",
	"WhatsApp Template",
	"Print Format",
	"Contact",
	"WhatsApp Contact Group",
	"DocType",
	"WhatsApp Log",
	"User",
]


class TestWhatsAppCampaign(IntegrationTestCase):
	"""Campaign validation and state guards (runner logic is out of scope here)."""

	def setUp(self) -> None:
		super().setUp()
		ensure_roles()
		frappe.set_user("Administrator")
		ensure_settings()
		self.device = None
		if frappe.db.exists("DocType", "WhatsApp Device"):
			self.device = ensure_device()

	def tearDown(self) -> None:
		frappe.set_user("Administrator")
		delete_all(DT, {"campaign_name": ["like", "_wa_test%"]})
		super().tearDown()

	def _require_device(self) -> None:
		if not self.device:
			self.skipTest("WhatsApp Device is not installed yet (built by the other agent)")

	def _insert(self, **values):
		self._require_device()
		payload = {
			"doctype": DT,
			"campaign_name": "_wa_test campaign",
			"device": self.device,
			"messages": [{"message_type": "Text", "body": "Hello {{ display_name }}"}],
			"recipients": [{"phone": "0501234567", "source_type": "Manual"}],
		}
		payload.update(values)
		return frappe.get_doc(payload).insert(ignore_permissions=True)

	def test_permission_matrix(self) -> None:
		expected = {
			"System Manager": {"read": True, "write": True, "create": True, "delete": True, "export": True},
			"WhatsApp Manager": {"read": True, "write": True, "create": True, "delete": True, "export": True},
			"WhatsApp Agent": {"read": True, "write": False, "create": False, "delete": False},
			"WhatsApp Viewer": {"read": True, "write": False, "create": False, "delete": False},
			"WhatsApp Contact User": {"read": False, "write": False, "create": False},
		}
		for role, ptypes in expected.items():
			user = ensure_test_user(role)
			for ptype, allowed in ptypes.items():
				with self.subTest(role=role, ptype=ptype):
					self.assertEqual(bool(frappe.has_permission(DT, ptype, user=user)), allowed)

	def test_recipient_phone_normalized_and_counted(self) -> None:
		doc = self._insert(
			recipients=[
				{"phone": "0501234567", "source_type": "Manual"},
				{"phone": "0507654321", "source_type": "Manual", "status": "Removed"},
			]
		)
		self.assertEqual(doc.recipients[0].phone_e164, "+966501234567")
		self.assertEqual(doc.total_recipients, 1)
		self.assertEqual(doc.status, "Draft")
		self.assertTrue(doc.name.startswith("WA-CAMP-"))

	def test_invalid_individual_phone_rejected(self) -> None:
		with self.assertRaises(WAInvalidPhoneError):
			self._insert(recipients=[{"phone": "nope", "source_type": "Manual"}])

	def test_group_recipient_needs_jid(self) -> None:
		with self.assertRaises(WAValidationError):
			self._insert(recipients=[{"recipient_type": "Group", "source_type": "Manual"}])
		doc = self._insert(
			recipients=[{"recipient_type": "Group", "jid": "1203630@g.us", "source_type": "Manual"}]
		)
		self.assertEqual(doc.total_recipients, 1)

	def test_messages_required(self) -> None:
		with self.assertRaises((WAValidationError, frappe.MandatoryError)):
			self._insert(messages=[])

	def test_rate_limit_bounded_by_settings(self) -> None:
		limit = frappe.get_cached_doc("WhatsApp Settings").messages_per_minute or 20
		with self.assertRaises(WAValidationError):
			self._insert(messages_per_minute=limit + 1)
		doc = self._insert(messages_per_minute=limit)
		self.assertEqual(doc.messages_per_minute, limit)

	def test_status_guard(self) -> None:
		doc = self._insert()
		doc.status = "Queued"
		with self.assertRaises(WAStateConflictError):
			doc.save()
		doc.reload()
		with status_writer():
			doc.status = "Queued"
			doc.save()
		self.assertEqual(doc.status, "Queued")

	def test_edit_lock_outside_draft_scheduled(self) -> None:
		doc = self._insert()
		doc.scheduled_at = "2030-01-01 10:00:00"
		doc.save()  # Draft → editable
		with status_writer():
			doc.status = "Running"
			doc.save()
		doc.reload()
		doc.scheduled_at = "2030-02-01 10:00:00"
		with self.assertRaises(WAStateConflictError):
			doc.save()
		doc.reload()
		doc.messages[0].body = "changed"
		with self.assertRaises(WAStateConflictError):
			doc.save()
		doc.reload()
		doc.description = "notes are fine"
		doc.append("recipients", {"phone": "0509999999", "source_type": "Manual"})
		doc.save()
		self.assertEqual(doc.total_recipients, 2)
