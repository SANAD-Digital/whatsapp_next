# Tests for services/alerts.py, alerts_dates.py and report_render.py (build order B-16): date
# tokens, filter resolution, recipient expansion (User / Role / Phone / Report Column), report
# HTML/PDF rendering, preview vs real run with outbound rows and next_run_at.

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.services import alerts, alerts_dates, report_render
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_device, ensure_settings

PHONE = "+966500000911"
NAME = "AlertTest Digest"
REPORT_COLUMNS = [
	{"label": "Customer", "fieldname": "customer", "fieldtype": "Data"},
	{"label": "Mobile", "fieldname": "mobile", "fieldtype": "Data"},
	{"label": "Amount", "fieldname": "amount", "fieldtype": "Currency"},
]
REPORT_ROWS = [
	{"customer": "A", "mobile": "0500000912", "amount": 10.5},
	{"customer": "B", "mobile": "0500000913", "amount": 20},
	{"customer": "A", "mobile": "0500000912", "amount": 5},
]


def _alert(**values):
	doc = frappe.get_doc(
		{
			"doctype": "WhatsApp Notification Alert",
			"alert_name": NAME,
			"enabled": 1,
			"periodicity": "Daily",
			"notification_time": "08:00:00",
			"content_type": "Report",
			"report": "ToDo",
			"attachment_format": "PDF",
			"message": "alert-test {{ row_count }} rows for {{ recipient.phone_e164 }}",
			"recipients": [{"recipient_type": "Phone", "phone": PHONE}],
			**values,
		}
	)
	doc.insert(ignore_permissions=True)
	return doc


class TestAlerts(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("Alert Device", "WAD-TEST-AL01", phone="+966500000071")
		ensure_settings(default_device=cls.device, send_only_to_known_numbers=0)

	def setUp(self):
		self._clean()

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Queue Item")
		delete_all("WhatsApp Log", {"source_type": "Notification Alert"})
		delete_all("WhatsApp Notification Alert", {"alert_name": ("like", "AlertTest%")})
		for name in frappe.get_all(
			"File", filters={"attached_to_doctype": "WhatsApp Notification Alert"}, pluck="name"
		):
			frappe.delete_doc("File", name, ignore_permissions=True, force=True)

	def test_dates(self):
		t = date(2026, 5, 20)  # Wednesday
		self.assertEqual(alerts_dates.week_range(t), (date(2026, 5, 18), date(2026, 5, 24)))
		self.assertEqual(alerts_dates.month_range(t), (date(2026, 5, 1), date(2026, 5, 31)))
		self.assertEqual(alerts_dates.quarter_range(t), (date(2026, 4, 1), date(2026, 6, 30)))
		self.assertEqual(alerts_dates.year_range(t), (date(2026, 1, 1), date(2026, 12, 31)))
		self.assertEqual(alerts_dates.last_days_range(7, t), (date(2026, 5, 14), date(2026, 5, 20)))
		self.assertEqual(alerts_dates.resolve("month_start", t), "2026-05-01")
		self.assertEqual(alerts_dates.resolve("last_days:3", t), "2026-05-18")
		self.assertEqual(alerts_dates.resolve("days_ago:1", t), "2026-05-19")
		self.assertEqual(alerts_dates.resolve("Open", t), "Open")  # literal
		self.assertIsNone(alerts_dates.resolve(None))
		fy = alerts_dates.fiscal_year_range(t)
		self.assertTrue(fy[0] <= t <= fy[1])

	def test_filters_and_recipients(self):
		alert = _alert(
			filters_json='{"status": "Open"}',
			dynamic_filters_json='{"from_date": "month_start", "to_date": "today"}',
		)
		f = alerts.resolve_filters(alert)
		self.assertEqual(f["status"], "Open")
		self.assertEqual(f["from_date"], alerts_dates.resolve("month_start"))
		alert.set(
			"recipients",
			[
				{"recipient_type": "Phone", "phone": PHONE},
				{"recipient_type": "Report Column", "report_column": "mobile"},
				{"recipient_type": "User", "user": "Administrator"},
			],
		)
		alert.save(ignore_permissions=True)
		recips = alerts.expand_recipients(alert, REPORT_ROWS, REPORT_COLUMNS)
		by_source = {}
		for r in recips:
			by_source.setdefault(r.source, []).append(r.phone_e164)
		self.assertEqual(by_source["Phone"], [PHONE])
		self.assertEqual(by_source["Report Column"], ["+966500000912", "+966500000913"])  # distinct
		self.assertNotIn("User", by_source)  # Administrator has no mobile
		col = next(r for r in recips if r.source == "Report Column" and r.phone_e164 == "+966500000912")
		self.assertEqual(len(alerts._rows_for(col, REPORT_ROWS, REPORT_COLUMNS, "mobile")), 2)

	def test_render(self):
		alert = _alert()
		html_text = report_render.report_html(
			REPORT_COLUMNS, REPORT_ROWS, alert, filters={"status": "Open"}, title="AlertTest"
		)
		self.assertIn("<table>", html_text)
		self.assertIn("AlertTest", html_text)
		self.assertIn("status: Open", html_text)
		tbody = html_text.rsplit("<tbody>", 1)[1].split("</tbody>")[0]  # the report table is last
		self.assertEqual(tbody.count("<td"), 9)  # 3 rows × 3 columns
		self.assertNotIn('src="/files/', html_text)  # letter head images are inlined
		self.assertEqual(
			report_render.normalize_columns(["Name:Data:120", "Total:Currency/currency:100"])[1]["align"],
			"right",
		)
		pdf = report_render.report_pdf(html_text, alert)
		self.assertTrue(pdf.startswith(b"%PDF"))
		empty = report_render.report_html(REPORT_COLUMNS, [], alert)
		self.assertIn("No data", empty)

	def test_run_preview_and_real(self):
		alert = _alert(
			recipients=[
				{"recipient_type": "Phone", "phone": PHONE},
				{"recipient_type": "Report Column", "report_column": "mobile"},
			]
		)
		with patch.object(alerts, "_run_report", return_value=(REPORT_COLUMNS, REPORT_ROWS)):
			preview = alerts.run_alert(alert.name, preview=True)
			self.assertIsNone(preview.error)
			self.assertEqual(
				(preview.rows, preview.columns, len(preview.recipients), preview.outbound), (3, 3, 3, [])
			)
			self.assertEqual(preview.recipients[0]["body"], f"alert-test 3 rows for {PHONE}")
			col = next(
				r
				for r in preview.recipients
				if r["source"] == "Report Column" and r["phone_e164"] == "+966500000912"
			)
			self.assertEqual(
				(col["rows"], col["message_type"], col["mime_type"]), (2, "Document", "application/pdf")
			)
			self.assertEqual(frappe.db.count("WhatsApp Log", {"notification_alert": alert.name}), 0)
			with patch.object(frappe, "enqueue"):
				run = alerts.run_alert(alert.name)
		self.assertIsNone(run.error)
		self.assertEqual(len(run.outbound), 3)
		rows = frappe.get_all(
			"WhatsApp Log",
			filters={"notification_alert": alert.name},
			fields=["message_type", "attachment", "caption", "status", "source_type"],
		)
		self.assertTrue(
			all(
				r.message_type == "Document"
				and r.attachment
				and r.status == "Queued"
				and r.source_type == "Notification Alert"
				for r in rows
			)
		)
		row = frappe.db.get_value(
			"WhatsApp Notification Alert",
			alert.name,
			["send_count", "last_sent_at", "next_run_at", "last_error"],
			as_dict=True,
		)
		self.assertEqual(row.send_count, 3)
		self.assertIsNotNone(row.last_sent_at)
		self.assertGreater(row.next_run_at, frappe.utils.now_datetime())
		self.assertIsNone(row.last_error)
		# failure path: error recorded, next run still advanced
		with patch.object(alerts, "_run_report", side_effect=RuntimeError("report exploded")):
			run = alerts.run_alert(alert.name)
		self.assertIn("report exploded", run.error)
		self.assertIn(
			"RuntimeError", frappe.db.get_value("WhatsApp Notification Alert", alert.name, "last_error")
		)
		# due selection
		frappe.db.set_value(
			"WhatsApp Notification Alert",
			alert.name,
			"next_run_at",
			frappe.utils.add_to_date(frappe.utils.now_datetime(), minutes=-1),
			update_modified=False,
		)
		with patch.object(frappe, "enqueue") as enq:
			self.assertEqual(alerts.run_due_alerts(), [alert.name])
		self.assertEqual(enq.call_args.kwargs["name"], alert.name)
