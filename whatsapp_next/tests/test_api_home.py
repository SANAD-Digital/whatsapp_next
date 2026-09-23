# Tests for api/v1/home.py (build order B-18): role gate and the composed dashboard shape.

from __future__ import annotations

from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import home as api
from whatsapp_next.exceptions import WAPermissionError
from whatsapp_next.tests.conftest_frappe import as_user, delete_all, ensure_device, ensure_settings

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
