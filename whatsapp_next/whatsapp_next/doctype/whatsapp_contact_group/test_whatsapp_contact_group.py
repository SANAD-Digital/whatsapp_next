# Module role: tests for WhatsApp Contact Group — permission matrix (02 §6, OQ-6 CU sees all groups), member
# phone normalization, duplicate guard, counters and the global-blacklist disable guard.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAInvalidPhoneError, WAStateConflictError, WAValidationError
from whatsapp_next.install import ensure_roles
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_settings, ensure_test_user

DT = "WhatsApp Contact Group"
# Link targets are real site data (or sibling DocTypes); no fixture generation needed.
IGNORE_TEST_RECORD_DEPENDENCIES = ["Contact", "DocType", "User"]


class TestWhatsAppContactGroup(IntegrationTestCase):
	"""Groups normalize members and keep counters; the global blacklist cannot be disabled."""

	def setUp(self) -> None:
		super().setUp()
		ensure_roles()
		frappe.set_user("Administrator")
		ensure_settings()

	def tearDown(self) -> None:
		frappe.set_user("Administrator")
		if (
			frappe.db.get_single_value("WhatsApp Settings", "global_blacklist_group", cache=False)
			in self._names()
		):
			frappe.db.set_single_value("WhatsApp Settings", "global_blacklist_group", None)
		delete_all(DT, {"group_name": ["like", "_wa_test%"]})
		super().tearDown()

	def _names(self) -> list[str]:
		return frappe.get_all(DT, filters={"group_name": ["like", "_wa_test%"]}, pluck="name")

	def _insert(self, name: str = "_wa_test group", members: list | None = None, **values):
		doc = frappe.get_doc({"doctype": DT, "group_name": name, "members": members or [], **values})
		return doc.insert(ignore_permissions=True)

	def test_permission_matrix(self) -> None:
		expected = {
			"System Manager": {"read": True, "write": True, "create": True, "delete": True, "export": True},
			"WhatsApp Manager": {"read": True, "write": True, "create": True, "delete": True, "export": True},
			"WhatsApp Agent": {"read": True, "write": True, "create": True, "delete": False},
			"WhatsApp Viewer": {"read": True, "write": False, "create": False, "delete": False},
			"WhatsApp Contact User": {"read": True, "write": True, "create": True, "delete": False},
		}
		for role, ptypes in expected.items():
			user = ensure_test_user(role)
			for ptype, allowed in ptypes.items():
				with self.subTest(role=role, ptype=ptype):
					self.assertEqual(bool(frappe.has_permission(DT, ptype, user=user)), allowed)

	def test_member_phone_normalized_and_counted(self) -> None:
		doc = self._insert(
			members=[{"phone": "0501234567"}, {"phone": "+966 50 765 4321", "display_name": "B"}]
		)
		self.assertEqual(doc.members[0].phone_e164, "+966501234567")
		self.assertEqual(doc.members[1].phone_e164, "+966507654321")
		self.assertEqual(doc.member_count, 2)
		self.assertTrue(doc.members_changed_at)
		self.assertEqual(doc.members[0].added_by, "Administrator")

	def test_invalid_member_phone_rejected(self) -> None:
		with self.assertRaises(WAInvalidPhoneError):
			self._insert(members=[{"phone": "abc"}])

	def test_duplicate_member_rejected(self) -> None:
		with self.assertRaises(WAValidationError):
			self._insert(members=[{"phone": "0501234567"}, {"phone": "+966501234567"}])

	def test_members_changed_at_only_on_change(self) -> None:
		doc = self._insert(members=[{"phone": "0501234567"}])
		first = doc.members_changed_at
		doc.description = "renamed"
		doc.save()
		self.assertEqual(doc.members_changed_at, first)
		doc.append("members", {"phone": "0509999999"})
		doc.save()
		self.assertEqual(doc.member_count, 2)
		self.assertGreaterEqual(doc.members_changed_at, first)

	def test_global_blacklist_cannot_be_disabled(self) -> None:
		doc = self._insert(name="_wa_test blacklist", kind="Blacklist")
		frappe.db.set_single_value("WhatsApp Settings", "global_blacklist_group", doc.name)
		doc.disabled = 1
		with self.assertRaises(WAStateConflictError):
			doc.save()
		frappe.db.set_single_value("WhatsApp Settings", "global_blacklist_group", None)
		doc.reload()
		doc.disabled = 1
		doc.save()
		self.assertEqual(doc.disabled, 1)
