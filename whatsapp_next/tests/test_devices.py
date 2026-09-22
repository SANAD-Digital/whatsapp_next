# Tests for services/devices.py (build order B-11): create through the provider, pairing cache
# (60 s, never persisted), status machine + audit + realtime, connection webhooks, disconnect,
# delete guards, default / disabled rules, provider sync.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import (
	WAInvalidPhoneError,
	WANotFoundError,
	WAStateConflictError,
	WAValidationError,
)
from whatsapp_next.providers.schemas import DeviceState, WebhookEvent
from whatsapp_next.services import devices
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_settings, fake_provider

NAME = "DevTest Phone"


class TestDevices(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_settings()

	def setUp(self):
		self._clean()

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all(
			"WhatsApp Audit Log", {"reference_doctype": "WhatsApp Device", "reference_name": ("like", "%")}
		)
		delete_all("WhatsApp Device", {"device_name": ("like", "DevTest%")})
		delete_all(
			"WhatsApp Audit Log",
			{
				"action": (
					"in",
					["Device Created", "Device Deleted", "Device Connected", "Device Disconnected"],
				)
			},
		)

	def _status(self, name):
		return frappe.db.get_value(
			"WhatsApp Device",
			name,
			[
				"status",
				"connected_at",
				"disconnected_at",
				"logged_out_at",
				"last_error",
				"wa_device_id",
				"webhook_registered",
			],
			as_dict=True,
		)

	def test_create_and_pair_qr(self):
		with fake_provider() as fp:
			with self.assertRaises(WAInvalidPhoneError):
				devices.create(NAME, phone="abc")
			with self.assertRaises(WAInvalidPhoneError):
				devices.create(NAME, pairing_mode="Code")  # code needs a phone
			with self.assertRaises(WAValidationError):
				devices.create(NAME, pairing_mode="Bluetooth")
			name = devices.create(NAME, phone="0500000401", pairing_mode="QR")
			row = frappe.db.get_value(
				"WhatsApp Device",
				name,
				["status", "platform_device", "phone_e164", "wa_device_id"],
				as_dict=True,
			)
			self.assertEqual((row.status, row.phone_e164), ("Pending QR", "+966500000401"))
			self.assertTrue(row.platform_device.startswith("WAD-") and row.wa_device_id.startswith("wa-"))
			self.assertEqual(
				frappe.db.count("WhatsApp Audit Log", {"action": "Device Created", "reference_name": name}), 1
			)

			payload = devices.start_pairing(name, "QR")
			self.assertEqual((payload.mode, payload.qr_code[:10]), ("QR", "data:image"))
			calls = [c[0] for c in fp.calls if c[0] == "get_qr"]
			self.assertEqual(len(calls), 1)
			devices.start_pairing(name, "QR")  # served from cache
			self.assertEqual(len([c for c in fp.calls if c[0] == "get_qr"]), 1)
			code = devices.start_pairing(name, "Code")
			self.assertEqual(code.pair_code, "ABCD-1234")
			# nothing persisted
			self.assertNotIn("qr", " ".join(frappe.get_meta("WhatsApp Device").get_valid_columns()).lower())
			cached = frappe.cache.get_value(
				devices.PAIR_CACHE_KEY.format(platform_device=row.platform_device)
			)
			self.assertEqual(cached["mode"], "Code")

			# poll → provider says Connected → cache cleared, audit + timestamps
			fp.set_device_status(row.platform_device, "Connected")
			change = devices.poll(name)
			self.assertEqual(
				(change.previous, change.status, change.changed), ("Pending QR", "Connected", True)
			)
			st = self._status(name)
			self.assertIsNotNone(st.connected_at)
			self.assertIsNone(
				frappe.cache.get_value(devices.PAIR_CACHE_KEY.format(platform_device=row.platform_device))
			)
			self.assertEqual(
				frappe.db.count("WhatsApp Audit Log", {"action": "Device Connected", "reference_name": name}),
				1,
			)
			with self.assertRaises(WAStateConflictError):
				devices.start_pairing(name, "QR")
			# same-status poll is a no-op
			self.assertFalse(devices.poll(name).changed)

	def test_connection_events_and_machine(self):
		with fake_provider():
			name = devices.create(NAME, phone="+966500000402")
			pd = frappe.db.get_value("WhatsApp Device", name, "platform_device")

		def ev(ename, **kw):
			return WebhookEvent(event_id=f"e-{ename}", event_name=ename, platform_device=pd, **kw)

		self.assertTrue(
			devices.apply_connection_event(
				ev(
					"connection.connected",
					device=DeviceState(platform_device=pd, wa_device_id="wa-new", webhook_registered=True),
				)
			).changed
		)
		st = self._status(name)
		self.assertEqual((st.status, st.wa_device_id, st.webhook_registered), ("Connected", "wa-new", 1))
		self.assertTrue(
			devices.apply_connection_event(ev("connection.disconnected", reason="network")).changed
		)
		st = self._status(name)
		self.assertEqual((st.status, st.last_error), ("Disconnected", "network"))
		self.assertIsNotNone(st.disconnected_at)
		self.assertTrue(devices.apply_connection_event(ev("connection.logged_out")).changed)
		self.assertEqual(self._status(name).status, "Logged Out")
		self.assertIsNone(devices.apply_connection_event(ev("message.sent")))
		self.assertIsNone(
			devices.apply_connection_event(
				WebhookEvent(event_id="x", event_name="connection.connected", platform_device="WAD-unknown")
			)
		)
		self.assertEqual(frappe.db.count("WhatsApp Device", {"platform_device": "WAD-unknown"}), 0)
		with self.assertRaises(WAValidationError):
			devices.apply_state(name, "Sleeping", source="test")
		with self.assertRaises(WANotFoundError):
			devices.apply_state("no-such-device", "Connected", source="test")
		# an unexpected transition is applied but logged
		devices.apply_state(name, "Pending QR", source="test")
		before = frappe.db.count("Error Log", {"method": ("like", "%unexpected transition%")})
		devices.apply_state(name, "Connected", source="test")
		devices.apply_state(name, "Pending QR", source="test")  # Connected → Pending QR is not in the machine
		self.assertEqual(
			frappe.db.count("Error Log", {"method": ("like", "%unexpected transition%")}), before + 1
		)

	def test_disconnect_delete_default_disabled(self):
		with fake_provider() as fp:
			a = devices.create(NAME + " A", phone="+966500000403")
			b = devices.create(NAME + " B", phone="+966500000404")
			pd_a = frappe.db.get_value("WhatsApp Device", a, "platform_device")
			fp.set_device_status(pd_a, "Connected")
			devices.poll(a)
			change = devices.disconnect(a)
			self.assertEqual((change.status, change.changed), ("Logged Out", True))
			self.assertEqual(
				frappe.db.count("WhatsApp Audit Log", {"action": "Device Disconnected", "reference_name": a}),
				1,
			)
			# re-pair after logout → Pending QR
			devices.start_pairing(a, "QR")
			self.assertEqual(self._status(a).status, "Pending QR")

			# defaults: the default device cannot be deleted / disabled while others exist
			devices.set_default(a)
			self.assertEqual(frappe.db.get_value("WhatsApp Device", a, "is_default"), 1)
			with self.assertRaises(WAStateConflictError):
				devices.delete(a)
			with self.assertRaises(WAStateConflictError):
				devices.set_disabled(a, True)
			devices.set_default(b)
			self.assertEqual(frappe.db.get_value("WhatsApp Device", a, "is_default"), 0)
			self.assertEqual(frappe.db.get_single_value("WhatsApp Settings", "default_device"), b)
			devices.set_disabled(a, True)
			self.assertEqual(frappe.db.get_value("WhatsApp Device", a, "disabled"), 1)
			with self.assertRaises(WAStateConflictError):
				devices.start_pairing(a, "QR")
			with self.assertRaises(WAStateConflictError):
				devices.set_default(a)
			devices.set_disabled(a, False)
			devices.delete(a, delete_remote=True)
			self.assertFalse(frappe.db.exists("WhatsApp Device", a))
			self.assertNotIn(pd_a, fp.devices)
			self.assertEqual(
				frappe.db.count("WhatsApp Audit Log", {"action": "Device Deleted", "reference_name": a}), 1
			)
			with self.assertRaises(WANotFoundError):
				devices.delete(a)
			ensure_settings(default_device=None)

	def test_sync_from_provider_and_unregistered(self):
		with fake_provider() as fp:
			a = devices.create(NAME + " S", phone="+966500000405")
			pd = frappe.db.get_value("WhatsApp Device", a, "platform_device")
			fp.set_device_status(pd, "Connected")
			fp.create_device("DevTest foreign", None, "QR")  # exists only on the platform
			counts = devices.sync_from_provider()
			self.assertEqual(counts, {"seen": 1, "changed": 1, "unknown": 1})
			self.assertEqual(self._status(a).status, "Connected")
			self.assertEqual(frappe.db.count("WhatsApp Device", {"device_name": "DevTest foreign"}), 0)
			self.assertEqual(devices.sync_from_provider()["changed"], 0)
