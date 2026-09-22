# Module role: tests for WhatsApp Notification Alert — permission matrix (02 §6), content / schedule / JSON
# rules, the PNG binary check (D-029 OQ-E), phone normalization and `compute_next_run` per periodicity.

from __future__ import annotations

from datetime import datetime
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAInvalidPhoneError, WAValidationError
from whatsapp_next.install import ensure_roles
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_settings, ensure_test_user

DT = "WhatsApp Notification Alert"
# Link targets are real site data (or sibling DocTypes); no fixture generation needed.
IGNORE_TEST_RECORD_DEPENDENCIES = [
	"Report",
	"WhatsApp Template",
	"Print Format",
	"Letter Head",
	"Language",
	"WhatsApp Device",
	"User",
	"Role",
]


class TestWhatsAppNotificationAlert(IntegrationTestCase):
	"""Scheduled digests compute their next run and validate their content."""

	def setUp(self) -> None:
		super().setUp()
		ensure_roles()
		frappe.set_user("Administrator")
		ensure_settings()

	def tearDown(self) -> None:
		frappe.set_user("Administrator")
		delete_all(DT, {"alert_name": ["like", "_wa_test%"]})
		super().tearDown()

	def _doc(self, name: str = "_wa_test alert", **values):
		payload = {
			"doctype": DT,
			"alert_name": name,
			"periodicity": "Daily",
			"notification_time": "09:30:00",
			"content_type": "Static Message",
			"message": "Daily digest",
			"recipients": [{"recipient_type": "Phone", "phone": "0501234567"}],
		}
		payload.update(values)
		return frappe.get_doc(payload)

	def _insert(self, name: str = "_wa_test alert", **values):
		return self._doc(name, **values).insert(ignore_permissions=True)

	def test_permission_matrix(self) -> None:
		expected = {
			"System Manager": {"read": True, "write": True, "create": True, "delete": True, "export": True},
			"WhatsApp Manager": {"read": True, "write": True, "create": True, "delete": True, "export": True},
			"WhatsApp Agent": {"read": True, "write": False, "create": False, "delete": False},
			"WhatsApp Viewer": {"read": True, "write": False, "create": False, "delete": False},
			"WhatsApp Contact User": {"read": False, "write": False, "create": False},
		}
		for role, ptypes in expected.items():
			user = ensure_test_user(role)
			for ptype, allowed in ptypes.items():
				with self.subTest(role=role, ptype=ptype):
					self.assertEqual(bool(frappe.has_permission(DT, ptype, user=user)), allowed)

	def test_phone_normalized_and_next_run_set(self) -> None:
		doc = self._insert()
		self.assertEqual(doc.recipients[0].phone_e164, "+966501234567")
		self.assertTrue(doc.next_run_at)
		self.assertGreater(doc.next_run_at, frappe.utils.now_datetime())
		with self.assertRaises(WAInvalidPhoneError):
			self._insert(name="_wa_test bad", recipients=[{"recipient_type": "Phone", "phone": "x"}])

	def test_report_required_for_report_content(self) -> None:
		with self.assertRaises(WAValidationError):
			self._insert(content_type="Report", report=None)

	def test_template_or_message_required(self) -> None:
		with self.assertRaises(WAValidationError):
			self._insert(message="")

	def test_day_of_month_range(self) -> None:
		for day in (0, 29, 31):
			with self.subTest(day=day), self.assertRaises(WAValidationError):
				self._insert(periodicity="Monthly", day_of_month=day)

	def test_json_filters_must_parse(self) -> None:
		with self.assertRaises(WAValidationError):
			self._insert(content_type="Report", report="ToDo", filters_json="{bad")
		with self.assertRaises(WAValidationError):
			self._insert(content_type="Report", report="ToDo", dynamic_filters_json="[")

	def test_png_requires_wkhtmltoimage(self) -> None:
		with patch(
			"whatsapp_next.whatsapp_next.doctype.whatsapp_notification_alert.whatsapp_notification_alert.shutil.which",
			return_value=None,
		):
			with self.assertRaises(WAValidationError):
				self._insert(content_type="Report", report="ToDo", attachment_format="PNG")
			doc = self._insert(content_type="Report", report="ToDo", attachment_format="PDF")
			self.assertEqual(doc.attachment_format, "PDF")

	def test_recipients_required(self) -> None:
		with self.assertRaises((WAValidationError, frappe.MandatoryError)):
			self._insert(recipients=[])

	def test_compute_next_run_daily(self) -> None:
		doc = self._doc(notification_time="09:30:00")
		self.assertEqual(doc.compute_next_run(datetime(2026, 9, 22, 8, 0)), datetime(2026, 9, 22, 9, 30))
		self.assertEqual(doc.compute_next_run(datetime(2026, 9, 22, 9, 30)), datetime(2026, 9, 23, 9, 30))

	def test_compute_next_run_weekly(self) -> None:
		# 2026-09-22 is a Tuesday.
		doc = self._doc(periodicity="Weekly", day_of_week="Friday", notification_time="07:00:00")
		self.assertEqual(doc.compute_next_run(datetime(2026, 9, 22, 8, 0)), datetime(2026, 9, 25, 7, 0))
		doc.day_of_week = "Tuesday"
		self.assertEqual(doc.compute_next_run(datetime(2026, 9, 22, 6, 0)), datetime(2026, 9, 22, 7, 0))
		self.assertEqual(doc.compute_next_run(datetime(2026, 9, 22, 7, 0)), datetime(2026, 9, 29, 7, 0))

	def test_compute_next_run_monthly_quarterly_yearly(self) -> None:
		doc = self._doc(periodicity="Monthly", day_of_month=5, notification_time="10:00:00")
		self.assertEqual(doc.compute_next_run(datetime(2026, 9, 22, 8, 0)), datetime(2026, 10, 5, 10, 0))
		self.assertEqual(doc.compute_next_run(datetime(2026, 12, 6, 8, 0)), datetime(2027, 1, 5, 10, 0))
		doc.periodicity = "Quarterly"
		self.assertEqual(doc.compute_next_run(datetime(2026, 9, 22, 8, 0)), datetime(2026, 10, 5, 10, 0))
		self.assertEqual(doc.compute_next_run(datetime(2026, 10, 1, 8, 0)), datetime(2026, 10, 5, 10, 0))
		self.assertEqual(doc.compute_next_run(datetime(2026, 11, 1, 8, 0)), datetime(2027, 1, 5, 10, 0))
		doc.periodicity = "Yearly"
		doc.month_of_year = "March"
		self.assertEqual(doc.compute_next_run(datetime(2026, 9, 22, 8, 0)), datetime(2027, 3, 5, 10, 0))
		self.assertEqual(doc.compute_next_run(datetime(2027, 3, 5, 9, 0)), datetime(2027, 3, 5, 10, 0))
