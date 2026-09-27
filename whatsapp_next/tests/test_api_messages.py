# Tests for api/v1/messages.py (build order B-20): role gates (incl. Contact User denied on the
# conversation), drawer payloads (reference, timeline without payloads), conversation paging
# through the read layer, resend (terminal only), bulk resend and cancel through the dispatcher.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import messages as api
from whatsapp_next.exceptions import WANotFoundError, WAPermissionError, WAStateConflictError
from whatsapp_next.services import dispatch
from whatsapp_next.services.dispatch import OutboundSpec
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import as_user, delete_all, ensure_device, ensure_settings

P1, P2 = "+966500920201", "+966500920202"
TAG = "ApiTest msg"


class TestApiMessages(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("ApiTest Device MSG", "WAD-TEST-API22", phone="+966500920002")
		ensure_settings(default_device=cls.device, queue_paused=0, send_only_to_known_numbers=0)

	@classmethod
	def tearDownClass(cls):
		cls._clean()
		super().tearDownClass()

	def setUp(self):
		self._clean()

	@staticmethod
	def _clean():
		names = frappe.get_all("WhatsApp Log", filters={"body": ("like", f"{TAG}%")}, pluck="name")
		if names:
			delete_all("WhatsApp Webhook Event", {"outbound_message": ("in", names)})
			delete_all("WhatsApp Queue Item", {"outbound_message": ("in", names)})
			delete_all("WhatsApp Log", {"name": ("in", names)})
		delete_all("WhatsApp Inbound Message", {"body": ("like", f"{TAG}%")})

	def _queued(self, phone=P1, body=f"{TAG} out"):
		return dispatch.create_and_enqueue(
			OutboundSpec(device=self.device, phone=phone, body=body, source_type="Quick Send")
		)

	def _terminal(self, status="Failed", phone=P1):
		out, item = self._queued(phone=phone)
		with status_writer():
			frappe.db.set_value("WhatsApp Log", out, {"status": status, "error_code": "timeout"})
			frappe.db.set_value("WhatsApp Queue Item", item, "status", "Dead Letter")
		return out, item

	def _inbound(self, phone=P1, body=f"{TAG} in"):
		doc = frappe.get_doc(
			{
				"doctype": "WhatsApp Inbound Message",
				"device": self.device,
				"phone": phone,
				"message_type": "Text",
				"body": body,
				"provider_message_id": "apitest-" + frappe.generate_hash(length=8),
				"command_status": "None",
			}
		)
		doc.insert(ignore_permissions=True)
		return doc.name

	def _event(self, outbound):
		with status_writer():
			doc = frappe.get_doc(
				{
					"doctype": "WhatsApp Webhook Event",
					"event_id": "apitest-" + frappe.generate_hash(length=8),
					"event_name": "message.sent",
					"status": "Processed",
					"device": self.device,
					"outbound_message": outbound,
					"payload": '{"secret": "never returned"}',
				}
			)
			doc.flags.ignore_permissions = True
			doc.insert(ignore_permissions=True)
		return doc.name

	# -- gates -------------------------------------------------------------------------

	def test_role_gates(self):
		out, _item = self._queued()
		inb = self._inbound()
		with as_user("_none"):
			with self.assertRaises(WAPermissionError):
				api.get_outbound(name=out)
			with self.assertRaises(WAPermissionError):
				api.get_conversation(key=P1)
		with as_user("WhatsApp Contact User"), self.assertRaises(WAPermissionError):
			api.get_conversation(key=P1)  # D-029 OQ-5: CU without Viewer is denied
		with as_user("WhatsApp Viewer"):
			self.assertEqual(api.get_outbound(name=out)["name"], out)
			self.assertEqual(api.get_inbound(name=inb)["name"], inb)
			self.assertTrue(api.get_conversation(key=P1)["rows"])
			with self.assertRaises(WAPermissionError):
				api.resend(name=out)
			with self.assertRaises(WAPermissionError):
				api.cancel(name=out, reason="x")
		with as_user("WhatsApp Agent"), self.assertRaises(WAPermissionError):
			api.cancel(name=out, reason="x")

	# -- drawer ------------------------------------------------------------------------

	def test_get_outbound_payload(self):
		out, item = self._queued()
		self._event(out)
		with as_user("WhatsApp Viewer"):
			row = api.get_outbound(name=out)
		self.assertEqual(row["status"], "Queued")
		self.assertEqual(row["reference"], {"doctype": None, "name": None, "amount": None})
		self.assertEqual(row["timeline"]["queue_item"]["name"], item)
		self.assertEqual(row["timeline"]["queue_item"]["status"], "Queued")
		events = row["timeline"]["webhook_events"]
		self.assertEqual([e["event_name"] for e in events], ["message.sent"])
		self.assertNotIn("payload", events[0])
		with as_user("WhatsApp Viewer"), self.assertRaises(WANotFoundError):
			api.get_outbound(name="no-such-ApiTest-row")

	def test_get_inbound_payload(self):
		inb = self._inbound()
		out, _item = self._queued()
		with status_writer():
			frappe.db.set_value(
				"WhatsApp Inbound Message",
				inb,
				{"command_status": "Not Matched", "command_text": "#nope", "reply_outbound": out},
			)
		with as_user("WhatsApp Viewer"):
			row = api.get_inbound(name=inb)
		self.assertEqual(row["command_trace"]["command_status"], "Not Matched")
		self.assertEqual(row["command_trace"]["command_text"], "#nope")
		self.assertNotIn("command_status", row)
		self.assertEqual(row["reply_outbound"]["name"], out)
		self.assertEqual(row["ui"]["name"], inb)
		with as_user("WhatsApp Viewer"), self.assertRaises(WANotFoundError):
			api.get_inbound(name="no-such-ApiTest-row")

	def test_inbound_summary(self):
		"""09 G-07: exact counts (measured as the difference its own rows make) and the reply time."""
		from frappe.utils import add_to_date, now_datetime

		with as_user("WhatsApp Viewer"):
			before = api.get_inbound_summary(days=30)
		executed = self._inbound(body=f"{TAG} summary 1")
		self._inbound(body=f"{TAG} summary 2")
		received = now_datetime()
		frappe.db.set_value(
			"WhatsApp Inbound Message",
			executed,
			{
				"command_status": "Executed",
				"received_at": received,
				"replied_at": add_to_date(received, seconds=3),
			},
		)
		frappe.db.set_value(
			"WhatsApp Inbound Message",
			self._inbound(body=f"{TAG} summary 3"),
			"command_status",
			"Not Matched",
		)
		with as_user("WhatsApp Viewer"):
			after = api.get_inbound_summary(days=30)
		self.assertEqual(after["total"] - before["total"], 3)
		self.assertEqual(after["executed"] - before["executed"], 1)
		self.assertEqual(after["unmatched"] - before["unmatched"], 1)
		self.assertIsNotNone(after["avg_reply_seconds"])
		self.assertGreaterEqual(after["replies_measured"], 1)
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.get_inbound_summary()

	def test_get_conversation_pages(self):
		o1, _ = self._queued()
		i1 = self._inbound()
		o2, _ = self._queued()
		self._queued(phone=P2)  # other key
		with as_user("WhatsApp Viewer"):
			page = api.get_conversation(key=P1)
			self.assertEqual({r["name"] for r in page["rows"]}, {o1, i1, o2})
			self.assertEqual({r["direction"] for r in page["rows"]}, {"Outbound", "Inbound"})
			self.assertTrue(all(r["cursor"] for r in page["rows"]))
			self.assertFalse(page["has_more"])
			self.assertIsNone(page["next_cursor"])
			first = api.get_conversation(key=P1, limit="1")
			self.assertEqual((len(first["rows"]), first["has_more"]), (1, True))
			second = api.get_conversation(key=P1, before=first["next_cursor"], limit=5)
			self.assertEqual(len(second["rows"]), 2)
			self.assertNotIn(first["rows"][0]["name"], [r["name"] for r in second["rows"]])
			self.assertEqual(api.get_conversation(key=P1, device="no-such-device")["rows"], [])

	# -- resend / cancel ---------------------------------------------------------------

	def test_resend_terminal_only(self):
		queued, _ = self._queued()
		failed, _ = self._terminal()
		with as_user("WhatsApp Agent"):
			with self.assertRaises(WAStateConflictError):
				api.resend(name=queued)
			res = api.resend(name=failed)
		new = frappe.db.get_value(
			"WhatsApp Log",
			res["outbound"],
			["status", "attempts", "source_type", "phone_e164", "body", "queue_item", "error_code"],
			as_dict=True,
		)
		self.assertNotEqual(res["outbound"], failed)
		self.assertEqual(
			(
				new.status,
				new.attempts,
				new.source_type,
				new.phone_e164,
				new.body,
				new.queue_item,
				new.error_code,
			),
			("Queued", 0, "Quick Send", P1, f"{TAG} out", res["queue_item"], None),
		)
		self.assertEqual(
			frappe.db.get_value("WhatsApp Log", failed, "status"), "Failed"
		)  # original untouched
		with as_user("WhatsApp Agent"), self.assertRaises(WANotFoundError):
			api.resend(name="no-such-ApiTest-row")

	def test_resend_many(self):
		queued, _ = self._queued()
		failed, _ = self._terminal()
		cancelled, _ = self._terminal(status="Cancelled", phone=P2)
		with as_user("WhatsApp Agent"):
			res = api.resend_many(names=[failed, queued, "no-such-ApiTest-row", cancelled, failed])
		self.assertEqual(res["count"], 2)
		self.assertEqual(res["done"], [failed, cancelled])
		self.assertEqual([s["name"] for s in res["skipped"]], [queued])
		self.assertEqual([f["name"] for f in res["failed"]], ["no-such-ApiTest-row"])
		self.assertEqual(
			frappe.db.count("WhatsApp Log", {"body": ("like", f"{TAG}%"), "status": "Queued"}), 3
		)

	def test_cancel(self):
		out, item = self._queued()
		with as_user("WhatsApp Manager"):
			self.assertEqual(api.cancel(name=out, reason="ApiTest cancel"), {"status": "Cancelled"})
			self.assertEqual(frappe.db.get_value("WhatsApp Queue Item", item, "status"), "Deleted")
			with self.assertRaises(WAStateConflictError):
				api.cancel(name=out, reason="again")  # nothing open any more
			sending, _ = self._queued(phone=P2)
			dispatch.claim_batch(self.device, 10)
			self.assertEqual(frappe.db.get_value("WhatsApp Log", sending, "status"), "Sending")
			with self.assertRaises(WAStateConflictError):
				api.cancel(name=sending, reason="x")
			with self.assertRaises(WANotFoundError):
				api.cancel(name="no-such-ApiTest-row")
