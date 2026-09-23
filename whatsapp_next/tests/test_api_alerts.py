# Tests for api/v1/alerts.py (build order B-25): role gate, job-free preview, run_now enqueue on
# `long`, report column choices (with filters passed through) and the dynamic filter reference.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import alerts as api
from whatsapp_next.exceptions import WAPermissionError
from whatsapp_next.services import alerts, alerts_dates
from whatsapp_next.tests.conftest_frappe import as_user, delete_all, ensure_device, ensure_settings

NAME = "ApiTest Alert"
PHONE = "+966500930301"
COLUMNS = [
	{"label": "Customer", "fieldname": "customer", "fieldtype": "Data"},
	{"label": "Amount", "fieldname": "amount", "fieldtype": "Currency"},
]
ROWS = [{"customer": "A", "amount": 1}, {"customer": "B", "amount": 2}]


class TestApiAlerts(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("ApiTest Alert Device", "WAD-APITEST-AL", phone="+966500930300")
		ensure_settings(send_only_to_known_numbers=0)

	def setUp(self):
		self._clean()
		frappe.get_doc(
			{
				"doctype": "WhatsApp Notification Alert",
				"alert_name": NAME,
				"enabled": 1,
				"periodicity": "Daily",
				"notification_time": "08:00:00",
				"content_type": "Report",
				"report": "ToDo",
				"attachment_format": "PDF",
				"device": self.device,
				"message": "apitest {{ row_count }} rows",
				"recipients": [{"recipient_type": "Phone", "phone": PHONE}],
			}
		).insert(ignore_permissions=True)

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Queue Item")
		delete_all("WhatsApp Log", {"phone_e164": PHONE})
		delete_all("WhatsApp Notification Alert", {"alert_name": NAME})

	def test_role_gate(self):
		with as_user("WhatsApp Agent"), self.assertRaises(WAPermissionError):
			api.run_now(name=NAME)
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.get_dynamic_filter_reference()
		with as_user("WhatsApp Manager"):
			self.assertTrue(api.get_dynamic_filter_reference())

	def test_preview_and_run_now(self):
		with as_user("WhatsApp Manager"), patch.object(alerts, "_run_report", return_value=(COLUMNS, ROWS)):
			out = api.preview(name=NAME)
		self.assertEqual(
			(out["row_count"], out["message"], out["recipients_count"]), (2, "apitest 2 rows", 1)
		)
		self.assertEqual(out["attachment_name"], "apitest_alert.pdf")
		self.assertIsNone(out["error"])
		self.assertEqual(frappe.db.count("WhatsApp Log", {"phone_e164": PHONE}), 0)  # preview sends nothing
		job = frappe._dict(id="job-1")
		with as_user("WhatsApp Manager"), patch.object(frappe, "enqueue", return_value=job) as enq:
			self.assertEqual(api.run_now(name=NAME), {"job_id": "job-1"})
		self.assertEqual(enq.call_args.args[0], "whatsapp_next.services.alerts.run_alert")
		self.assertEqual((enq.call_args.kwargs["queue"], enq.call_args.kwargs["name"]), ("long", NAME))

	def test_report_columns_and_reference(self):
		fake = {"columns": COLUMNS, "result": ROWS}
		with as_user("WhatsApp Manager"), patch("frappe.desk.query_report.run", return_value=fake) as run:
			cols = api.get_report_columns(report="ToDo", filters='{"status": "Open"}')
		self.assertEqual([c["fieldname"] for c in cols], ["customer", "amount"])
		self.assertEqual(set(cols[0]), {"fieldname", "label", "fieldtype"})
		self.assertEqual(run.call_args.kwargs["filters"], {"status": "Open"})
		with as_user("WhatsApp Manager"):
			self.assertEqual(api.get_report_columns(report="No Such Report"), [])
			ref = api.get_dynamic_filter_reference()
		self.assertEqual([r["name"] for r in ref], list(alerts_dates.TOKENS))
		by_name = {r["name"]: r["example"] for r in ref}
		self.assertEqual(by_name["today"], alerts_dates.resolve("today"))
		self.assertEqual(by_name["last_days:N"], alerts_dates.resolve("last_days:7"))
