# Module role: tests for WhatsApp Template — permission matrix, Jinja compile check and the
# Document / Print Format rule.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.install import ensure_roles
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_test_user

IGNORE_TEST_RECORD_DEPENDENCIES = ["Print Format", "Letter Head", "DocType", "Language"]

DOCTYPE = "WhatsApp Template"
PREFIX = "UT Template"


def _doc(**values) -> "frappe.model.document.Document":
	payload = {
		"doctype": DOCTYPE,
		"template_name": f"{PREFIX} {frappe.generate_hash(length=6)}",
		"body": "Hi",
	}
	payload.update(values)
	return frappe.get_doc(payload)


class TestWhatsAppTemplate(IntegrationTestCase):
	@classmethod
	def setUpClass(cls) -> None:
		super().setUpClass()
		ensure_roles()

	def tearDown(self) -> None:
		delete_all(DOCTYPE, {"template_name": ("like", f"{PREFIX}%")})
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

	def test_body_must_compile(self) -> None:
		doc = _doc(body="Hello {{ doc.name }}, total {{ doc.grand_total }}").insert(ignore_permissions=True)
		self.assertEqual(doc.name, doc.template_name)
		with self.assertRaises(WAValidationError):
			_doc(body="Hello {{ doc.name }").insert(ignore_permissions=True)
		with self.assertRaises(WAValidationError):
			_doc(body="{% if x %}unclosed").insert(ignore_permissions=True)

	def test_document_requires_print_format(self) -> None:
		with self.assertRaises(WAValidationError):
			_doc(message_type="Document").insert(ignore_permissions=True)
		print_format = frappe.get_all("Print Format", limit=1, pluck="name")[0]
		doc = _doc(message_type="Document", print_format=print_format).insert(ignore_permissions=True)
		self.assertEqual(doc.message_type, "Document")
