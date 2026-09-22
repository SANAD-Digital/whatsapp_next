# Contract test every provider must pass (backend-plan §2.3): all abstract methods implemented,
# webhook fixtures parse to canonical events, signature checks, batch size guard, health never raises.

from __future__ import annotations

import inspect
import json
import os
import time

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.providers import exceptions as pex
from whatsapp_next.providers.base import MAX_BATCH, BaseProvider
from whatsapp_next.providers.meta_cloud import MetaCloudProvider
from whatsapp_next.providers.schemas import CANONICAL_EVENTS, NormalizedMessage, ProviderSettings
from whatsapp_next.providers.snd_platform import SndPlatformProvider
from whatsapp_next.tests.fake_provider import FakeProvider, signed_headers

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "webhooks")
PLATFORM_FIXTURES = [
	f for f in sorted(os.listdir(FIXTURES)) if f.endswith(".json") and not f.startswith("meta_")
]


def _settings(key: str) -> ProviderSettings:
	return ProviderSettings(
		provider_key=key,
		base_url="https://platform.invalid",
		timeout=5,
		credentials={"customer_api_key": "ck", "api_key": "k", "api_secret": "s"},
	)


class TestProviderContract(IntegrationTestCase):
	providers = (
		SndPlatformProvider(_settings("snd_platform")),
		MetaCloudProvider(_settings("meta_cloud")),
		FakeProvider(),
	)

	def test_every_abstract_method_implemented(self):
		abstract = {
			name
			for name, _ in inspect.getmembers(BaseProvider, predicate=inspect.isfunction)
			if getattr(getattr(BaseProvider, name), "__isabstractmethod__", False)
		}
		self.assertTrue(abstract)
		for provider in self.providers:
			with self.subTest(provider=provider.key):
				for name in abstract:
					method = getattr(type(provider), name, None)
					self.assertIsNotNone(method, name)
					self.assertFalse(
						getattr(method, "__isabstractmethod__", False),
						f"{provider.key}.{name} not implemented",
					)
				self.assertTrue(provider.key and provider.display_name)

	def test_registry_hook_lists_the_two_real_providers(self):
		from whatsapp_next.providers.registry import provider_classes

		hooks = provider_classes()
		self.assertEqual(frappe.get_attr(hooks["snd_platform"]), SndPlatformProvider)
		self.assertEqual(frappe.get_attr(hooks["meta_cloud"]), MetaCloudProvider)

	def test_platform_fixtures_parse_to_canonical_events(self):
		provider = self.providers[0]
		for filename in PLATFORM_FIXTURES:
			with (
				self.subTest(fixture=filename),
				open(os.path.join(FIXTURES, filename), encoding="utf-8") as fh,
			):
				body = json.load(fh)
			headers = {
				"X-SND-Event": body["event"],
				"X-SND-Event-ID": body["event_id"],
				"X-SND-Timestamp": "1790000000",
				"X-SND-Signature": "x",
			}
			event = provider.parse_webhook(headers, body)
			self.assertEqual(event.event_id, body["event_id"])
			self.assertEqual(event.event_name, body["event"])
			if filename.startswith("unknown"):
				self.assertFalse(event.is_known)
			else:
				self.assertIn(event.event_name, CANONICAL_EVENTS)
			self.assertIs(event.raw, body)

	def test_platform_inbound_fields(self):
		provider = self.providers[0]
		with open(os.path.join(FIXTURES, "message.received.json"), encoding="utf-8") as fh:
			body = json.load(fh)
		event = provider.parse_webhook(
			{"X-SND-Event": "message.received", "X-SND-Event-ID": body["event_id"]}, body
		)
		self.assertIsNotNone(event.inbound)
		self.assertEqual(event.inbound.sender_phone, "966500000002")
		self.assertEqual(event.inbound.body, "كشف حساب")
		self.assertEqual(event.inbound.message_type, "Text")
		self.assertFalse(event.inbound.is_group)
		self.assertEqual(event.platform_device, "WAD-00001")
		with open(os.path.join(FIXTURES, "message.received.group.json"), encoding="utf-8") as fh:
			group = provider.parse_webhook({}, json.load(fh))
		self.assertTrue(group.inbound.is_group)
		with open(os.path.join(FIXTURES, "message.received.lid.json"), encoding="utf-8") as fh:
			lid = provider.parse_webhook({}, json.load(fh))
		self.assertIsNone(lid.inbound.sender_phone)
		self.assertTrue(lid.inbound.sender_jid.endswith("@lid"))
		self.assertEqual(lid.inbound.message_type, "Image")
		with open(os.path.join(FIXTURES, "message.held.json"), encoding="utf-8") as fh:
			held = provider.parse_webhook({}, json.load(fh))
		self.assertEqual(held.status, "Held")
		self.assertEqual(held.client_ref, "c3d4e5f6a7")
		self.assertEqual(held.reason, "Plan quota exhausted")
		with open(os.path.join(FIXTURES, "connection.disconnected.json"), encoding="utf-8") as fh:
			conn = provider.parse_webhook({}, json.load(fh))
		self.assertEqual(conn.device.status, "Logged Out")
		self.assertEqual(conn.device.phone_e164, "+966500000001")

	def test_signature_check(self):
		secret = "s3cret"
		raw = b'{"event":"test.webhook","event_id":"evt_test"}'
		for provider in (self.providers[0], self.providers[2]):
			with self.subTest(provider=provider.key):
				good = provider.verify_webhook(
					signed_headers(secret, "test.webhook", "evt_test", raw), raw, secret
				)
				self.assertTrue(good.valid and good.fresh)
				bad = provider.verify_webhook(
					signed_headers("other", "test.webhook", "evt_test", raw), raw, secret
				)
				self.assertFalse(bad.valid)
				stale = provider.verify_webhook(
					signed_headers(
						secret, "test.webhook", "evt_test", raw, timestamp=int(time.time()) - 3600
					),
					raw,
					secret,
				)
				self.assertTrue(stale.valid)
				self.assertFalse(stale.fresh)
				self.assertEqual(stale.reason, "stale")
				missing = provider.verify_webhook({}, raw, secret)
				self.assertFalse(missing.valid)

	def test_batch_size_guard_before_io(self):
		msg = NormalizedMessage(client_ref="r", platform_device="d", phone_e164="+966500000002", body="x")
		for provider in (self.providers[0], self.providers[2]):
			with self.subTest(provider=provider.key), self.assertRaises(pex.ValidationError):
				provider.send_batch([msg] * (MAX_BATCH + 1), "b")
		with self.assertRaises(pex.ValidationError):
			self.providers[0].send_batch([], "b")

	def test_health_check_never_raises(self):
		for provider in self.providers:
			with self.subTest(provider=provider.key):
				result = provider.health_check()
				self.assertIsInstance(result.ok, bool)

	def test_meta_skeleton(self):
		meta = self.providers[1]
		with self.assertRaises(pex.NotSupportedError):
			meta.get_qr("x")
		with self.assertRaises(NotImplementedError):
			meta.list_devices()
		with open(os.path.join(FIXTURES, "meta_message_received.json"), encoding="utf-8") as fh:
			event = meta.parse_webhook({}, json.load(fh))
		self.assertEqual(event.event_name, "message.received")
		self.assertEqual(event.inbound.sender_phone, "+966500000002")
		self.assertEqual(event.inbound.body, "hello")
		with open(os.path.join(FIXTURES, "meta_message_delivered.json"), encoding="utf-8") as fh:
			status = meta.parse_webhook({}, json.load(fh))
		self.assertEqual(status.event_name, "message.delivered")
		self.assertEqual(status.client_ref, "a1b2c3d4e5")
		import hashlib
		import hmac

		raw = b"{}"
		sig = "sha256=" + hmac.new(b"app", raw, hashlib.sha256).hexdigest()
		self.assertTrue(meta.verify_webhook({"X-Hub-Signature-256": sig}, raw, "app").valid)
		self.assertFalse(meta.verify_webhook({"X-Hub-Signature-256": "sha256=00"}, raw, "app").valid)
