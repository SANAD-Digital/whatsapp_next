# Tests for api/v1/home.py (build order B-18): role gate and the composed dashboard shape.

from __future__ import annotations

from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import home as api
from whatsapp_next.exceptions import WAPermissionError
from whatsapp_next.tests.conftest_frappe import (
	as_user,
	delete_all,
	delete_test_rows,
	ensure_device,
	ensure_settings,
)

DEVICE = "WAD-APITEST-HOME1"


class TestApiHome(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_settings()
		cls.device = ensure_device("ApiTest Home Device", DEVICE, status="Connected", phone="+966500910101")

	@classmethod
	def tearDownClass(cls):
		delete_all("WhatsApp Device", {"platform_device": DEVICE})
		super().tearDownClass()

	def test_role_gate(self):
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.get_dashboard()
		with as_user("WhatsApp Contact User"), self.assertRaises(WAPermissionError):
			api.get_dashboard()

	def test_dashboard_shape(self):
		with as_user("WhatsApp Viewer"):
			out = api.get_dashboard()
		self.assertEqual(
			set(out),
			{
				"devices",
				"campaigns_sending",
				"queue",
				"today",
				"plan",
				"webhook_status",
				"last_webhook_event_at",
				"setup",
			},
		)
		mine = next(d for d in out["devices"] if d["name"] == self.device)
		self.assertEqual(mine["status"], "Connected")
		self.assertNotIn("phone_e164", mine)
		for key in (
			"queued",
			"sending",
			"paused",
			"held",
			"dead_letter",
			"paused_globally",
			"paused_by",
			"reason",
		):
			self.assertIn(key, out["queue"])
		self.assertEqual(set(out["today"]), {"sent", "delivered", "failed", "inbound"})
		self.assertTrue(all(isinstance(v, int) for v in out["today"].values()))
		self.assertIn("plan_code", out["plan"])
		self.assertIsInstance(out["campaigns_sending"], list)
		self.assertIn("steps", out["setup"])


class TestApiHomeActivity(IntegrationTestCase):
	"""A-3: the period reads are grouped in the database and exact; measured as the difference
	its own rows make, so the site's data does not matter."""

	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_settings()
		cls.device = ensure_device("ApiTest Home Device", DEVICE, status="Connected", phone="+966500910101")

	@classmethod
	def tearDownClass(cls):
		delete_test_rows("WhatsApp Log", {"body": "home-activity-test"})
		delete_all("WhatsApp Device", {"platform_device": DEVICE})
		super().tearDownClass()

	def _log(self, status, error_code=None):
		import frappe

		from whatsapp_next.services.guards import status_writer

		with status_writer():
			doc = frappe.get_doc(
				{
					"doctype": "WhatsApp Log",
					"device": self.device,
					"recipient_type": "Individual",
					"phone": "+966500910199",
					"message_type": "Text",
					"body": "home-activity-test",
					"status": status,
					"error_code": error_code,
					"source_type": "API",
				}
			)
			doc.insert(ignore_permissions=True)
		return doc

	def test_role_gate_and_period_check(self):
		from whatsapp_next.exceptions import WAValidationError

		with as_user("WhatsApp Contact User"), self.assertRaises(WAPermissionError):
			api.get_activity(period="today")
		with as_user("WhatsApp Viewer"), self.assertRaises(WAValidationError):
			api.get_activity(period="year")

	def test_activity_counts_exactly(self):
		with as_user("WhatsApp Viewer"):
			before = api.get_activity(period="today")
		doc = self._log("Failed", "device_offline")
		self._log("Sent")
		self._log("Sent")
		with as_user("WhatsApp Viewer"):
			after = api.get_activity(period="7d")
			today = api.get_activity(period="today")
		self.assertEqual(set(today), {"period", "traffic", "series", "scheduled", "last_sent", "feed"})

		def delta(a, b, key):
			return a.get(key, 0) - b.get(key, 0)

		self.assertEqual(delta(today["traffic"]["now"], before["traffic"]["now"], "Sent"), 2)
		self.assertEqual(delta(today["traffic"]["now"], before["traffic"]["now"], "Failed"), 1)
		self.assertEqual(delta(today["traffic"]["errors"], before["traffic"]["errors"], "device_offline"), 1)
		hour = str(doc.creation)[11:13]
		count = lambda rows, status: sum(r["count"] for r in rows if r["key"] == hour and r["status"] == status)  # noqa: E731
		self.assertEqual(count(today["series"], "Sent") - count(before["series"], "Sent"), 2)
		self.assertTrue(any(r["key"] == str(doc.creation)[:10] for r in after["series"]))
		self.assertLessEqual(len(today["feed"]), 5)
		self.assertTrue(all(r["direction"] in ("out", "in") for r in today["feed"]))
