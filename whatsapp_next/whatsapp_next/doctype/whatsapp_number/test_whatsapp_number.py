# Module role: tests for WhatsApp Number — permission matrix (read-only for everyone, CU reads),
# key normalization (E.164 name, JID for groups / LIDs), number_type and link_status derivation.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAInvalidPhoneError
from whatsapp_next.install import ensure_roles
from whatsapp_next.tests.conftest_frappe import (
	delete_all,
	ensure_contact,
	ensure_settings,
	ensure_test_user,
)

IGNORE_TEST_RECORD_DEPENDENCIES = ["Contact", "User", "WhatsApp Device"]

DOCTYPE = "WhatsApp Number"
KEYS = ("+966501234567", "120363012345678@g.us", "987654321@lid", "+966500000002")


def _insert(**values) -> "frappe.model.document.Document":
	payload = {"doctype": DOCTYPE}
	payload.update(values)
	return frappe.get_doc(payload).insert(ignore_permissions=True)


class TestWhatsAppNumber(IntegrationTestCase):
	@classmethod
	def setUpClass(cls) -> None:
		super().setUpClass()
		ensure_roles()
		ensure_settings()

	def tearDown(self) -> None:
		delete_all(DOCTYPE, {"name": ("in", KEYS)})
		super().tearDown()

	def test_permission_matrix(self) -> None:
		expected = {
			"System Manager": (True, False, False, False),
			"WhatsApp Manager": (True, False, False, False),
			"WhatsApp Agent": (True, False, False, False),
			"WhatsApp Viewer": (True, False, False, False),
			"WhatsApp Contact User": (True, False, False, False),
			"_none": (False, False, False, False),
		}
		for role, flags in expected.items():
			user = ensure_test_user(role)
			for ptype, allowed in zip(("read", "write", "create", "delete"), flags, strict=True):
				self.assertEqual(
					bool(frappe.has_permission(DOCTYPE, ptype, user=user)), allowed, f"{role} {ptype}"
				)
		self.assertFalse(
			frappe.has_permission(DOCTYPE, "export", user=ensure_test_user("WhatsApp Contact User"))
		)
		self.assertTrue(frappe.has_permission(DOCTYPE, "export", user=ensure_test_user("WhatsApp Viewer")))

	def test_key_normalization(self) -> None:
		doc = _insert(phone="0501234567")
		self.assertEqual(doc.name, "+966501234567")
		self.assertEqual(doc.phone_e164, "+966501234567")
		self.assertEqual(doc.number_type, "Individual")
		self.assertEqual(doc.link_status, "Not Linked")
		group = _insert(phone_e164="120363012345678@g.us")
		self.assertEqual(group.name, "120363012345678@g.us")
		self.assertEqual(group.number_type, "Group")
		self.assertEqual(group.jid, "120363012345678@g.us")
		lid = _insert(jid="987654321@lid")
		self.assertEqual(lid.number_type, "LID")
		self.assertEqual(lid.name, "987654321@lid")
		with self.assertRaises(WAInvalidPhoneError):
			_insert(phone="abc")

	def test_link_status_follows_contact(self) -> None:
		contact = ensure_contact()
		doc = _insert(phone_e164="+966500000002", contact=contact, link_status="Not Linked")
		self.assertEqual(doc.link_status, "Linked")
		doc.contact = None
		doc.save(ignore_permissions=True)
		self.assertEqual(frappe.db.get_value(DOCTYPE, doc.name, "link_status"), "Not Linked")

	def test_rename_not_allowed(self) -> None:
		self.assertEqual(frappe.get_meta(DOCTYPE).allow_rename, 0)
