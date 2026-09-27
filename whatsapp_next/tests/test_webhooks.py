# Tests for the webhook layer (build order B-12): receiver auth / freshness / rate limit /
# idempotency, handler dispatch per event (status → dispatch, received → inbound, connection →
# devices), payload blanking, failure retries, and services/inbound.py intake rules.

from __future__ import annotations

import json
import time
from pathlib import Path
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.providers.snd_platform import SndPlatformProvider
from whatsapp_next.services import dispatch, inbound
from whatsapp_next.services.dispatch import OutboundSpec
from whatsapp_next.tests.conftest_frappe import (
	delete_all,
	delete_test_rows,
	ensure_device,
	ensure_settings,
	fake_provider,
)
from whatsapp_next.webhooks import handlers, verify
from whatsapp_next.webhooks.v1 import receiver

FIXTURES = Path(__file__).parent / "fixtures" / "webhooks"
SECRET = "test-webhook-secret"
PLATFORM_DEVICE = "WAD-TEST-WH01"


# Every event id these tests deliver: the fixtures' own plus the ones passed explicitly. Clean-ups
# and counts are scoped to them, so the site's real webhook events are never touched (R-041).
TEST_EVENT_IDS: tuple[str, ...] = tuple(
	sorted(
		{json.loads(p.read_text()).get("event_id") for p in FIXTURES.glob("*.json")} - {None}
		| {"stale-1", "bad-json", "evt-nope", "evt_unknown_ref"}
	)
)


def fixture(name: str, **overrides) -> dict:
	body = json.loads((FIXTURES / f"{name}.json").read_text())
	body.update(overrides)
	return body


def signed(
	body: dict, *, secret: str = SECRET, ts: int | None = None, event_id: str | None = None
) -> tuple[dict, bytes]:
	raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
	ts = ts or int(time.time())
	headers = {
		"X-SND-Event": body.get("event", ""),
		"X-SND-Event-ID": event_id or body.get("event_id", ""),
		"X-SND-Timestamp": str(ts),
		"X-SND-Signature": SndPlatformProvider.sign(secret, str(ts), raw),
	}
	return headers, raw


class TestWebhooks(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("Webhook Device", PLATFORM_DEVICE, phone="+966500000001")
		settings = ensure_settings(enable_commands=0)
		# The site's own signing secret goes back afterwards: left behind, the fixture secret makes
		# every real delivery to this site fail its signature check.
		cls._site_secret = settings.get_password("webhook_secret", raise_exception=False)
		settings.webhook_secret = SECRET
		settings.save(ignore_permissions=True)
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")

	@classmethod
	def tearDownClass(cls):
		from frappe.utils.password import remove_encrypted_password, set_encrypted_password

		if cls._site_secret:
			set_encrypted_password(
				"WhatsApp Settings", "WhatsApp Settings", cls._site_secret, "webhook_secret"
			)
		else:
			remove_encrypted_password("WhatsApp Settings", "WhatsApp Settings", "webhook_secret")
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
		frappe.db.commit()
		super().tearDownClass()

	def setUp(self):
		self._clean()
		verify.reset_signature_failures()
		frappe.cache.delete_value(receiver.SECRET_MISSING_LOG_KEY)

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_test_rows("WhatsApp Webhook Event")
		delete_all("WhatsApp Webhook Event", {"event_id": ("in", TEST_EVENT_IDS)})
		delete_test_rows("WhatsApp Inbound Message")
		delete_test_rows("WhatsApp Queue Item")
		delete_all("WhatsApp Log", {"body": ("like", "webhook-test%")})
		frappe.db.commit()

	def _event(self, name):
		return frappe.db.get_value(
			"WhatsApp Webhook Event",
			name,
			[
				"status",
				"payload",
				"duplicate_count",
				"signature_valid",
				"timestamp_fresh",
				"error",
				"device",
				"inbound_message",
				"outbound_message",
				"processing_ms",
				"client_ref",
			],
			as_dict=True,
		)

	# -- receiver --------------------------------------------------------------------

	def test_receiver_rejects_bad_deliveries(self):
		body = fixture("message.received")
		with fake_provider():
			self.assertEqual(receiver.handle({}, b"{}").http_status, 401)
			self.assertEqual(
				frappe.db.count("WhatsApp Webhook Event", {"event_id": ("in", TEST_EVENT_IDS)}), 0
			)
			headers, raw = signed(body, secret="wrong")
			out = receiver.handle(headers, raw)
			self.assertEqual((out.http_status, out.body["error"]), (401, "invalid signature"))
			row = frappe.get_all(
				"WhatsApp Webhook Event",
				filters={"event_id": body["event_id"]},
				fields=["status", "payload", "signature_valid", "error"],
			)[0]
			self.assertEqual(
				(row.status, row.payload, row.signature_valid, row.error),
				("Ignored", None, 0, "invalid signature"),
			)
			headers, raw = signed(body, ts=int(time.time()) - 3600, event_id="stale-1")
			out = receiver.handle(headers, raw)
			self.assertEqual((out.http_status, out.body["error"]), (401, "stale timestamp"))
			self.assertEqual(
				frappe.db.get_value("WhatsApp Webhook Event", {"event_id": "stale-1"}, "timestamp_fresh"), 0
			)
			headers, raw = signed(body, event_id="bad-json")
			raw = b"not json"
			headers["X-SND-Signature"] = SndPlatformProvider.sign(SECRET, headers["X-SND-Timestamp"], raw)
			self.assertEqual(receiver.handle(headers, raw).http_status, 400)
		# missing secret → 503 and one Error Log per 10 minutes
		with patch.object(receiver, "_secret", return_value=None), fake_provider():
			headers, raw = signed(body)
			self.assertEqual(receiver.handle(headers, raw).http_status, 503)
			self.assertEqual(receiver.handle(headers, raw).http_status, 503)
		# only the invalid-signature Ignored row exists for this id; the 503 path stored nothing
		self.assertEqual(
			frappe.get_all("WhatsApp Webhook Event", filters={"event_id": body["event_id"]}, pluck="status"),
			["Ignored"],
		)

	def test_verified_retry_takes_over_a_rejected_delivery(self):
		"""A delivery refused for its signature (e.g. mid secret rotation) must not make the
		platform's correctly signed retry of the same event a never-processed duplicate."""
		body = fixture("message.received")
		with fake_provider(), patch.object(frappe, "enqueue") as enq:
			headers, raw = signed(body, secret="wrong")
			self.assertEqual(receiver.handle(headers, raw).http_status, 401)
			headers, raw = signed(body)
			out = receiver.handle(headers, raw)
			self.assertEqual(out.http_status, 200)
			self.assertNotIn("duplicate", out.body)
			row = self._event(out.event)
			self.assertEqual(
				(row.status, row.signature_valid, row.timestamp_fresh, row.error, row.duplicate_count),
				("Received", 1, 1, None, 0),
			)
			self.assertIsNotNone(row.payload)
			self.assertEqual(enq.call_count, 1)
			# a verified repeat is a duplicate as before, and a later bad one never downgrades it
			self.assertEqual(receiver.handle(headers, raw).body, {"ok": True, "duplicate": True})
			headers, raw = signed(body, secret="wrong")
			self.assertEqual(receiver.handle(headers, raw).http_status, 401)
			self.assertEqual(self._event(out.event).status, "Received")
		self.assertEqual(frappe.db.count("WhatsApp Webhook Event", {"event_id": body["event_id"]}), 1)

	def test_signature_failure_counter_triggers_refetch_once(self):
		with patch.object(frappe, "enqueue") as enq:
			for _ in range(verify.SIGFAIL_THRESHOLD + 1):
				verify.note_signature_failure()
		self.assertEqual(enq.call_count, 1)
		self.assertEqual(enq.call_args.args[0], "whatsapp_next.services.webhook_setup.fetch_secret")

	def test_rate_limit(self):
		with patch.object(receiver, "RATE_LIMIT_PER_MINUTE", 2), fake_provider():
			frappe.cache.delete(frappe.cache.make_key(receiver.RATE_KEY.format(ip="10.0.0.9")))
			headers, raw = signed(fixture("message.received"))
			codes = [receiver.handle(headers, raw, remote_ip="10.0.0.9").http_status for _ in range(4)]
		self.assertEqual(codes, [200, 200, 429, 429])
		frappe.cache.delete(frappe.cache.make_key(receiver.RATE_KEY.format(ip="10.0.0.9")))

	def test_receive_process_and_duplicate(self):
		body = fixture("message.received")
		with fake_provider(), patch.object(frappe, "enqueue") as enq:
			headers, raw = signed(body)
			out = receiver.handle(headers, raw)
			self.assertEqual((out.http_status, out.body), (200, {"ok": True}))
			row = self._event(out.event)
			self.assertEqual((row.status, row.device, row.duplicate_count), ("Received", self.device, 0))
			self.assertEqual(json.loads(row.payload)["event_id"], body["event_id"])
			self.assertTrue(
				any(c.args[0] == "whatsapp_next.webhooks.handlers.process_event" for c in enq.call_args_list)
			)
			self.assertIsNotNone(frappe.db.get_single_value("WhatsApp Settings", "webhook_last_event_at"))
			# duplicate delivery
			out2 = receiver.handle(headers, raw)
			self.assertEqual(out2.body, {"ok": True, "duplicate": True})
			self.assertEqual(self._event(out.event).duplicate_count, 1)
			# processing
			self.assertEqual(handlers.process_event(out.event), "Processed")
			row = self._event(out.event)
			self.assertIsNotNone(row.inbound_message)
			self.assertIsNotNone(row.payload)  # non-terminal: kept until retention
			msg = frappe.db.get_value(
				"WhatsApp Inbound Message",
				row.inbound_message,
				["phone_e164", "display_name", "body", "is_group", "device", "command_status"],
				as_dict=True,
			)
			self.assertEqual(
				(msg.phone_e164, msg.display_name, msg.body, msg.is_group, msg.device, msg.command_status),
				("+966500000002", "Ahmed", "كشف حساب", 0, self.device, "None"),
			)
			# processing again is a no-op; the inbound row is not duplicated
			self.assertEqual(handlers.process_event(out.event), "Processed")
			self.assertEqual(
				frappe.db.count(
					"WhatsApp Inbound Message",
					{"provider_message_id": body["provider_message_id"], "device": self.device},
				),
				1,
			)

	def test_status_events_apply_to_outbound(self):
		out_name = dispatch.create_outbound(
			OutboundSpec(device=self.device, phone="+966500000002", body="webhook-test hi", source_type="API")
		)
		with fake_provider(), patch.object(frappe, "enqueue"):
			for event_name, expected in (
				("message.sent", "Sent"),
				("message.delivered", "Delivered"),
				("message.read", "Read"),
			):
				body = fixture(event_name, client_ref=out_name)
				headers, raw = signed(body)
				out = receiver.handle(headers, raw)
				self.assertEqual(handlers.process_event(out.event), "Processed")
				row = self._event(out.event)
				self.assertEqual(
					(row.outbound_message, row.payload), (out_name, None)
				)  # terminal: payload blanked
				self.assertEqual(frappe.db.get_value("WhatsApp Log", out_name, "status"), expected)
			self.assertEqual(
				frappe.db.get_value("WhatsApp Log", out_name, "provider_message_id"),
				fixture("message.sent")["provider_message_id"],
			)
			# failed after read is still recorded (final), held on a fresh row
			body = fixture("message.failed", client_ref=out_name)
			headers, raw = signed(body)
			self.assertEqual(handlers.process_event(receiver.handle(headers, raw).event), "Processed")
			self.assertEqual(frappe.db.get_value("WhatsApp Log", out_name, "status"), "Failed")
			held = dispatch.create_outbound(
				OutboundSpec(
					device=self.device, phone="+966500000003", body="webhook-test held", source_type="API"
				)
			)
			body = fixture("message.held", client_ref=held)
			headers, raw = signed(body)
			self.assertEqual(handlers.process_event(receiver.handle(headers, raw).event), "Processed")
			self.assertEqual(frappe.db.get_value("WhatsApp Log", held, "status"), "Held")
			# unknown client_ref → Ignored
			body = fixture(
				"message.sent",
				client_ref="no-such-log",
				provider_message_id="nope",
				event_id="evt_unknown_ref",
			)
			headers, raw = signed(body)
			self.assertEqual(handlers.process_event(receiver.handle(headers, raw).event), "Ignored")

	def test_connection_and_unknown_device(self):
		with fake_provider(), patch.object(frappe, "enqueue"):
			body = fixture("connection.disconnected")
			headers, raw = signed(body)
			out = receiver.handle(headers, raw)
			self.assertEqual(handlers.process_event(out.event), "Processed")
			self.assertEqual(frappe.db.get_value("WhatsApp Device", self.device, "status"), "Disconnected")
			body = fixture("connection.connected")
			headers, raw = signed(body)
			handlers.process_event(receiver.handle(headers, raw).event)
			self.assertEqual(frappe.db.get_value("WhatsApp Device", self.device, "status"), "Connected")
			# unknown device: stored as Ignored, never created, not enqueued
			body = fixture("message.received", device="WAD-NOPE", event_id="evt-nope")
			headers, raw = signed(body)
			out = receiver.handle(headers, raw)
			self.assertEqual(out.body, {"ok": True, "ignored": True})
			self.assertEqual(
				(self._event(out.event).status, self._event(out.event).error), ("Ignored", "unknown device")
			)
			self.assertFalse(frappe.db.exists("WhatsApp Device", {"platform_device": "WAD-NOPE"}))
			# unknown event name → Ignored, payload kept
			body = fixture("unknown.event")
			headers, raw = signed(body)
			out = receiver.handle(headers, raw)
			self.assertEqual(handlers.process_event(out.event), "Ignored")
			self.assertIsNotNone(self._event(out.event).payload)

	def test_handler_failure_retries_three_times(self):
		with fake_provider(), patch.object(frappe, "enqueue"):
			headers, raw = signed(fixture("message.received"))
			out = receiver.handle(headers, raw)
			with patch.object(handlers, "handle_event", side_effect=RuntimeError("boom")):
				self.assertEqual(handlers.process_event(out.event), "Failed")
				self.assertTrue(self._event(out.event).error.startswith("[try 1] RuntimeError"))
				self.assertEqual(handlers.reprocess_failed(), 1)
				self.assertTrue(self._event(out.event).error.startswith("[try 2]"))
				handlers.reprocess_failed()
				self.assertTrue(self._event(out.event).error.startswith("[try 3]"))
				self.assertEqual(handlers.reprocess_failed(), 0)  # exhausted
			# a later successful reprocess is still possible manually
			frappe.db.set_value("WhatsApp Webhook Event", out.event, "error", None)
			frappe.db.set_value(
				"WhatsApp Webhook Event", out.event, "status", "Received", update_modified=False
			)
			self.assertEqual(handlers.process_event(out.event), "Processed")

	# -- inbound service ---------------------------------------------------------------

	def test_inbound_rules(self):
		with fake_provider(), patch.object(frappe, "enqueue") as enq:
			provider = frappe.get_attr("whatsapp_next.providers.registry.get_provider")()
			ev = provider.parse_webhook({}, fixture("message.received.group"))
			name = inbound.record_inbound(ev, device=self.device)
			row = frappe.db.get_value(
				"WhatsApp Inbound Message", name, ["is_group", "chat_jid", "phone_e164"], as_dict=True
			)
			self.assertEqual(row.is_group, 1)
			self.assertTrue(row.chat_jid.endswith("@g.us"))
			lid = provider.parse_webhook({}, fixture("message.received.lid"))
			name = inbound.record_inbound(lid, device=self.device)
			row = frappe.db.get_value(
				"WhatsApp Inbound Message", name, ["phone_e164", "sender_jid"], as_dict=True
			)
			self.assertIsNone(row.phone_e164)
			self.assertTrue(row.sender_jid.endswith("@lid"))
			react = provider.parse_webhook({}, fixture("message.reaction"))
			name = inbound.record_reaction(react, device=self.device)
			row = frappe.db.get_value(
				"WhatsApp Inbound Message",
				name,
				["message_type", "reaction", "reaction_to_provider_message_id"],
				as_dict=True,
			)
			self.assertEqual(row.message_type, "Reaction")
			self.assertTrue(row.reaction and row.reaction_to_provider_message_id)
			self.assertEqual(inbound.record_reaction(react, device=self.device), name)  # dedupe
			# routing gate: commands disabled → nothing enqueued to the router
			self.assertFalse(any(c.args[0].endswith("command_router.route") for c in enq.call_args_list))
			self.assertTrue(
				any(
					c.args[0].endswith("numbers_materializer.upsert_from_message") for c in enq.call_args_list
				)
			)
		self.assertFalse(inbound.should_route("Text", "كشف", False))  # Settings: commands disabled
		self.assertTrue(inbound.should_route("Text", "كشف", False, enabled=True))
		self.assertFalse(inbound.should_route("Text", "hello", True, enabled=True))
		self.assertTrue(inbound.should_route("Text", "#help", True, enabled=True))
		self.assertFalse(inbound.should_route("Image", "x", False, enabled=True))
		self.assertFalse(inbound.should_route("Text", "  ", False, enabled=True))
		self.assertEqual(len(inbound.key_hash("+966500000002")), 40)
		self.assertIsNone(inbound.key_hash(None))
