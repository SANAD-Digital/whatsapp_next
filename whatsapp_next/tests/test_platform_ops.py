# Tests for services/webhook_setup.py, usage_sync.py and retention.py (build order B-17):
# endpoint registration and mirroring, secret storage as a password, status changes, hourly
# sync, subscription cache, and retention purge order / audit rows / never-purge settings.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_days, now_datetime

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.providers.schemas import WebhookEndpointState
from whatsapp_next.services import retention, usage_sync, webhook_setup
from whatsapp_next.services.guards import status_writer
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_device, ensure_settings, fake_provider
from whatsapp_next.tests.fake_provider import FakeProvider


class EndpointProvider(FakeProvider):
	"""FakeProvider with a scripted webhook-endpoint store."""

	def __init__(self):
		super().__init__()
		self.store: dict[str, WebhookEndpointState] = {}
		self.secret_calls = 0

	def get_webhook_secret(self):
		self.secret_calls += 1
		return "provider-secret-1"

	def configure_webhook(self, endpoint_url, events, max_retries):
		state = WebhookEndpointState(
			endpoint_id=self._next("WEP"),
			url=endpoint_url,
			status="Active",
			events=tuple(events),
			max_retries=max_retries,
		)
		self.store[state.endpoint_id] = state
		return state

	def list_webhook_endpoints(self):
		return list(self.store.values())

	def update_webhook_endpoint(self, endpoint_id, status, events, url):
		cur = self.store[endpoint_id]
		state = WebhookEndpointState(
			endpoint_id=endpoint_id,
			url=url or cur.url,
			status=status or ("Active" if cur.status == "Locked" and status == "Active" else cur.status),
			events=tuple(events) if events else cur.events,
			max_retries=cur.max_retries,
		)
		self.store[endpoint_id] = state
		return state

	def test_webhook_endpoint(self, endpoint_id):
		return {"ok": True, "http_status": 200}


class TestPlatformOps(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("Ops Device", "WAD-TEST-OP01", phone="+966500000081")

	def setUp(self):
		delete_all(
			"WhatsApp Audit Log",
			{
				"action": (
					"in",
					["Webhook Changed", "Credentials Changed", "Connection Tested", "Retention Purge"],
				)
			},
		)
		ensure_settings(
			webhook_endpoint=None, webhook_endpoint_url=None, webhook_status=None, webhook_events=None
		)

	def test_webhook_setup_lifecycle(self):
		provider = EndpointProvider()
		with fake_provider(provider):
			from frappe.utils.password import remove_encrypted_password

			remove_encrypted_password("WhatsApp Settings", "WhatsApp Settings", "webhook_secret")
			frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
			summary = webhook_setup.ensure_endpoint(user="Administrator")
			self.assertTrue(summary.endpoint_id.startswith("WEP-"))
			self.assertEqual(summary.status, "Active")
			self.assertTrue(summary.url.endswith("/api/method/whatsapp_next.webhooks.v1.receiver.receive"))
			self.assertEqual(set(summary.events), set(webhook_setup.DEFAULT_EVENTS))
			self.assertEqual(
				frappe.get_single("WhatsApp Settings").get_password("webhook_secret"), "provider-secret-1"
			)
			self.assertEqual(provider.secret_calls, 1)
			self.assertEqual(frappe.db.count("WhatsApp Audit Log", {"action": "Credentials Changed"}), 1)
			# idempotent: same endpoint, no second secret fetch
			again = webhook_setup.ensure_endpoint()
			self.assertEqual(
				(again.endpoint_id, provider.secret_calls, len(provider.store)), (summary.endpoint_id, 1, 1)
			)
			# status / test / sync
			self.assertEqual(webhook_setup.set_status("Disabled").status, "Disabled")
			with self.assertRaises(WAValidationError):
				webhook_setup.set_status("Locked")
			self.assertTrue(webhook_setup.test()["ok"])
			provider.store[summary.endpoint_id] = WebhookEndpointState(
				endpoint_id=summary.endpoint_id,
				url=summary.url,
				status="Locked",
				events=summary.events,
				max_retries=3,
				lock_reason="5 failures",
			)
			synced = webhook_setup.sync_status()
			self.assertEqual(synced.status, "Locked")
			self.assertEqual(webhook_setup.set_status("Active").status, "Active")
			self.assertTrue(webhook_setup.rotate_secret())
			self.assertEqual(provider.secret_calls, 2)
			# endpoint vanished on the platform → Revoked
			provider.store.clear()
			self.assertEqual(webhook_setup.sync_status().status, "Revoked")
		self.assertGreaterEqual(frappe.db.count("WhatsApp Audit Log", {"action": "Webhook Changed"}), 3)

	def test_usage_sync(self):
		ensure_settings(messages_per_minute=20, plan_messages_per_minute=0)
		with fake_provider():
			values = usage_sync.sync_subscription()
		self.assertEqual(
			(
				values["plan_code"],
				values["message_limit"],
				values["messages_remaining"],
				values["plan_messages_per_minute"],
			),
			("fake", 1000, 990, 60),
		)
		snap = usage_sync.snapshot()
		self.assertEqual(snap["plan_features"]["allow_webhooks"], True)
		self.assertEqual(frappe.db.get_single_value("WhatsApp Settings", "plan_code"), "fake")
		# the local rate is capped to the plan rate
		frappe.db.set_value(
			"WhatsApp Settings", "WhatsApp Settings", "messages_per_minute", 60, update_modified=False
		)
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")

		class Small(FakeProvider):
			def get_account(self):
				info = super().get_account()
				return type(info)(**{**info.__dict__, "messages_per_minute": 30})

		with fake_provider(Small()):
			usage_sync.sync_subscription()
		self.assertEqual(frappe.db.get_single_value("WhatsApp Settings", "messages_per_minute"), 30)
		ensure_settings(messages_per_minute=20, plan_messages_per_minute=0)
		with (
			fake_provider(),
			patch.object(
				FakeProvider,
				"get_account",
				side_effect=__import__(
					"whatsapp_next.providers.exceptions", fromlist=["TransientError"]
				).TransientError("down"),
			),
		):
			self.assertIsNone(usage_sync.sync_subscription())

	def test_retention_purge(self):
		old = add_days(now_datetime(), -400)
		with status_writer():
			log = frappe.get_doc(
				{
					"doctype": "WhatsApp Log",
					"device": self.device,
					"recipient_type": "Individual",
					"phone": "+966500000082",
					"message_type": "Text",
					"body": "retention-test",
					"status": "Sent",
					"source_type": "API",
				}
			).insert(ignore_permissions=True)
			keep = frappe.get_doc(
				{
					"doctype": "WhatsApp Log",
					"device": self.device,
					"recipient_type": "Individual",
					"phone": "+966500000083",
					"message_type": "Text",
					"body": "retention-test keep",
					"status": "Queued",
					"source_type": "API",
				}
			).insert(ignore_permissions=True)
			item = frappe.get_doc(
				{
					"doctype": "WhatsApp Queue Item",
					"outbound_message": log.name,
					"device": self.device,
					"status": "Completed",
					"phone_e164": "+966500000082",
				}
			).insert(ignore_permissions=True)
			ev = frappe.get_doc(
				{
					"doctype": "WhatsApp Webhook Event",
					"event_id": "ret-1",
					"event_name": "message.sent",
					"status": "Processed",
					"payload": "{}",
					"received_at": add_days(now_datetime(), -2),
				}
			).insert(ignore_permissions=True)
		for dt, name in (("WhatsApp Log", log.name), ("WhatsApp Log", keep.name)):
			frappe.db.set_value(dt, name, "creation", old, update_modified=False)
		frappe.db.set_value("WhatsApp Queue Item", item.name, "modified", old, update_modified=False)
		ensure_settings(
			outbound_retention_days=365,
			queue_retention_days=7,
			webhook_event_retention_days=30,
			inbound_retention_days=0,
			audit_retention_days=365,
		)
		report = retention.purge(commit=False)
		self.assertEqual(report.payloads_blanked, 1)
		self.assertIsNone(frappe.db.get_value("WhatsApp Webhook Event", ev.name, "payload"))
		self.assertEqual(report.deleted["WhatsApp Queue Item"], 1)
		self.assertEqual(report.deleted["WhatsApp Log"], 1)
		self.assertIn("WhatsApp Inbound Message", report.skipped)  # 0 = never
		self.assertFalse(frappe.db.exists("WhatsApp Log", log.name))
		self.assertTrue(frappe.db.exists("WhatsApp Log", keep.name))  # non-terminal rows are never purged
		self.assertEqual(frappe.db.count("WhatsApp Audit Log", {"action": "Retention Purge"}), 2)
		self.assertEqual(retention.purge_table("WhatsApp Log", 0, "creation"), 0)
		delete_all("WhatsApp Log", {"body": ("like", "retention-test%")})
		delete_all("WhatsApp Webhook Event", {"event_id": "ret-1"})
		ensure_settings(inbound_retention_days=365)
