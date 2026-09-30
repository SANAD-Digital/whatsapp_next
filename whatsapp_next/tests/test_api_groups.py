# Tests for api/v1/groups.py: the contact group editor window opens a group or a new one's
# defaults, creates a group with its first members in one save, edits fields and members together,
# renames, refuses a stale edit, and keeps a Viewer out.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import groups as api
from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.tests.conftest_frappe import as_user, delete_all

GROUP = "ApiTest Editor Group"
RENAMED = "ApiTest Editor Group Renamed"
P1, P2, P3 = "+966500930501", "+966500930502", "+966500930503"


def _row(phone, name, source_type="Manual"):
	return {"phone": phone, "phone_e164": phone, "display_name": name, "source_type": source_type}


class TestApiGroups(IntegrationTestCase):
	def setUp(self):
		self._clean()

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		for name in (GROUP, RENAMED):
			delete_all("WhatsApp Audit Log", {"reference_name": name})
			delete_all("WhatsApp Contact Group", {"group_name": name})

	def _members(self, name):
		return sorted(frappe.get_all("WhatsApp Contact Group Member", filters={"parent": name}, pluck="phone_e164"))

	def test_new_group_defaults(self):
		r = api.get_editor()
		self.assertIsNone(r["group"]["name"])
		self.assertIn("Blacklist", r["kinds"])
		self.assertTrue(r["can_write"])

	def test_create_with_members(self):
		r = api.save_editor(payload={"group_name": GROUP, "kind": "Marketing", "description": "d", "add": [_row(P1, "One"), _row(P2, "Two")]})
		self.assertEqual(r["name"], GROUP)
		self.assertEqual(r["added"], 2)
		self.assertEqual(self._members(GROUP), [P1, P2])
		doc = frappe.get_doc("WhatsApp Contact Group", GROUP)
		self.assertEqual(doc.member_count, 2)
		self.assertEqual(doc.source, "Picker")

	def test_duplicate_name_refused(self):
		api.save_editor(payload={"group_name": GROUP, "kind": "Other"})
		with self.assertRaises(WAValidationError):
			api.save_editor(payload={"group_name": GROUP, "kind": "Other"})

	def test_edit_fields_and_members_then_rename(self):
		api.save_editor(payload={"group_name": GROUP, "kind": "Marketing", "add": [_row(P1, "One"), _row(P2, "Two")]})
		opened = api.get_editor(name=GROUP)["group"]
		r = api.save_editor(
			payload={
				"name": GROUP,
				"modified": opened["modified"],
				"group_name": RENAMED,
				"kind": "Professional",
				"add": [_row(P3, "Three"), _row(P1, "One again")],
				"remove": [P2],
			}
		)
		self.assertEqual(r["name"], RENAMED)
		self.assertEqual((r["added"], r["removed"], r["skipped"]), (1, 1, 1))
		self.assertEqual(self._members(RENAMED), [P1, P3])
		self.assertEqual(frappe.db.get_value("WhatsApp Contact Group", RENAMED, "kind"), "Professional")

	def test_stale_edit_refused(self):
		api.save_editor(payload={"group_name": GROUP, "kind": "Other"})
		with self.assertRaises(WAValidationError):
			api.save_editor(payload={"name": GROUP, "modified": "2000-01-01 00:00:00", "group_name": GROUP, "kind": "Other"})

	def test_viewer_cannot_save(self):
		with as_user("WhatsApp Viewer"):
			with self.assertRaises(frappe.PermissionError):
				api.save_editor(payload={"group_name": GROUP, "kind": "Other"})
