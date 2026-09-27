# Tests for services/command_router.py and services/simulator.py (build order B-14): word map
# and matching, access order, typed argument parsing, execution as the service user with the
# session restored, output rendering, dry-run vs persisted simulation, metrics, test send.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.functions import registry
from whatsapp_next.functions.context import FunctionResult
from whatsapp_next.services import command_router as cr
from whatsapp_next.services import functions_catalog as fc
from whatsapp_next.services import simulator
from whatsapp_next.tests.conftest_frappe import (
	delete_all,
	delete_test_rows,
	ensure_contact,
	ensure_device,
	ensure_settings,
)

SERVICE_USER = "wa-test-svc@example.com"
P_LINKED = "+966500000601"
P_UNLINKED = "+966500000602"
BLACKLIST = "RouterTest Blacklist"


def _service_user() -> str:
	if not frappe.db.exists("User", SERVICE_USER):
		u = frappe.get_doc(
			{
				"doctype": "User",
				"email": SERVICE_USER,
				"first_name": "WA Svc",
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


class TestCommandRouter(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("Router Device", "WAD-TEST-CR01", phone="+966500000031")
		if not frappe.db.exists("WhatsApp Contact Group", BLACKLIST):
			frappe.get_doc(
				{
					"doctype": "WhatsApp Contact Group",
					"group_name": BLACKLIST,
					"kind": "Blacklist",
					"source": "Manual",
				}
			).insert(ignore_permissions=True)
		ensure_settings(
			enable_commands=1,
			command_service_user=_service_user(),
			global_blacklist_group=BLACKLIST,
			unknown_command_reply="Unknown command, send ? for help",
			send_receipt_reply=0,
			default_device=cls.device,
		)
		cls._reset()
		fc.clear_cache()
		fc.install("ping")
		fc.install("document_info")
		frappe.get_doc(
			{
				"doctype": "WhatsApp Command",
				"code": "ping",
				"synonyms": "بنق",
				"function": "ping",
				"status": "Active",
				"requires_linked_contact": 0,
			}
		).insert(ignore_permissions=True)
		frappe.get_doc(
			{
				"doctype": "WhatsApp Command",
				"code": "doc",
				"function": "document_info",
				"status": "Active",
				"requires_linked_contact": 1,
				"allowed_party_types": [{"party_type": "Customer"}],
			}
		).insert(ignore_permissions=True)
		cls.contact = ensure_contact("Router Linked Contact", P_LINKED)
		customer = frappe.get_all("Customer", limit=1, pluck="name")
		if customer:
			c = frappe.get_doc("Contact", cls.contact)
			if not any(l.link_doctype == "Customer" for l in c.links):
				c.append("links", {"link_doctype": "Customer", "link_name": customer[0]})
				c.save(ignore_permissions=True)
		cls.customer = customer[0] if customer else None

	@classmethod
	def tearDownClass(cls):
		cls._reset()
		ensure_settings(
			enable_commands=0,
			command_service_user=None,
			global_blacklist_group=None,
			unknown_command_reply=None,
		)
		delete_all("WhatsApp Contact Group", {"group_name": BLACKLIST})
		delete_all("Contact", {"first_name": "Router Linked Contact"})
		super().tearDownClass()

	@classmethod
	def _reset(cls):
		delete_test_rows("WhatsApp Queue Item")
		delete_test_rows("WhatsApp Log", {"source_type": ("in", ["Command Reply", "Simulator"])})
		delete_test_rows("WhatsApp Inbound Message", {"is_simulated": 1})
		delete_all("WhatsApp Command", {"function": ("in", ["ping", "document_info"])})
		delete_all("WhatsApp Function", {"name": ("in", ["ping", "document_info"])})
		cr.clear_map()

	def setUp(self):
		delete_test_rows("WhatsApp Queue Item")
		delete_test_rows("WhatsApp Log", {"source_type": ("in", ["Command Reply", "Simulator"])})
		delete_test_rows("WhatsApp Inbound Message", {"is_simulated": 1})
		g = frappe.get_doc("WhatsApp Contact Group", BLACKLIST)
		g.set("members", [])
		g.save(ignore_permissions=True)
		ensure_settings(enable_commands=1, send_receipt_reply=0)
		cr.clear_map()

	# -- matching ----------------------------------------------------------------------

	def test_map_and_match(self):
		m = cr.command_map(refresh=True)
		self.assertEqual((m["ping"], m["بنق"], m["doc"]), ("ping", "ping", "doc"))
		self.assertEqual(cr.match("#PING hello there").rest, "hello there")
		self.assertEqual(cr.match("/doc SINV-1").command, "doc")
		self.assertTrue(cr.match("?").is_help)
		self.assertIsNone(cr.match("nothing here"))
		self.assertIsNone(cr.match(""))
		# saving a command invalidates the map
		cmd = frappe.get_doc("WhatsApp Command", "ping")
		cmd.status = "Inactive"
		cmd.save(ignore_permissions=True)
		self.assertIsNone(cr.match("#ping"))
		cmd.status = "Active"
		cmd.save(ignore_permissions=True)
		self.assertIsNotNone(cr.match("#ping"))
		self.assertIn("ping —", cr.help_text())

	# -- route via simulator -------------------------------------------------------------

	def test_ping_executes_as_service_user_and_restores_session(self):
		seen = {}
		original = registry.FUNCTION_HANDLERS["ping"]

		def spy(ctx):
			seen["user"] = frappe.session.user
			seen["dry_run"] = ctx.dry_run
			return original(ctx)

		with patch.dict(registry.FUNCTION_HANDLERS, {"ping": spy}):
			res = simulator.simulate_inbound(self.device, P_UNLINKED, "#ping hello world")
		self.assertEqual(res.status, "Executed")
		self.assertEqual(seen, {"user": SERVICE_USER, "dry_run": True})
		self.assertEqual(frappe.session.user, "Administrator")
		self.assertEqual(res.args, {"text": "hello world"})
		self.assertTrue(res.replies[0]["body"].startswith("pong: hello world"))
		self.assertEqual(res.outbound, [])  # dry run: nothing stored
		self.assertEqual(frappe.db.count("WhatsApp Log", {"source_type": "Command Reply"}), 0)
		self.assertGreaterEqual(frappe.db.get_value("WhatsApp Function", "ping", "call_count"), 1)

	def test_unknown_help_and_blocks(self):
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "#xyz")
		self.assertEqual(
			(res.status, res.replies[0]["body"]), ("Not Matched", "Unknown command, send ? for help")
		)
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "?")
		self.assertEqual(res.status, "Executed")
		self.assertIn("doc —", res.replies[0]["body"])
		# not linked
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "#doc SINV-1")
		self.assertEqual((res.status, res.block_reason, res.replies), ("Blocked", "Not Linked", []))
		# receipt reply on blocks
		ensure_settings(send_receipt_reply=1, receipt_reply="got it")
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "#doc SINV-1")
		self.assertIn("Not Linked", res.replies[0]["body"])
		ensure_settings(send_receipt_reply=0)
		# blacklist wins over everything after the enabled/text checks
		g = frappe.get_doc("WhatsApp Contact Group", BLACKLIST)
		g.append("members", {"phone": P_UNLINKED, "source_type": "Manual"})
		g.save(ignore_permissions=True)
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "#ping")
		self.assertEqual(res.block_reason, "Blacklist")
		# commands disabled → Blocked (the router still records it)
		with patch.object(cr, "check_access", return_value="Commands Disabled"):
			res = simulator.simulate_inbound(self.device, P_LINKED, "#ping")
		self.assertEqual(res.block_reason, "Commands Disabled")

	def test_args_party_and_handler_errors(self):
		if not self.customer:
			self.skipTest("no Customer on this site")
		# missing required arg → Failed with a reply
		res = simulator.simulate_inbound(self.device, P_LINKED, "#doc")
		self.assertEqual(res.status, "Failed")
		self.assertIn("required", res.error)
		# handler error (document does not exist) → Failed, error reply
		res = simulator.simulate_inbound(self.device, P_LINKED, "#doc NOPE-1")
		self.assertEqual(res.status, "Failed")
		self.assertIn("not found", res.error)
		self.assertEqual(res.replies[0]["output_key"], "error")
		# typed parsing
		cmd = frappe.get_doc("WhatsApp Command", "doc")
		with patch.object(
			cr,
			"_manifest_inputs",
			return_value=[
				{"key": "name", "type": "str", "required": True, "position": 1},
				{"key": "days", "type": "int", "position": 2},
				{"key": "from", "type": "date", "position": 3},
			],
		):
			self.assertEqual(
				cr.parse_args(cmd, "SINV-1 days=7 2026-01-05"),
				{"name": "SINV-1", "days": 7, "from": "2026-01-05"},
			)
			with self.assertRaises(WAValidationError):
				cr.parse_args(cmd, "SINV-1 days=seven")
			with self.assertRaises(WAValidationError):
				cr.parse_args(cmd, "")
		self.assertEqual(cr.settings_for(cmd)["document_type"], "Sales Invoice")
		self.assertEqual(cr.settings_for(cmd)["require_party"], 1)

	def test_persisted_simulation_and_live_guard(self):
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "#ping persisted", persist=True)
		self.assertEqual(res.status, "Executed")
		self.assertIsNotNone(res.inbound)
		row = frappe.db.get_value(
			"WhatsApp Inbound Message",
			res.inbound,
			["is_simulated", "command_status", "command", "reply_outbound"],
			as_dict=True,
		)
		self.assertEqual((row.is_simulated, row.command_status, row.command), (1, "Executed", "ping"))
		self.assertEqual(row.reply_outbound, res.outbound[0])
		out = frappe.db.get_value(
			"WhatsApp Log",
			res.outbound[0],
			["is_simulated", "status", "source_type", "trigger_inbound"],
			as_dict=True,
		)
		self.assertEqual(
			(out.is_simulated, out.status, out.source_type, out.trigger_inbound),
			(1, "Unsent", "Command Reply", res.inbound),
		)
		self.assertEqual(frappe.db.count("WhatsApp Queue Item", {"outbound_message": res.outbound[0]}), 0)
		# live route refuses inside a web request (flags/local are plain attributes, not patchable)
		frappe.flags.in_test = False
		frappe.local.request = object()
		try:
			with self.assertRaises(WAStateConflictError):
				cr.route(res.inbound)
		finally:
			frappe.flags.in_test = True
			del frappe.local.request  # a `None` request breaks frappe.get_url() in later tests
		# live route from a job: enqueues the reply
		res2 = simulator.simulate_inbound(self.device, P_UNLINKED, "#ping live", persist=True)
		frappe.db.set_value("WhatsApp Inbound Message", res2.inbound, "is_simulated", 0)
		with patch.object(frappe, "enqueue"):
			live = cr.route(res2.inbound)
		self.assertEqual(live.status, "Executed")
		self.assertEqual(frappe.db.get_value("WhatsApp Log", live.outbound[0], "status"), "Queued")
		self.assertEqual(frappe.db.count("WhatsApp Queue Item", {"outbound_message": live.outbound[0]}), 1)

	def test_render_outputs_and_send_test(self):
		cmd = frappe.get_doc("WhatsApp Command", "doc")
		sender = cr.sender_for({"phone_e164": P_LINKED, "contact": self.contact})
		result = FunctionResult(
			data={
				"doctype": "Role",
				"name": "System Manager",
				"status": "Submitted",
				"amount": None,
				"date": "",
				"party": None,
			}
		)
		replies = cr.render_outputs(cmd, result, sender, dry_run=True)
		kinds = {r["output_key"]: r for r in replies}
		self.assertIn("Role System Manager", kinds["summary"]["body"])
		self.assertEqual(kinds["document"]["message_type"], "Document", kinds["document"].get("body"))
		self.assertIsNone(kinds["document"]["attachment"])  # dry run: not stored
		self.assertTrue(kinds["document"]["file_name"].endswith(".pdf"))
		with patch.object(frappe, "enqueue") as enq:
			out = simulator.send_test(self.device, P_UNLINKED, "hello test")
		self.assertEqual(
			frappe.db.get_value("WhatsApp Log", out, ["is_test", "status", "source_type"], as_dict=True),
			{"is_test": 1, "status": "Unsent", "source_type": "Simulator"},
		)
		self.assertEqual(enq.call_args.args[0], "whatsapp_next.services.dispatch.send_test_message")
		self.assertEqual(
			frappe.db.count("WhatsApp Audit Log", {"action": "Test Send", "reference_name": out}), 1
		)
