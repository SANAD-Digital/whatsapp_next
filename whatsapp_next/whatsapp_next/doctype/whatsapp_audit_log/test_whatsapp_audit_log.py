# Module role: tests for WhatsApp Audit Log — permission matrix (02 §6), timestamp / user defaults and the
# secret-key guard on `details`.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.install import ensure_roles
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_test_user

DT = "WhatsApp Audit Log"
# Link targets are real site data (or sibling DocTypes); no fixture generation needed.
IGNORE_TEST_RECORD_DEPENDENCIES = ["User", "DocType"]


class TestWhatsAppAuditLog(IntegrationTestCase):
	"""Audit rows are readable by SM / MGR only and never carry secrets."""

	def setUp(self) -> None:
		super().setUp()
		ensure_roles()
		frappe.set_user("Administrator")

	def tearDown(self) -> None:
		delete_all(DT, {"summary": ["like", "_wa_test%"]})
		super().tearDown()

	def _insert(self, **values):
		doc = frappe.get_doc({"doctype": DT, "action": "Test Send", "summary": "_wa_test row", **values})
		return doc.insert(ignore_permissions=True)

	def test_permission_matrix(self) -> None:
		expected = {
			"System Manager": {
				"read": True,
				"export": True,
				"write": False,
				"create": False,
				"delete": False,
			},
			"WhatsApp Manager": {
				"read": True,
				"export": True,
				"write": False,
				"create": False,
				"delete": False,
			},
			"WhatsApp Agent": {"read": False, "write": False, "create": False},
			"WhatsApp Viewer": {"read": False, "write": False, "create": False},
			"WhatsApp Contact User": {"read": False, "write": False, "create": False},
		}
		for role, ptypes in expected.items():
			user = ensure_test_user(role)
			for ptype, allowed in ptypes.items():
				with self.subTest(role=role, ptype=ptype):
					self.assertEqual(bool(frappe.has_permission(DT, ptype, user=user)), allowed)

	def test_defaults_timestamp_and_user(self) -> None:
		doc = self._insert(details={"count": 3, "ids": ["a", "b"]})
		self.assertTrue(doc.timestamp)
		self.assertEqual(doc.user, "Administrator")

	def test_summary_required(self) -> None:
		with self.assertRaises(WAValidationError):
			self._insert(summary="   ")

	def test_secret_keys_rejected(self) -> None:
		for details in (
			{"api_key": "x"},
			{"nested": {"webhook_secret": 1}},
			{"rows": [{"Token": "t"}]},
			'{"password": "p"}',
			{"Customer_API_KEY": "k"},
		):
			with self.subTest(details=details), self.assertRaises(WAValidationError):
				self._insert(details=details)

	def test_plain_details_accepted(self) -> None:
		doc = self._insert(details={"old": {"rate": 10}, "new": {"rate": 20}, "count": 1})
		self.assertTrue(doc.name)
