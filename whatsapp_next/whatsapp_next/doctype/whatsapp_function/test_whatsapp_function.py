# Module role: tests for WhatsApp Function — permission matrix (02 §6: no Desk create/delete), the
# Server Script it is bound to must be a function script (`wa_fn_` method), `values` names only the
# header's parameters (never the sender's party), and the party-type helper commands use.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.tests import function_fixtures as ff
from whatsapp_next.tests.conftest_frappe import ensure_test_user
from whatsapp_next.whatsapp_next.doctype.whatsapp_function.whatsapp_function import (
	ALLOWED_PARTY_TYPES,
	check_party_types,
)

DT = "WhatsApp Function"
# Link targets are real site data (or sibling DocTypes); no fixture generation needed.
IGNORE_TEST_RECORD_DEPENDENCIES = ["DocType", "User", "Print Format", "Server Script"]


class TestWhatsAppFunction(IntegrationTestCase):
	"""An installed function is bound to a function script and holds the site's values."""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ff.drop_all()
		cls.key = ff.ensure_function("_test_echo")

	def setUp(self) -> None:
		super().setUp()
		frappe.set_user("Administrator")

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

	def test_server_script_must_be_a_function(self) -> None:
		ff.ensure_script(
			"wa_fn__test_plain",
			ff.FUNCTIONS["_test_echo"][1].replace("_test_echo", "_test_plain"),
			api_method="plain_api",
		)
		doc = frappe.get_doc(DT, self.key)
		doc.server_script = "wa_fn__test_plain"
		with self.assertRaises(WAValidationError):
			doc.save(ignore_permissions=True)
		doc.reload()
		doc.function_name = "Renamed"
		doc.save(ignore_permissions=True)  # its own function script: fine

	def test_values_are_header_parameters(self) -> None:
		doc = frappe.get_doc(DT, self.key)
		for bad in ('{"party": "X"}', '{"nope": 1}', "[1, 2]", "{not json"):
			with self.subTest(values=bad):
				doc.values = bad
				with self.assertRaises(WAValidationError):
					doc.save(ignore_permissions=True)
				doc.reload()
		doc.values = '{"text": "hi", "msg_result": {"en": "x"}}'
		doc.save(ignore_permissions=True)
		self.assertEqual(
			frappe.parse_json(frappe.db.get_value(DT, self.key, "values")),
			{"text": "hi", "msg_result": {"en": "x"}},
		)

	def test_party_types_helper(self) -> None:
		self.assertEqual(ALLOWED_PARTY_TYPES, ("Customer", "Supplier", "Employee", "Sales Person", "User"))
		check_party_types([frappe._dict(party_type="Customer"), frappe._dict(party_type="Employee")])
		with self.assertRaises(WAValidationError):
			check_party_types([frappe._dict(party_type="ToDo")])
