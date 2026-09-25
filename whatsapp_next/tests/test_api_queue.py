# Tests for api/v1/queue.py (build order B-21): role gates, list with position / ETA and filters,
# summary with the cached platform view, global pause / resume / rate and the row operations
# (pause, resume, delete-as-state, retry dead letter) through services/dispatch.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import queue as api
from whatsapp_next.exceptions import WAPermissionError, WAStateConflictError, WAValidationError
from whatsapp_next.services import dispatch
from whatsapp_next.services.dispatch import OutboundSpec
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import (
	as_user,
	delete_all,
	ensure_device,
	ensure_settings,
	fake_provider,
)

DEVICE = "WAD-APITEST-Q1"
P1, P2, P3 = "+966500910301", "+966500910302", "+966500910303"
BODY = "ApiTest queue"


class TestApiQueue(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("ApiTest Queue Device", DEVICE, phone="+966500910300")
		cls._rate = frappe.db.get_single_value("WhatsApp Settings", "messages_per_minute")
		ensure_settings(queue_paused=0, send_only_to_known_numbers=0, messages_per_minute=20)

	@classmethod
	def tearDownClass(cls):
		cls._clean()
		ensure_settings(queue_paused=0, messages_per_minute=cls._rate or 20)
		delete_all("WhatsApp Device", {"platform_device": DEVICE})
		super().tearDownClass()

	def setUp(self):
		self._clean()
		ensure_settings(queue_paused=0, messages_per_minute=20)

	@classmethod
	def _clean(cls):
		logs = frappe.get_all("WhatsApp Log", {"body": ("like", BODY + "%")}, pluck="name")
		if logs:
			delete_all("WhatsApp Queue Item", {"outbound_message": ("in", logs)})
			delete_all("WhatsApp Log", {"name": ("in", logs)})

	def _item(self, phone: str, priority: int | None = None) -> tuple[str, str]:
		outbound = dispatch.create_outbound(
			OutboundSpec(device=self.device, phone=phone, body=f"{BODY} {phone}", source_type="Quick Send")
		)
		return outbound, dispatch.enqueue([outbound], priority=priority)[0]

	def test_role_gates(self):
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.list_queue()
		with as_user("WhatsApp Viewer"):
			self.assertIn("rows", api.list_queue())
			with self.assertRaises(WAPermissionError):
				api.pause_queue(reason="x")

	def test_list_position_eta_and_filters(self):
		_, low = self._item(P1, priority=5)
		_, first = self._item(P2, priority=1)
		_, second = self._item(P3, priority=1)
		with as_user("WhatsApp Viewer"):
			out = api.list_queue(filters={"device": self.device, "status": "Queued"}, page_length=999)
		by_name = {r["name"]: r for r in out["rows"]}
		self.assertEqual(out["total"], 3)
		self.assertEqual(by_name[first]["position"], 1)
		self.assertEqual(by_name[second]["position"], 2)
		self.assertEqual(by_name[low]["position"], 3)
		self.assertEqual(by_name[low]["eta_minutes"], round(3 / 20, 2))
		self.assertIsNotNone(by_name[low]["eta"])
		self.assertIn("summary", out)
		with as_user("WhatsApp Viewer"):
			phone = api.list_queue(filters={"phone": P3[-6:]})
			self.assertEqual([r["name"] for r in phone["rows"]], [second])
			with self.assertRaises(WAValidationError):
				api.list_queue(filters={"status": "Bogus"})
			with self.assertRaises(WAValidationError):
				api.list_queue(filters={"outbound_message": "x"})
			paged = api.list_queue(filters={"device": self.device}, page=2, page_length=2)
			self.assertEqual(len(paged["rows"]), 1)

	def test_limits(self):
		with as_user("WhatsApp Viewer"):
			out = api.get_limits()
		self.assertEqual(set(out), {"rate", "plan_rate"})
		self.assertEqual(out["rate"], 20)

	def test_summary(self):
		frappe.cache.delete_value(dispatch.PLATFORM_QUEUE_CACHE_KEY)
		self._item(P1)
		with fake_provider(), as_user("WhatsApp Viewer"):
			out = api.get_summary()
		self.assertGreaterEqual(out["counts_by_status"]["Queued"], 1)
		self.assertIn("Dead Letter", out["counts_by_status"])
		self.assertFalse(out["paused"])
		self.assertEqual(out["rate"], 20)
		self.assertEqual(out["platform_queue"]["messages_per_minute"], 60)
		frappe.cache.delete_value(dispatch.PLATFORM_QUEUE_CACHE_KEY)

	def test_throughput_buckets(self):
		"""One bucket per minute, zero-filled, with the completed rows landing in their own minute."""
		_, q1 = self._item(P1)
		_, q2 = self._item(P2)
		now = frappe.utils.now_datetime()
		for name, minutes in ((q1, 2), (q2, 40)):
			frappe.db.set_value(
				"WhatsApp Queue Item",
				name,
				{"status": "Completed", "completed_at": frappe.utils.add_to_date(now, minutes=-minutes)},
				update_modified=False,
			)
		with as_user("WhatsApp Viewer"):
			out = api.get_throughput(minutes=60)
		self.assertEqual(out["minutes"], 60)
		self.assertEqual(len(out["buckets"]), 60)
		self.assertGreaterEqual(out["sent"], 2)
		# newest minute last: the two-minutes-old row sits near the end, the forty-minutes-old one before it
		self.assertGreaterEqual(out["buckets"][-3], 1)
		self.assertGreaterEqual(out["buckets"][19], 1)
		self.assertGreaterEqual(out["peak"], 1)
		# a row outside the window is not counted
		with as_user("WhatsApp Viewer"):
			narrow = api.get_throughput(minutes=5)
		self.assertEqual(len(narrow["buckets"]), 5)
		self.assertEqual(sum(narrow["buckets"]), 1)

	def test_throughput_window_is_bounded(self):
		with as_user("WhatsApp Viewer"):
			self.assertEqual(api.get_throughput(minutes=9999)["minutes"], 180)
			self.assertEqual(api.get_throughput(minutes=1)["minutes"], 5)

	def test_global_pause_resume_rate(self):
		with as_user("WhatsApp Manager"):
			paused = api.pause_queue(reason="ApiTest pause")
			self.assertIsNotNone(paused["paused_at"])
			self.assertTrue(frappe.db.get_single_value("WhatsApp Settings", "queue_paused"))
			self.assertIsNotNone(api.resume_queue()["resumed_at"])
			self.assertFalse(frappe.db.get_single_value("WhatsApp Settings", "queue_paused"))
			self.assertEqual(api.set_rate(messages_per_minute="25"), {"messages_per_minute": 25})
			with self.assertRaises(WAValidationError):
				api.set_rate(messages_per_minute=999)
			with self.assertRaises(WAValidationError):
				api.set_rate(messages_per_minute="abc")

	def test_item_operations(self):
		out1, q1 = self._item(P1)
		_, q2 = self._item(P2)
		_, q3 = self._item(P3)
		with as_user("WhatsApp Manager"):
			with self.assertRaises(WAValidationError):
				api.pause_items()
			with self.assertRaises(WAValidationError):
				api.pause_items(filters={"status": "Queued"})
			self.assertEqual(api.pause_items(names=[q1, q2], reason="ApiTest"), {"count": 2})
			self.assertEqual(frappe.db.get_value("WhatsApp Queue Item", q1, "status"), "Paused")
			self.assertEqual(api.resume_items(filters={"device": self.device}), {"count": 2})
			self.assertEqual(frappe.db.get_value("WhatsApp Queue Item", q1, "status"), "Queued")
			self.assertEqual(api.delete_items(names=[q1], reason="ApiTest delete"), {"count": 1})
			self.assertEqual(frappe.db.get_value("WhatsApp Queue Item", q1, "status"), "Deleted")
			self.assertEqual(frappe.db.get_value("WhatsApp Log", out1, "status"), "Cancelled")
			with status_writer():
				frappe.db.set_value("WhatsApp Queue Item", q2, "status", "Sending")
			with self.assertRaises(WAStateConflictError):
				api.delete_items(names=[q2])
			with status_writer():
				frappe.db.set_value("WhatsApp Queue Item", q3, {"status": "Dead Letter", "attempts": 3})
			with self.assertRaises(WAValidationError):
				api.retry_dead_letter(names=[])
			self.assertEqual(api.retry_dead_letter(names=[q3, q2]), {"count": 1})
			self.assertEqual(
				frappe.db.get_value("WhatsApp Queue Item", q3, ["status", "attempts"]), ("Queued", 0)
			)
