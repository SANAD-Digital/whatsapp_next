# Tests for the notification alert editor (D-139): open, save / rename / enable / delete through an
# allow-listed payload, the draft preview (nothing saved, nothing sent) with its next runs, and the
# test send to one number (one outbound, audited, counters untouched).

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import alerts as api
from whatsapp_next.exceptions import WAPermissionError, WAValidationError
from whatsapp_next.services import alerts
from whatsapp_next.tests.conftest_frappe import (
	as_user,
	delete_all,
	delete_test_rows,
	ensure_device,
	ensure_settings,
)

NAME = "EditorTest Alert"
RENAMED = "EditorTest Alert Renamed"
PHONE = "+966500931401"
TEST_PHONE = "+966500931402"
COLUMNS = [{"label": "Customer", "fieldname": "customer", "fieldtype": "Data"}]
ROWS = [{"customer": "A"}, {"customer": "B"}, {"customer": "C"}]


class TestAlertsEditor(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("EditorTest Alert Device", "WAD-TEST-ALEDITOR", phone="+966500931400")
		ensure_settings(send_only_to_known_numbers=0)

	def setUp(self):
		self._clean()

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_test_rows("WhatsApp Queue Item")
		for phone in (PHONE, TEST_PHONE):
			delete_all("WhatsApp Log", {"phone_e164": phone})
		for name in (NAME, RENAMED):
			delete_all("WhatsApp Notification Alert", {"alert_name": name})

	def payload(self, **over):
		base = {
			"alert_name": NAME,
			"enabled": 1,
			"periodicity": "Weekly",
			"day_of_week": "Sunday",
			"notification_time": "08:30",
			"content_type": "Static Message",
			"message": "editor-test for {{ alert.alert_name }}",
			"device": self.device,
			"recipients": [{"recipient_type": "Phone", "phone": PHONE}],
		}
		base.update(over)
		return base

	def test_open_new_and_role_gate(self):
		with as_user("WhatsApp Manager"):
			out = api.get_editor()
		self.assertIsNone(out["alert"]["name"])
		self.assertIn("Weekly", out["options"]["periodicity"])
		self.assertIn("Report Column", out["options"]["recipient_type"])
		self.assertTrue(out["tokens"])
		with as_user("WhatsApp Agent"), self.assertRaises(WAPermissionError):
			api.get_editor()

	def test_save_open_rename_enable_delete(self):
		with as_user("WhatsApp Manager"):
			saved = api.save_editor(payload=self.payload())
			self.assertEqual(saved["name"], NAME)
			self.assertEqual(frappe.utils.get_datetime(saved["next_run_at"]).strftime("%A %H:%M"), "Sunday 08:30")
			opened = api.get_editor(name=NAME)
			self.assertEqual(opened["alert"]["notification_time"], "08:30")
			self.assertEqual(opened["alert"]["recipients"][0]["phone_e164"], PHONE)
			with self.assertRaises(WAValidationError):
				api.save_editor(payload={**self.payload(), "name": NAME, "owner": "x"})
			renamed = api.save_editor(payload=self.payload(name=NAME, alert_name=RENAMED))
			self.assertEqual(renamed["name"], RENAMED)
			self.assertFalse(frappe.db.exists("WhatsApp Notification Alert", NAME))
			self.assertEqual(api.set_enabled(name=RENAMED, enabled=0)["enabled"], 0)
			api.delete_alert(name=RENAMED)
		self.assertFalse(frappe.db.exists("WhatsApp Notification Alert", RENAMED))

	def test_preview_draft_sends_nothing(self):
		with as_user("WhatsApp Manager"):
			out = api.preview_draft(payload=self.payload())
		self.assertIsNone(out["problem"])
		self.assertEqual(out["message"], f"editor-test for {NAME}")
		self.assertEqual(out["recipients_count"], 1)
		self.assertEqual(len(out["next_runs"]), 3)
		self.assertFalse(frappe.db.exists("WhatsApp Notification Alert", NAME))
		self.assertEqual(frappe.db.count("WhatsApp Log", {"phone_e164": PHONE}), 0)
		# an incomplete draft names what is missing instead of failing
		with as_user("WhatsApp Manager"):
			out = api.preview_draft(payload=self.payload(recipients=[]))
		self.assertTrue(out["problem"])
		# a report draft reports rows and the file it would attach, without building it
		with as_user("WhatsApp Manager"), patch.object(alerts, "_run_report", return_value=(COLUMNS, ROWS)):
			out = api.preview_draft(
				payload=self.payload(content_type="Report", report="ToDo", attachment_format="PDF")
			)
		self.assertEqual((out["row_count"], out["attachment"]["mime_type"]), (3, "application/pdf"))

	def test_send_test_to_one_number(self):
		with as_user("WhatsApp Manager"):
			api.save_editor(payload=self.payload())
		audits = frappe.db.count("WhatsApp Audit Log", {"action": "Alert Test Sent"})
		with as_user("WhatsApp Manager"), patch.object(frappe, "enqueue"):
			out = api.send_test(payload=self.payload(name=NAME), phone=TEST_PHONE)
		self.assertEqual(out["phone_e164"], TEST_PHONE)
		self.assertEqual(frappe.db.count("WhatsApp Log", {"phone_e164": TEST_PHONE}), 1)
		self.assertEqual(frappe.db.count("WhatsApp Log", {"phone_e164": PHONE}), 0)
		self.assertEqual(frappe.db.count("WhatsApp Audit Log", {"action": "Alert Test Sent"}), audits + 1)
		self.assertEqual(frappe.db.get_value("WhatsApp Notification Alert", NAME, "send_count"), 0)
		with as_user("WhatsApp Manager"), self.assertRaises(WAValidationError):
			api.send_test(payload=self.payload(name=NAME), phone="not a phone")
