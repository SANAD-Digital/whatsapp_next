# Tests for services/devices.py (build order B-11): create through the provider, pairing cache
# (60 s, never persisted), status machine + audit + realtime, connection webhooks, disconnect,
# delete guards, default / disabled rules, provider sync.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_to_date, now_datetime

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
		# the site's own default device: these tests move the flag and empty Settings' field, and the
		# site's real device must come back as it was (it was left unflagged and Settings empty)
		cls._site_default = frappe.db.get_single_value("WhatsApp Settings", "default_device", cache=False)
		cls._site_flagged = frappe.get_all("WhatsApp Device", filters={"is_default": 1}, pluck="name")
		ensure_settings()

	@classmethod
	def tearDownClass(cls):
		frappe.db.set_value("WhatsApp Device", {"name": ("in", cls._site_flagged or [""])}, "is_default", 1, update_modified=False)
		frappe.db.set_single_value("WhatsApp Settings", "default_device", cls._site_default, update_modified=False)
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
		frappe.db.commit()
		super().tearDownClass()

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

	def test_a_device_added_for_qr_pairs_with_a_code_once_it_has_a_number(self):
		with fake_provider() as fp:
			name = devices.create(NAME, pairing_mode="QR")  # no number
			with self.assertRaises(WAValidationError):
				devices.start_pairing(name, "Code")  # a code needs a number to go to
			self.assertFalse([c for c in fp.calls if c[0] == "get_pair_code"])
			code = devices.start_pairing(name, "Code", phone="0500000402")
			self.assertEqual(code.pair_code, "ABCD-1234")
			# the number is stored on the device (and on the provider, which issued the code for it)
			self.assertEqual(frappe.db.get_value("WhatsApp Device", name, "phone_e164"), "+966500000402")
			# after that the code comes without asking again
			self.assertEqual(devices.start_pairing(name, "Code").pair_code, "ABCD-1234")

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
			# served from cache, with the seconds actually left
			key = devices.PAIR_CACHE_KEY.format(platform_device=row.platform_device)
			aged = {**frappe.cache.get_value(key), "cached_at": add_to_date(now_datetime(), seconds=-45).isoformat()}
			frappe.cache.set_value(key, aged, expires_in_sec=devices.PAIR_CACHE_TTL)
			again = devices.start_pairing(name, "QR")
			self.assertEqual(len([c for c in fp.calls if c[0] == "get_qr"]), 1)
			self.assertTrue(10 <= again.expires_in <= 15, again.expires_in)
			self.assertEqual(again.qr_code, payload.qr_code)
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

	def test_a_link_by_another_number_reads_as_unlinked(self):
		# the platform unlinked a WhatsApp account that is not the device's number (owner, 2026-10-20)
		with fake_provider():
			name = devices.create(NAME, phone="+967777667663")
			pd = frappe.db.get_value("WhatsApp Device", name, "platform_device")
		self.assertEqual(
			devices.wrong_number_info("wrong_number: linked with 967770788938, registered for 967777667663; unlinked"),
			{"connected": "+967770788938", "expected": "+967777667663"},
		)
		self.assertIsNone(devices.wrong_number_info("connection.logged_out webhook"))
		change = devices.apply_connection_event(
			WebhookEvent(
				event_id="e-wrong", event_name="connection.logged_out", platform_device=pd, reason="wrong_number",
				raw={"reason": "wrong_number", "expected_number": "967777667663", "connected_number": "967770788938"},
				device=DeviceState(platform_device=pd, phone_e164="+967770788938"),
			)
		)
		self.assertEqual(change.wrong_number, {"connected": "+967770788938", "expected": "+967777667663"})
		st = self._status(name)
		self.assertEqual(st.status, "Logged Out")
		self.assertIn("+967770788938", st.last_error)
		# the number of the device stays its own, never the one that scanned
		self.assertEqual(frappe.db.get_value("WhatsApp Device", name, "phone_e164"), "+967777667663")

	def test_default_device_when_settings_lost_it(self):
		"""Live E2E 2026-09-30: the only device was flagged `is_default` but Settings → Default
		Device was empty, so every sender reading Settings found no device (the composer
		preselected nothing, a bulk send without a device was refused)."""
		from whatsapp_next.services import quick_send

		with fake_provider():
			a = devices.create(NAME + " A", phone="+966500000405")
			b = devices.create(NAME + " B", phone="+966500000406")
		# the drifted state: the flag without Settings
		frappe.db.set_value("WhatsApp Device", {"name": ("!=", a)}, "is_default", 0)
		frappe.db.set_value("WhatsApp Device", a, "is_default", 1)
		frappe.db.set_single_value("WhatsApp Settings", "default_device", None)
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
		self.assertEqual(devices.default_device(), a)
		self.assertEqual(quick_send.get_context()["default_device"], a)
		# Settings naming a disabled device does not win over the flag
		frappe.db.set_value("WhatsApp Device", b, "disabled", 1)
		frappe.db.set_single_value("WhatsApp Settings", "default_device", b)
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
		self.assertEqual(devices.default_device(), a)
		frappe.db.set_value("WhatsApp Device", b, "disabled", 0)
		# flagging a device through its document writes Settings too
		doc = frappe.get_doc("WhatsApp Device", b)
		doc.is_default = 1
		doc.save(ignore_permissions=True)
		self.assertEqual(frappe.db.get_single_value("WhatsApp Settings", "default_device"), b)
		self.assertEqual(frappe.db.get_value("WhatsApp Device", a, "is_default"), 0)
		self.assertEqual(devices.default_device(), b)

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
			# rows pointing at the device: history keeps a dangling link, configuration is released
			number = frappe.get_doc(
				{
					"doctype": "WhatsApp Number",
					"phone_e164": "+966500000499",
					"number_type": "Individual",
					"last_device": a,
				}
			)
			number.insert(ignore_permissions=True)
			notification = frappe.get_doc(
				{
					"doctype": "WhatsApp Notification",
					"notification_name": "DevTest Notification",
					"document_type": "ToDo",
					"event": "New",
					"device": a,
					"message": "x",
					"recipients": [{"recipient_type": "Fixed Number", "phone": "+966500000498"}],
				}
			).insert(ignore_permissions=True)
			devices.delete(a, delete_remote=True)
			self.assertFalse(frappe.db.exists("WhatsApp Device", a))
			self.assertEqual(frappe.db.get_value("WhatsApp Number", number.name, "last_device"), a)
			self.assertIsNone(frappe.db.get_value("WhatsApp Notification", notification.name, "device"))
			frappe.delete_doc("WhatsApp Notification", notification.name, ignore_permissions=True, force=True)
			frappe.delete_doc("WhatsApp Number", number.name, ignore_permissions=True, force=True)
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
