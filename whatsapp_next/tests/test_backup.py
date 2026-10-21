# Tests for services/backup.py (owner, 2026-10-10): the backup file round-trips what a site set
# up, never carries keys or devices, and the account switch deletes only what belonged to the
# account the site leaves. The purge is never run for real here: the test site's own messages
# and devices are not test data.

from __future__ import annotations

import json
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.services import backup, onboarding

GROUP = "BackupTest Group"


class TestBackup(IntegrationTestCase):
	def tearDown(self):
		frappe.db.delete("WhatsApp Contact Group Member", {"parent": GROUP})
		frappe.db.delete("WhatsApp Contact Group", {"name": GROUP})

	def _group(self, notes="first"):
		frappe.get_doc(
			{"doctype": "WhatsApp Contact Group", "group_name": GROUP, "kind": "Other", "source": "Manual", "description": notes}
		).insert(ignore_permissions=True)

	def test_the_file_carries_the_setup_and_no_keys_or_devices(self):
		self._group()
		data = backup.export_backup()
		self.assertEqual((data["format"], data["version"]), (backup.FORMAT, backup.VERSION))
		self.assertEqual(set(data["records"]), set(backup.DOCTYPES))
		self.assertIn(GROUP, [r["name"] for r in data["records"]["WhatsApp Contact Group"]])
		text = json.dumps(data)
		for secret in ("customer_api_key", "customer_api_secret", "api_secret", "webhook_secret"):
			self.assertNotIn(f'"{secret}"', text)
		self.assertFalse(backup.DEVICE_FIELDS & set(data["settings"]))
		for rows in data["records"].values():
			for row in rows:
				self.assertFalse(backup.DEVICE_FIELDS & set(row))

	def test_an_import_adds_what_is_missing_and_replaces_what_is_there(self):
		self._group("first")
		data = backup.export_backup()
		frappe.db.delete("WhatsApp Contact Group", {"name": GROUP})
		out = backup.import_backup(json.dumps(data))
		self.assertEqual(out["failed"], [])
		self.assertTrue(frappe.db.exists("WhatsApp Contact Group", GROUP))
		self.assertGreaterEqual(out["created"], 1)

		frappe.db.set_value("WhatsApp Contact Group", GROUP, "description", "changed here")
		backup.import_backup(data)
		self.assertEqual(frappe.db.get_value("WhatsApp Contact Group", GROUP, "description"), "first")

	def _file_with(self, doctype: str, name: str, **changes) -> dict:
		"""A backup holding one record of `doctype`: an existing one, renamed, with `changes`."""
		data = backup.export_backup()
		rows = data["records"][doctype]
		if not rows:
			self.skipTest(f"no {doctype} on this site to copy")
		row = {**rows[0], "name": name, **changes}
		return {**data, "settings": {}, "records": {doctype: [row]}}

	def _drop(self, doctype: str, name: str) -> None:
		if frappe.db.exists(doctype, name):
			frappe.delete_doc(doctype, name, force=True, ignore_permissions=True)

	def test_preview_says_what_would_happen_and_writes_nothing(self):
		self._group()
		data = backup.export_backup()
		data["records"]["WhatsApp Contact Group"].append({"name": "BackupTest New", "group_name": "BackupTest New"})
		before = frappe.db.count("WhatsApp Contact Group")
		out = backup.preview_backup(json.dumps(data))
		self.assertIn({"doctype": "WhatsApp Contact Group", "name": "BackupTest New"}, out["add"])
		self.assertIn({"doctype": "WhatsApp Contact Group", "name": GROUP}, out["replace"])
		self.assertEqual(frappe.db.count("WhatsApp Contact Group"), before)

	def test_notifications_come_in_switched_off_with_only_their_own_fields(self):
		name = "BackupTest Notification"
		data = self._file_with("WhatsApp Notification", name, enabled=1, send_count=999, not_a_field="x")
		try:
			out = backup.import_backup(data)
			self.assertEqual(out["failed"], [])
			self.assertEqual(out["switched_off"], 1)
			self.assertEqual(frappe.db.get_value("WhatsApp Notification", name, ["enabled", "send_count"]), (0, 0))
		finally:
			self._drop("WhatsApp Notification", name)

	def test_a_campaign_comes_in_as_a_draft_and_an_existing_one_is_kept(self):
		name = "BackupTest Campaign"
		data = self._file_with("WhatsApp Campaign", name, status="Completed", sent_count=50)
		try:
			out = backup.import_backup(data)
			self.assertEqual((out["created"], out["failed"]), (1, []))
			doc = frappe.get_doc("WhatsApp Campaign", name)
			self.assertEqual((doc.status, doc.sent_count), ("Draft", 0))
			self.assertEqual({r.status for r in doc.recipients} - {"Pending"}, set())
			again = backup.import_backup(data)
			self.assertEqual((again["created"], again["updated"], again["kept"]), (0, 0, 1))
		finally:
			self._drop("WhatsApp Campaign", name)

	def test_a_file_that_is_not_a_backup_is_refused(self):
		with self.assertRaises(frappe.ValidationError):
			backup.import_backup("{not json")
		with self.assertRaises(frappe.ValidationError):
			backup.import_backup({"format": "something else"})

	# ---- switching account (owner, 2026-10-22: never delete silently) -------------------------------

	def _switch(self, previous_key, previous_account, new_account, current_key="KEY-NEW"):
		"""`note_account` against stand-ins: the site's defaults in a dict, its devices `DEV-OLD`,
		every write captured — the test site's own device is never switched off."""
		defaults, writes, deleted = {}, [], []
		with (
			patch.object(backup.frappe.db, "get_default", side_effect=lambda k: defaults.get(k)),
			patch.object(backup.frappe.db, "set_default", side_effect=lambda k, v: defaults.__setitem__(k, v)),
			patch.object(backup.frappe, "get_all", return_value=["DEV-OLD"]),
			patch.object(backup.frappe.db, "set_value", side_effect=lambda *a, **k: writes.append(a)),
			patch.object(backup.frappe.db, "set_single_value"),
			patch.object(backup.frappe.db, "delete", side_effect=lambda *a, **k: deleted.append(a)),
			patch.object(backup, "account_key", return_value=current_key),
			patch.object(backup.audit, "log"),
		):
			frappe.flags.wa_allow_account_switch = True
			try:
				switched = backup.note_account(previous_key, previous_account, new_account)
			finally:
				frappe.flags.wa_allow_account_switch = False
		return switched, defaults, writes, deleted

	def test_a_test_never_switches_the_site_by_accident(self):
		with patch.object(backup.frappe.db, "set_default") as set_default:
			self.assertFalse(backup.note_account("KEY-A", "LINK-1", "LINK-2"))
		set_default.assert_not_called()

	def test_the_same_account_with_a_rotated_key_is_not_a_switch(self):
		switched, defaults, writes, _ = self._switch("KEY-OLD", "LINK-1", "LINK-1")
		self.assertFalse(switched)
		self.assertEqual(defaults[backup.ACCOUNT_DEFAULT], "LINK-1")
		self.assertNotIn(backup.SWITCH_DEFAULT, defaults)
		self.assertEqual(writes, [])

	def test_a_first_sign_in_is_not_a_switch(self):
		switched, defaults, _, _ = self._switch(None, None, "LINK-1")
		self.assertFalse(switched)
		self.assertEqual(defaults[backup.ACCOUNT_DEFAULT], "LINK-1")

	def test_another_account_deletes_nothing_and_switches_the_old_devices_off(self):
		switched, defaults, writes, deleted = self._switch("KEY-OLD", "LINK-1", "LINK-2")
		self.assertTrue(switched)
		self.assertEqual(deleted, [])
		pending = json.loads(defaults[backup.SWITCH_DEFAULT])
		self.assertEqual((pending["from"], pending["to"], pending["devices"]), ("LINK-1", "LINK-2", ["DEV-OLD"]))
		self.assertIn(("WhatsApp Device", {"name": ("in", ["DEV-OLD"])}, {"disabled": 1, "is_default": 0}), writes)

	def test_a_site_linked_before_the_account_was_remembered_compares_its_key(self):
		self.assertFalse(self._switch("KEY-A", None, "LINK-1", current_key="KEY-A")[0])
		self.assertTrue(self._switch("KEY-A", None, "LINK-1", current_key="KEY-B")[0])

	def test_the_purge_deletes_only_what_the_previous_account_left(self):
		pending = {"from": "LINK-1", "to": "LINK-2", "at": "2026-10-22 10:00:00", "devices": ["DEV-OLD"]}
		deleted, served = [], set()

		real_get_all = frappe.get_all

		def names(doctype, *args, **kwargs):
			if doctype not in backup.ACCOUNT_DOCTYPES:
				return [] if doctype == "File" else real_get_all(doctype, *args, **kwargs)
			if doctype in served:
				return []
			served.add(doctype)
			return [f"{doctype}-1"]

		with (
			patch.object(backup.frappe, "get_all", side_effect=names),
			patch.object(backup.frappe.db, "delete", side_effect=lambda dt, *a, **k: deleted.append(dt)),
			patch.object(backup.frappe.db, "set_value"),
			patch.object(backup.frappe.db, "set_default"),
			patch.object(backup.frappe.db, "commit"),
			patch.object(backup.audit, "log"),
		):
			counts = backup.purge_previous_account(pending)
		self.assertEqual(set(counts), {dt for dt in backup.ACCOUNT_DOCTYPES if frappe.db.table_exists(dt)})
		self.assertFalse(set(backup.DOCTYPES) & set(deleted))  # what a backup carries stays
		scope = backup._scope(pending)
		self.assertEqual(scope["WhatsApp Log"], {"creation": ("<=", pending["at"])})
		self.assertEqual(scope["WhatsApp Device"]["name"], ("in", ["DEV-OLD"]))
