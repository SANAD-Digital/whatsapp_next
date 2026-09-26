# Module role: tests for WhatsApp Device — permission matrix, phone-pair normalization, the
# status-writer guard and the single-default rule.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.install import ensure_roles
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_settings, ensure_test_user

IGNORE_TEST_RECORD_DEPENDENCIES = ["User"]

DOCTYPE = "WhatsApp Device"


def _insert(platform_device: str, **values) -> "frappe.model.document.Document":
	payload = {
		"doctype": DOCTYPE,
		"device_name": f"Device {platform_device}",
		"platform_device": platform_device,
		"status": "Pending QR",
	}
	payload.update(values)
	with status_writer():
		return frappe.get_doc(payload).insert(ignore_permissions=True)


class TestWhatsAppDevice(IntegrationTestCase):
	@classmethod
	def setUpClass(cls) -> None:
		super().setUpClass()
		ensure_roles()
		ensure_settings()

	def tearDown(self) -> None:
		delete_all(DOCTYPE, {"platform_device": ("like", "WAD-UT-%")})
		super().tearDown()

	def test_permission_matrix(self) -> None:
		expected = {
			"System Manager": (True, True, True, True),
			"WhatsApp Manager": (True, True, True, True),
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
		doc = _insert("WAD-UT-0001", phone="0501234567")
		self.assertEqual(doc.phone, "0501234567")
		self.assertEqual(doc.phone_e164, "+966501234567")
		doc = _insert("WAD-UT-0002")
		self.assertFalse(doc.phone_e164)

	def test_status_guard(self) -> None:
		doc = _insert("WAD-UT-0003")
		doc.status = "Connected"
		with self.assertRaises(WAStateConflictError):
			doc.save(ignore_permissions=True)
		doc = frappe.get_doc(DOCTYPE, doc.name)
		doc.status = "Connected"
		with status_writer():
			doc.save(ignore_permissions=True)
		self.assertEqual(frappe.db.get_value(DOCTYPE, doc.name, "status"), "Connected")
		doc = frappe.get_doc(DOCTYPE, doc.name)
		doc.notes = "free field"
		doc.save(ignore_permissions=True)

	def test_single_default_device(self) -> None:
		first = _insert("WAD-UT-0004", is_default=1)
		second = _insert("WAD-UT-0005", is_default=1)
		self.assertEqual(frappe.db.get_value(DOCTYPE, first.name, "is_default"), 0)
		self.assertEqual(frappe.db.get_value(DOCTYPE, second.name, "is_default"), 1)
		self.assertEqual(frappe.db.count(DOCTYPE, {"is_default": 1}), 1)

	def test_insert_only_through_the_device_service(self):
		"""Desk New, Data Import and REST inserts are refused: a device is registered on the
		provider first, by services/devices.py inside status_writer()."""
		with self.assertRaises(WAValidationError):
			frappe.get_doc(
				{"doctype": DOCTYPE, "device_name": "Device WAD-UT-NEW", "platform_device": "WAD-UT-NEW", "status": "Pending QR"}
			).insert(ignore_permissions=True)
		self.assertFalse(frappe.db.exists(DOCTYPE, {"platform_device": "WAD-UT-NEW"}))
		self.assertTrue(_insert("WAD-UT-SVC").name)

