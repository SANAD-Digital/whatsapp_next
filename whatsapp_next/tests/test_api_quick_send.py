# Tests for api/v1/quick_send.py (build order B-20): role gate, composer context, preview and
# the single send (priority 1, warnings, enum / phone validation).

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import quick_send as api
from whatsapp_next.exceptions import WAInvalidPhoneError, WAPermissionError, WAValidationError
from whatsapp_next.tests.conftest_frappe import as_user, delete_all, ensure_device, ensure_settings

P1, P2 = "+966500920101", "+966500920102"
TAG = "ApiTest quick"


class TestApiQuickSend(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("ApiTest Device QS", "WAD-TEST-API21", phone="+966500920001")
		ensure_settings(default_device=cls.device, queue_paused=0, send_only_to_known_numbers=0)

	@classmethod
	def tearDownClass(cls):
		cls._clean()
		super().tearDownClass()

	def setUp(self):
		self._clean()
		ensure_settings(queue_paused=0, send_only_to_known_numbers=0)

	@staticmethod
	def _clean():
		names = frappe.get_all("WhatsApp Log", filters={"body": ("like", f"{TAG}%")}, pluck="name")
		if names:
			delete_all("WhatsApp Queue Item", {"outbound_message": ("in", names)})
			delete_all("WhatsApp Log", {"name": ("in", names)})

	def test_role_gate(self):
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.get_context()
		with as_user("WhatsApp Viewer"), self.assertRaises(WAPermissionError):
			api.preview(body="x")
		with as_user("WhatsApp Agent"):
			self.assertIn("devices", api.get_context())

	def test_get_context(self):
		with as_user("WhatsApp Agent"):
			ctx = api.get_context()
			self.assertIsNone(ctx["recipient"])
			self.assertIn(self.device, [d["name"] for d in ctx["devices"]])
			self.assertEqual(ctx["policy"], {"send_only_to_known_numbers": False})
			self.assertEqual(ctx["default_device"], self.device)
			ctx = api.get_context(phone="0500920101")
			rec = ctx["recipient"]
			self.assertEqual((rec["phone_e164"], rec["blacklisted"]), (P1, False))
			self.assertIn("known", rec)
			with self.assertRaises(WAInvalidPhoneError):
				api.get_context(phone="abc")

	def test_preview(self):
		with as_user("WhatsApp Agent"):
			out = api.preview(body=f"{TAG} {{{{ recipient.display_name }}}}")
			self.assertTrue(out["body"].startswith(TAG))
			self.assertEqual(out["errors"], [])
			self.assertEqual(api.preview(body="{{ x ")["errors"][0][:19], "TemplateSyntaxError")
			self.assertIn("not found", api.preview(template="no-such-ApiTest-template")["errors"][0])

	def test_send(self):
		with as_user("WhatsApp Agent"):
			res = api.send(device=self.device, phone="0500920101", body=f"{TAG} hello")
			log = frappe.db.get_value(
				"WhatsApp Log",
				res["outbound"],
				["status", "phone_e164", "source_type", "queue_item", "attempts", "owner"],
				as_dict=True,
			)
			self.assertEqual(
				(log.status, log.phone_e164, log.source_type, log.queue_item, log.attempts),
				("Queued", P1, "Quick Send", res["queue_item"], 0),
			)
			self.assertEqual(log.owner, frappe.session.user)
			self.assertEqual(frappe.db.get_value("WhatsApp Queue Item", res["queue_item"], "priority"), 1)
			self.assertEqual(res["warnings"], [])
			# warnings are non-blocking: the row is queued anyway
			ensure_settings(queue_paused=1)
			res = api.send(
				device=self.device, phone=P2, body=f"{TAG} paused", scheduled_at="2030-01-01 10:00:00"
			)
			self.assertEqual(res["warnings"], ["queue_paused"])
			self.assertEqual(
				str(frappe.db.get_value("WhatsApp Log", res["outbound"], "scheduled_at")),
				"2030-01-01 10:00:00",
			)
			ensure_settings(queue_paused=0)
			with self.assertRaises(WAInvalidPhoneError):
				api.send(device=self.device, phone="abc", body=f"{TAG} bad")
			with self.assertRaises(WAValidationError):
				api.send(device=self.device, phone=P1, body=f"{TAG} x", message_type="Carrier Pigeon")
			with self.assertRaises(WAValidationError):
				api.send(device=self.device, phone=P1, body="")
			with self.assertRaises(WAValidationError):
				api.send(device=self.device, phone=P1, body=f"{TAG} x", bogus=1)
