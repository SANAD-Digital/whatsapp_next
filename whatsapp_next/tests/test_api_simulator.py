# Tests for api/v1/simulator.py (build order B-23): role gates, page context, "message on
# behalf" persisted as is_simulated rows (never sent), the test send job and the shared dry-run
# helper (nothing persisted).

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import simulator as api
from whatsapp_next.exceptions import WAInvalidPhoneError, WAPermissionError, WAValidationError
from whatsapp_next.services import command_router as cr
from whatsapp_next.services import functions_catalog as fc
from whatsapp_next.services import simulator
from whatsapp_next.tests.conftest_frappe import as_user, delete_all, ensure_device, ensure_settings

SERVICE_USER = "wa-test-apisvc@example.com"
CODE = "apitestping"
P1 = "+966500920301"
TAG = "ApiTest sim"
SETTINGS_KEYS = ("enable_commands", "command_service_user", "unknown_command_reply", "send_receipt_reply")


def _service_user() -> str:
	if not frappe.db.exists("User", SERVICE_USER):
		u = frappe.get_doc(
			{
				"doctype": "User",
				"email": SERVICE_USER,
				"first_name": "ApiTest Svc",
				"user_type": "System User",
				"enabled": 1,
				"send_welcome_email": 0,
			}
		)
		u.flags.no_welcome_mail = True
		u.insert(ignore_permissions=True)
		frappe.db.delete("Has Role", {"parent": SERVICE_USER, "parenttype": "User"})
	frappe.clear_cache(user=SERVICE_USER)
	return SERVICE_USER


class TestApiSimulator(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("ApiTest Device SIM", "WAD-TEST-API23", phone="+966500920003")
		settings = frappe.get_single("WhatsApp Settings")
		cls.previous = {k: settings.get(k) for k in SETTINGS_KEYS}
		ensure_settings(
			default_device=cls.device,
			enable_commands=1,
			command_service_user=_service_user(),
			unknown_command_reply="ApiTest unknown",
			send_receipt_reply=0,
		)
		cls.installed_ping = False
		if not frappe.db.exists("WhatsApp Function", "ping"):
			fc.clear_cache()
			fc.install("ping")
			cls.installed_ping = True
		cls._clean()
		frappe.get_doc(
			{
				"doctype": "WhatsApp Command",
				"code": CODE,
				"function": "ping",
				"status": "Active",
				"title": TAG,
				"requires_linked_contact": 0,
			}
		).insert(ignore_permissions=True)
		cr.clear_map()

	@classmethod
	def tearDownClass(cls):
		cls._clean()
		if cls.installed_ping:
			delete_all("WhatsApp Function", {"name": "ping"})
		ensure_settings(**cls.previous)
		cr.clear_map()
		super().tearDownClass()

	@classmethod
	def _clean(cls):
		names = frappe.get_all("WhatsApp Log", filters={"body": ("like", f"{TAG}%")}, pluck="name")
		if names:
			delete_all("WhatsApp Queue Item", {"outbound_message": ("in", names)})
			delete_all("WhatsApp Log", {"name": ("in", names)})
		inbound = frappe.get_all(
			"WhatsApp Inbound Message", filters={"body": ("like", f"%{TAG}%")}, pluck="name"
		)
		if inbound:
			delete_all("WhatsApp Log", {"trigger_inbound": ("in", inbound)})
			delete_all("WhatsApp Inbound Message", {"name": ("in", inbound)})
		delete_all("WhatsApp Command", {"code": CODE})
		delete_all("WhatsApp Audit Log", {"action": "Test Send", "reference_name": ("in", names or ["-"])})

	def setUp(self):
		ensure_settings(enable_commands=1, send_receipt_reply=0)
		cr.clear_map()

	def test_role_gates(self):
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.get_context()
		with as_user("WhatsApp Viewer"), self.assertRaises(WAPermissionError):
			api.simulate_inbound(device=self.device, sender_phone=P1, text="#x")
		with as_user("WhatsApp Agent"):
			self.assertIn("commands", api.get_context())
			with self.assertRaises(WAPermissionError):
				api.dry_run_command(text="#x", sender_phone=P1)
		with as_user("WhatsApp Manager"):
			self.assertIn("matched", api.dry_run_command(text="#x", sender_phone=P1))

	def test_get_context(self):
		with as_user("WhatsApp Agent"):
			ctx = api.get_context()
		self.assertEqual(
			set(ctx), {"devices", "default_device", "commands", "commands_enabled", "sample_contacts"}
		)
		self.assertIn(self.device, [d["name"] for d in ctx["devices"]])
		self.assertIn(CODE, [c["name"] for c in ctx["commands"]])
		self.assertTrue(ctx["commands_enabled"])
		self.assertTrue(all("@" not in (c["phone_e164"] or "") for c in ctx["sample_contacts"]))

	def test_simulate_inbound_persists_simulated_rows(self):
		with as_user("WhatsApp Agent"):
			res = api.simulate_inbound(
				device=self.device, sender_phone="0500920301", text=f"#{CODE} {TAG} hi"
			)
		self.assertEqual(
			(res["command_status"], res["command"], res["block_reason"]), ("Executed", CODE, None)
		)
		self.assertTrue(res["reply_body"].startswith("pong:"))
		inb = frappe.db.get_value(
			"WhatsApp Inbound Message",
			res["inbound"],
			["is_simulated", "phone_e164", "command_status", "reply_outbound"],
			as_dict=True,
		)
		self.assertEqual((inb.is_simulated, inb.phone_e164, inb.command_status), (1, P1, "Executed"))
		self.assertEqual(inb.reply_outbound, res["reply_outbound"])
		out = frappe.db.get_value(
			"WhatsApp Log", res["reply_outbound"], ["is_simulated", "status", "source_type"], as_dict=True
		)
		self.assertEqual((out.is_simulated, out.status, out.source_type), (1, "Unsent", "Command Reply"))
		self.assertEqual(
			frappe.db.count("WhatsApp Queue Item", {"outbound_message": res["reply_outbound"]}), 0
		)
		# plain message: stored, not routed
		with as_user("WhatsApp Agent"):
			res = api.simulate_inbound(
				device=self.device, sender_phone=P1, text=f"{TAG} plain", run_commands="0"
			)
		self.assertEqual(
			(res["command_status"], res["reply_outbound"], res["reply_body"]), ("None", None, None)
		)
		self.assertEqual(
			frappe.db.get_value("WhatsApp Inbound Message", res["inbound"], "command_status"), "None"
		)
		with as_user("WhatsApp Agent"):
			with self.assertRaises(WAInvalidPhoneError):
				api.simulate_inbound(device=self.device, sender_phone="abc", text=f"{TAG} x")
			with self.assertRaises(WAValidationError):
				api.simulate_inbound(device=self.device, sender_phone=P1, text="  ")

	def test_send_test(self):
		with as_user("WhatsApp Agent"), patch.object(frappe, "enqueue") as enq:
			res = api.send_test(device=self.device, phone="0500920301", body=f"{TAG} test send")
		out = frappe.db.get_value(
			"WhatsApp Log", res["outbound"], ["is_test", "status", "source_type", "phone_e164"], as_dict=True
		)
		self.assertEqual(
			(out.is_test, out.status, out.source_type, out.phone_e164), (1, "Unsent", "Simulator", P1)
		)
		self.assertEqual(enq.call_args.args[0], "whatsapp_next.services.dispatch.send_test_message")
		self.assertEqual(
			frappe.db.count("WhatsApp Audit Log", {"action": "Test Send", "reference_name": res["outbound"]}),
			1,
		)
		with as_user("WhatsApp Agent"):
			with self.assertRaises(WAInvalidPhoneError):
				api.send_test(device=self.device, phone="abc", body=f"{TAG} x")
			with self.assertRaises(WAValidationError):
				api.send_test(device=self.device, phone=P1, body=" ")

	def test_dry_run_command_persists_nothing(self):
		mine = {"body": ("like", f"%{TAG} dry%")}
		with as_user("WhatsApp Manager"):
			res = api.dry_run_command(text=f"#{CODE} {TAG} dry", sender_phone=P1, device=self.device)
			unknown = api.dry_run_command(text=f"#nothing {TAG}", sender_phone=P1)
			with self.assertRaises(WAInvalidPhoneError):
				api.dry_run_command(text="#x", sender_phone="abc")
		self.assertEqual(
			set(res),
			{
				"matched",
				"status",
				"command",
				"block_reason",
				"args",
				"reply_body",
				"replies",
				"error",
				"function_ms",
			},
		)
		self.assertEqual((res["matched"], res["status"], res["command"]), (True, "Executed", CODE))
		self.assertTrue(res["reply_body"].startswith("pong:"))
		self.assertIsInstance(res["function_ms"], int)
		self.assertEqual(
			(unknown["matched"], unknown["status"], unknown["reply_body"]),
			(False, "Not Matched", "ApiTest unknown"),
		)
		self.assertEqual(frappe.db.count("WhatsApp Inbound Message", mine), 0)
		self.assertEqual(
			frappe.db.count("WhatsApp Log", {"source_type": "Command Reply", "body": ("like", "pong:%dry%")}),
			0,
		)
		# the service helper is the single implementation shared with commands.test_command
		self.assertEqual(simulator.dry_run_command(f"#{CODE} x", P1, self.device)["command"], CODE)
