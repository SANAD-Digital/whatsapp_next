# Tests for api/v1/devices.py (build order B-19): role gates, create / pair / poll / disconnect /
# update / default / disable / delete through the FakeProvider, and device stats.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import devices as api
from whatsapp_next.exceptions import (
	WAInvalidPhoneError,
	WANotFoundError,
	WAPermissionError,
	WAStateConflictError,
	WAValidationError,
)
from whatsapp_next.tests.conftest_frappe import (
	as_user,
	delete_all,
	ensure_device,
	ensure_settings,
	fake_provider,
)

NAME = "ApiTest Device"
PHONE = "+966500910201"


class TestApiDevices(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.anchor = ensure_device()  # a device that stays default while ours come and go
		ensure_settings(default_device=cls.anchor)
		cls._prev_default = frappe.db.get_value("WhatsApp Device", {"is_default": 1}, "name")

	def setUp(self):
		self._clean()

	def tearDown(self):
		self._clean()

	@classmethod
	def tearDownClass(cls):
		if cls._prev_default and frappe.db.exists("WhatsApp Device", cls._prev_default):
			from whatsapp_next.services import devices

			devices.set_default(cls._prev_default)
		super().tearDownClass()

	@staticmethod
	def _clean():
		for name in frappe.get_all("WhatsApp Device", {"device_name": ("like", "ApiTest%")}, pluck="name"):
			delete_all("WhatsApp Audit Log", {"reference_doctype": "WhatsApp Device", "reference_name": name})
		delete_all("WhatsApp Device", {"device_name": ("like", "ApiTest%")})

	def _create(self, provider, **kw):
		with as_user("WhatsApp Manager"):
			return api.create_device(device_name=NAME, phone=PHONE, **kw)

	def test_role_gates(self):
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.list_devices()
		with as_user("WhatsApp Viewer"):
			self.assertIn("rows", api.list_devices())
		with fake_provider(), as_user("WhatsApp Agent"), self.assertRaises(WAPermissionError):
			api.create_device(device_name=NAME)

	def test_lifecycle(self):
		with fake_provider() as p:
			created = self._create(p)
			self.assertEqual(created["status"], "Pending QR")
			name = created["name"]
			self.assertTrue(
				frappe.db.exists("WhatsApp Audit Log", {"action": "Device Created", "reference_name": name})
			)
			with as_user("WhatsApp Manager"):
				with self.assertRaises(WAValidationError):
					api.create_device(device_name=NAME + " 2", pairing_mode="Bluetooth")
				with self.assertRaises(WAInvalidPhoneError):
					api.create_device(device_name=NAME + " 2", phone="12", pairing_mode="Code")
				pairing = api.start_pairing(device=name, mode="QR")
				self.assertEqual(pairing["mode"], "QR")
				self.assertTrue(pairing["qr_code"].startswith("data:image"))
				self.assertIsNotNone(pairing["expires_at"])
				code = api.start_pairing(device=name, mode="Code")
				self.assertEqual(code["pair_code"], "ABCD-1234")
				with self.assertRaises(WAValidationError):
					api.start_pairing(device=name, mode="NFC")
				with self.assertRaises(WANotFoundError):
					api.start_pairing(device="WA-DEV-NOPE")
			p.set_device_status(created["platform_device"], "Connected")
			with as_user("WhatsApp Agent"):
				polled = api.poll_status(device=name)
			self.assertEqual(polled, {"status": "Connected", "changed": True, "previous": "Pending QR"})
			with as_user("WhatsApp Manager"):
				self.assertEqual(api.disconnect_device(device=name), {"status": "Logged Out"})
				row = api.update_device(device=name, device_name=NAME + " Renamed")
				self.assertEqual(row["device_name"], NAME + " Renamed")
				listed = api.list_devices(refresh=True)
				self.assertIn(name, [r["name"] for r in listed["rows"]])
				self.assertEqual(listed["synced"]["seen"], 1)
				self.assertEqual(api.delete_device(device=name), {"deleted": name})
			self.assertFalse(frappe.db.exists("WhatsApp Device", name))
			self.assertTrue(
				frappe.db.exists("WhatsApp Audit Log", {"action": "Device Deleted", "reference_name": name})
			)

	def test_default_and_disabled(self):
		with fake_provider() as p:
			name = self._create(p)["name"]
			with as_user("WhatsApp Manager"):
				self.assertEqual(api.set_disabled(device=name, disabled="1"), {"ok": True})
				self.assertEqual(frappe.db.get_value("WhatsApp Device", name, "disabled"), 1)
				with self.assertRaises(WAStateConflictError):
					api.set_default(device=name)
				api.set_disabled(device=name, disabled=False)
				self.assertEqual(api.set_default(device=name), {"ok": True})
				self.assertEqual(frappe.db.get_single_value("WhatsApp Settings", "default_device"), name)
				with self.assertRaises(WAStateConflictError):
					api.delete_device(device=name)  # default with others present
				api.set_default(device=self.anchor)
				api.delete_device(device=name)

	def test_device_stats(self):
		with as_user("WhatsApp Viewer"):
			out = api.get_device_stats(device=self.anchor, days="7")
			self.assertEqual(out["days"], 7)
			for key in ("sent", "failed", "fail_rate", "outbound", "inbound"):
				self.assertIn(key, out)
			with self.assertRaises(WAValidationError):
				api.get_device_stats(device=self.anchor, days=0)
