# Module role: tests for WhatsApp Function — permission matrix (02 §6: no Desk create/delete), derived flags,
# unique setting / output keys, setting value checks and party-type validation.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.install import ensure_roles
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_test_user
from whatsapp_next.whatsapp_next.doctype.whatsapp_function.whatsapp_function import handler_exists

DT = "WhatsApp Function"
# Link targets are real site data (or sibling DocTypes); no fixture generation needed.
IGNORE_TEST_RECORD_DEPENDENCIES = ["DocType", "User", "Print Format"]


class TestWhatsAppFunction(IntegrationTestCase):
	"""Installed functions: derived flags and child-table integrity."""

	def setUp(self) -> None:
		super().setUp()
		ensure_roles()
		frappe.set_user("Administrator")

	def tearDown(self) -> None:
		frappe.set_user("Administrator")
		delete_all(DT, {"function_key": ["like", "_wa_test%"]})
		super().tearDown()

	def _insert(self, key: str = "_wa_test_fn", **values):
		payload = {
			"doctype": DT,
			"function_key": key,
			"function_name": "Test Function",
			"installed_version": "1.0.0",
			"settings": [
				{"key": "limit", "label": "Limit", "fieldtype": "Int", "default_value": "5", "value": "5"},
				{
					"key": "mode",
					"label": "Mode",
					"fieldtype": "Select",
					"choices": "fast\nslow",
					"value": "fast",
				},
				{"key": "flag", "label": "Flag", "fieldtype": "Check", "value": "1"},
			],
			"outputs": [
				{"output_key": "reply", "label": "Reply", "default_template": "Hi {{ data.name }}"},
			],
		}
		payload.update(values)
		return frappe.get_doc(payload).insert(ignore_permissions=True)

	def test_permission_matrix(self) -> None:
		expected = {
			"System Manager": {"read": True, "write": True, "create": False, "delete": False},
			"WhatsApp Manager": {"read": True, "write": True, "create": False, "delete": False},
			"WhatsApp Agent": {"read": True, "write": False, "create": False, "delete": False},
			"WhatsApp Viewer": {"read": True, "write": False, "create": False, "delete": False},
			"WhatsApp Contact User": {"read": False, "write": False, "create": False},
		}
		for role, ptypes in expected.items():
			user = ensure_test_user(role)
			for ptype, allowed in ptypes.items():
				with self.subTest(role=role, ptype=ptype):
					self.assertEqual(bool(frappe.has_permission(DT, ptype, user=user)), allowed)

	def test_derived_flags(self) -> None:
		doc = self._insert()
		self.assertEqual(doc.name, "_wa_test_fn")
		self.assertEqual(doc.handler_registered, 1 if handler_exists("_wa_test_fn") else 0)
		self.assertEqual(doc.update_available, 0)
		doc.latest_version = "1.1.0"
		doc.save()
		self.assertEqual(doc.update_available, 1)
		doc.latest_version = "1.0.0"
		doc.save()
		self.assertEqual(doc.update_available, 0)

	def test_duplicate_setting_key_rejected(self) -> None:
		with self.assertRaises(WAValidationError):
			self._insert(
				settings=[
					{"key": "limit", "label": "A", "fieldtype": "Data"},
					{"key": "limit", "label": "B", "fieldtype": "Data"},
				]
			)

	def test_duplicate_output_key_rejected(self) -> None:
		with self.assertRaises(WAValidationError):
			self._insert(
				outputs=[
					{"output_key": "reply", "label": "A"},
					{"output_key": "reply", "label": "B"},
				]
			)

	def test_setting_values_validated(self) -> None:
		bad = (
			{"key": "limit", "label": "Limit", "fieldtype": "Int", "value": "abc"},
			{"key": "mode", "label": "Mode", "fieldtype": "Select", "choices": "fast\nslow", "value": "warp"},
			{"key": "flag", "label": "Flag", "fieldtype": "Check", "value": "yes"},
		)
		for row in bad:
			with self.subTest(row=row), self.assertRaises(WAValidationError):
				self._insert(settings=[row])
		doc = self._insert(settings=[{"key": "limit", "label": "Limit", "fieldtype": "Int", "value": " 7 "}])
		self.assertEqual(doc.settings[0].value, "7")

	def test_party_types_validated(self) -> None:
		doc = self._insert(party_types=[{"party_type": "Customer"}, {"party_type": "Employee"}])
		self.assertEqual([r.party_type for r in doc.party_types], ["Customer", "Employee"])
		with self.assertRaises(WAValidationError):
			self._insert(key="_wa_test_fn2", party_types=[{"party_type": "ToDo"}])
