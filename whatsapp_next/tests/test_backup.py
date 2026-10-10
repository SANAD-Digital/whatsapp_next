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

	def test_a_file_that_is_not_a_backup_is_refused(self):
		with self.assertRaises(frappe.ValidationError):
			backup.import_backup("{not json")
		with self.assertRaises(frappe.ValidationError):
			backup.import_backup({"format": "something else"})

	def test_the_purge_deletes_the_account_tables_and_empties_references(self):
		deleted, emptied = [], []
		with (
			patch.object(backup.frappe.db, "delete", side_effect=lambda dt, *a, **k: deleted.append(dt)),
			patch.object(backup.frappe.db, "set_value", side_effect=lambda dt, f, field, *a, **k: emptied.append((dt, field))),
			patch.object(backup.frappe.db, "set_single_value"),
			patch.object(backup.audit, "log"),
		):
			frappe.flags.wa_allow_purge = True
			try:
				counts = backup.purge_account_data()
			finally:
				frappe.flags.wa_allow_purge = False
		# without the flag a test never purges, whatever calls it
		self.assertEqual(backup.purge_account_data(), {})
		self.assertEqual(deleted, [dt for dt in backup.ACCOUNT_DOCTYPES if frappe.db.table_exists(dt)])
		self.assertEqual(set(counts), set(deleted))
		self.assertIn(("WhatsApp Notification", "device"), emptied)
		# what a backup carries is never deleted
		self.assertFalse(set(backup.DOCTYPES) & set(deleted))

	def test_only_another_account_triggers_the_purge(self):
		with patch.object(backup, "purge_account_data") as purge:
			with patch.object(backup, "account_key", return_value="KEY-A"):
				self.assertFalse(onboarding._left_account("KEY-A"))  # the same account again
			self.assertFalse(onboarding._left_account(None))  # a first sign-in
			purge.assert_not_called()
			with patch.object(backup, "account_key", return_value="KEY-B"):
				self.assertTrue(onboarding._left_account("KEY-A"))
			purge.assert_called_once()
