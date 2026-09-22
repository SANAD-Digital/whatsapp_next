# Module role: tests for WhatsApp Notification — permission matrix (02 §6), document-type guard, body source
# (OQ-9), method allow-list (D-012), condition syntax, recipient normalization, variable count, cache.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAInvalidPhoneError, WAValidationError
from whatsapp_next.install import ensure_roles
from whatsapp_next.services import notifications
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_settings, ensure_test_user

DT = "WhatsApp Notification"
# Link targets are real site data (or sibling DocTypes); no fixture generation needed.
IGNORE_TEST_RECORD_DEPENDENCIES = [
	"DocType",
	"WhatsApp Device",
	"WhatsApp Template",
	"Print Format",
	"Letter Head",
]


class TestWhatsAppNotification(IntegrationTestCase):
	"""Doc-event notifications validate their trigger, body and recipients."""

	def setUp(self) -> None:
		super().setUp()
		ensure_roles()
		frappe.set_user("Administrator")
		ensure_settings()

	def tearDown(self) -> None:
		frappe.set_user("Administrator")
		delete_all(DT, {"notification_name": ["like", "_wa_test%"]})
		notifications.clear_cache()
		super().tearDown()

	def _insert(self, name: str = "_wa_test notification", **values):
		payload = {
			"doctype": DT,
			"notification_name": name,
			"document_type": "ToDo",
			"event": "Save",
			"message": "Hello {{ doc.name }}",
			"recipients": [{"recipient_type": "Fixed Number", "phone": "0501234567"}],
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

	def test_fixed_number_normalized_and_variables_counted(self) -> None:
		doc = self._insert(message="Hi {{ doc.name }}, {{doc.name}} owes {{ doc.amount }} {{ doc.amount }}")
		self.assertEqual(doc.recipients[0].phone_e164, "+966501234567")
		self.assertEqual(doc.variables_count, 2)
		with self.assertRaises(WAInvalidPhoneError):
			self._insert(name="_wa_test bad", recipients=[{"recipient_type": "Fixed Number", "phone": "x"}])

	def test_document_type_guard(self) -> None:
		for doctype in ("Has Role", "System Settings", "WhatsApp Log"):
			with self.subTest(doctype=doctype), self.assertRaises(WAValidationError):
				self._insert(document_type=doctype)

	def test_template_or_message_required(self) -> None:
		with self.assertRaises(WAValidationError):
			self._insert(message="   ")

	def test_method_allow_list(self) -> None:
		for method in ("frappe.utils.now", "myapp.hooks.fn", "", "on update"):
			with self.subTest(method=method), self.assertRaises(WAValidationError):
				self._insert(event="Method", method=method)
		doc = self._insert(event="Method", method=" on_update_after_submit ")
		self.assertEqual(doc.method, "on_update_after_submit")

	def test_condition_must_compile(self) -> None:
		with self.assertRaises(WAValidationError):
			self._insert(condition="doc.amount >")
		doc = self._insert(condition="doc.amount > 100 and doc.status == 'Open'")
		self.assertTrue(doc.condition)

	def test_recipients_required(self) -> None:
		with self.assertRaises((WAValidationError, frappe.MandatoryError)):
			self._insert(recipients=[])

	def test_cache_cleared_on_update_and_trash(self) -> None:
		notifications.clear_cache("ToDo")
		self.assertEqual(notifications.active_for("ToDo"), [])
		doc = self._insert()
		self.assertIn(doc.name, notifications.active_for("ToDo"))
		doc.enabled = 0
		doc.save()
		self.assertNotIn(doc.name, notifications.active_for("ToDo"))
		doc.enabled = 1
		doc.save()
		self.assertIn(doc.name, notifications.active_for("ToDo"))
		doc.delete()
		self.assertNotIn(doc.name, notifications.active_for("ToDo"))
