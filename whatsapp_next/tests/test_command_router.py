# Tests for services/command_router.py and services/simulator.py (build order B-14,
# WHATSAPP_NEXT_INTEGRATION §5): word map and matching, access order, typed argument parsing from the
# function's header, execution of the function's Server Script as the service user with the session
# restored, replies, dry-run vs persisted simulation, metrics, test send. The commands run fixture
# functions (function_fixtures.py): `tping` on `_test_echo`, `tdoc` on `_test_typed`.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAStateConflictError, WAValidationError
from whatsapp_next.services import command_router as cr
from whatsapp_next.services import simulator
from whatsapp_next.services.function_runner import FunctionRun
from whatsapp_next.tests import function_fixtures as ff
from whatsapp_next.tests.conftest_frappe import (
	delete_all,
	delete_test_rows,
	ensure_contact,
	ensure_device,
	ensure_settings,
)

SERVICE_USER = ff.SERVICE_USER
P_LINKED = "+966500000601"
P_UNLINKED = "+966500000602"
BLACKLIST = "RouterTest Blacklist"


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
			command_service_user=ff.ensure_service_user(),
			global_blacklist_group=BLACKLIST,
			unknown_command_reply="Unknown command, send ? for help",
			send_receipt_reply=0,
			default_device=cls.device,
			main_menu_mode="Off",
		)
		cls._reset()
		ff.ensure_function("_test_echo")
		ff.ensure_function("_test_typed")
		ff.make_command("tping", "_test_echo", synonyms="tبنق")
		ff.make_command(
			"tdoc", "_test_typed", requires_linked_contact=1, allowed_party_types=[{"party_type": "Customer"}]
		)
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
		ff.drop_all()
		cr.clear_map()

	def setUp(self):
		delete_test_rows("WhatsApp Queue Item")
		delete_test_rows("WhatsApp Log", {"source_type": ("in", ["Command Reply", "Simulator"])})
		delete_test_rows("WhatsApp Inbound Message", {"is_simulated": 1})
		g = frappe.get_doc("WhatsApp Contact Group", BLACKLIST)
		g.set("members", [])
		g.save(ignore_permissions=True)
		# the assertions read English replies, whatever language this site answers in
		ensure_settings(enable_commands=1, send_receipt_reply=0, command_reply_language="en", main_menu_mode="Off")
		cr.clear_map()

	# -- matching ----------------------------------------------------------------------

	def test_map_and_match(self):
		m = cr.command_map(refresh=True)
		self.assertEqual((m["tping"], m["tبنق"], m["tdoc"]), ("tping", "tping", "tdoc"))
		self.assertEqual(cr.match("#TPING hello there").rest, "hello there")
		self.assertEqual(cr.match("/tdoc SINV-1").command, "tdoc")
		self.assertTrue(cr.match("?").is_help)
		self.assertIsNone(cr.match("nothing here"))
		self.assertIsNone(cr.match(""))
		# saving a command invalidates the map
		cmd = frappe.get_doc("WhatsApp Command", "tping")
		cmd.status = "Inactive"
		cmd.save(ignore_permissions=True)
		self.assertIsNone(cr.match("#tping"))
		cmd.status = "Active"
		cmd.save(ignore_permissions=True)
		self.assertIsNotNone(cr.match("#tping"))
		self.assertIn("tping —", cr.help_text())

	# -- route via simulator -------------------------------------------------------------

	def test_ping_executes_as_service_user_and_restores_session(self):
		replies_before = frappe.db.count("WhatsApp Log", {"source_type": "Command Reply"})
		calls_before = frappe.db.get_value("WhatsApp Function", "_test_echo", "call_count")
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "#tping hello world")
		self.assertEqual(res.status, "Executed")
		self.assertEqual(res.data["user"], SERVICE_USER)  # the script saw the service user
		self.assertEqual(frappe.session.user, "Administrator")
		# the run's parameters: the sender's text and the header's default message
		self.assertEqual(res.args, {"text": "hello world", "msg_result": "pong: {{ echo }}"})
		self.assertTrue(res.replies[0]["body"].startswith("pong: hello world"))
		self.assertEqual(res.outbound, [])  # dry run: nothing stored
		# the site's own simulated replies stay; this run adds none (R-041)
		self.assertEqual(frappe.db.count("WhatsApp Log", {"source_type": "Command Reply"}), replies_before)
		# a dry run is not a call: the function's figures describe what senders got
		self.assertEqual(frappe.db.get_value("WhatsApp Function", "_test_echo", "call_count"), calls_before)

	def test_unknown_help_and_blocks(self):
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "#xyz")
		self.assertEqual(
			(res.status, res.replies[0]["body"]), ("Not Matched", "Unknown command, send ? for help")
		)
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "?")
		self.assertEqual(res.status, "Executed")
		self.assertIn("tdoc —", res.replies[0]["body"])
		# not linked
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "#tdoc SINV-1")
		self.assertEqual((res.status, res.block_reason, res.replies), ("Blocked", "Not Linked", []))
		# receipt reply on blocks
		ensure_settings(send_receipt_reply=1, receipt_reply="got it")
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "#tdoc SINV-1")
		self.assertEqual(res.block_reason, "Not Linked")
		self.assertIn("not linked to an account", res.replies[0]["body"])  # the reason in words, not the code
		ensure_settings(send_receipt_reply=0)
		# blacklist wins over everything after the enabled/text checks
		g = frappe.get_doc("WhatsApp Contact Group", BLACKLIST)
		g.append("members", {"phone": P_UNLINKED, "source_type": "Manual"})
		g.save(ignore_permissions=True)
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "#tping")
		self.assertEqual(res.block_reason, "Blacklist")
		# commands disabled → Blocked (the router still records it)
		with patch.object(cr, "check_access", return_value="Commands Disabled"):
			res = simulator.simulate_inbound(self.device, P_LINKED, "#tping")
		self.assertEqual(res.block_reason, "Commands Disabled")

	def test_help_token_explains_one_command(self):
		"""`؟` alone lists the commands; beside a command word it explains that command's variables,
		read from the function's header."""
		for text in ("#tdoc ?", "tdoc ؟", "؟ tdoc", "tdoc؟", "help tdoc"):
			m = cr.match(text)
			self.assertEqual((m.command, m.is_help, m.rest), ("tdoc", True, ""), text)
		self.assertEqual((cr.match("؟").command, cr.match("؟").is_help), ("", True))
		self.assertFalse(cr.match("#tdoc SINV-1").is_help)
		usage = cr.usage_text(frappe.get_doc("WhatsApp Command", "tdoc"))
		# the required document first, then the optional values, in the header's order
		self.assertIn("Send: tdoc <Document> [Days] [Since]", usage)
		self.assertIn("Example: tdoc Document", usage)  # a ready example
		self.assertIn("tdoc doc_name=…", usage)  # by name, shown for two variables or more
		self.assertNotIn("party", usage)  # the party is never the sender's to give
		ping = cr.usage_text(frappe.get_doc("WhatsApp Command", "tping"))
		self.assertIn("takes the rest of the message", ping)
		self.assertNotIn("=…", ping)
		self.assertNotIn("msg_result", ping)  # a message template is not a variable
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "tdoc ؟")
		self.assertEqual((res.status, res.replies[0]["output_key"]), ("Executed", "help"))
		self.assertEqual(res.replies[0]["body"], usage)  # no access check: help reveals no data
		self.assertIn("tping —", simulator.simulate_inbound(self.device, P_UNLINKED, "؟").replies[0]["body"])
		# the token set in Settings, and the words it may not take
		ensure_settings(command_help_token="تعريف")
		try:
			self.assertTrue(cr.match("tping تعريف").is_help)
			with self.assertRaises(WAValidationError):
				ensure_settings(command_help_token="tping")
			with self.assertRaises(WAValidationError):
				ensure_settings(command_help_token="two words")
			cmd = frappe.get_doc("WhatsApp Command", "tping")
			cmd.status = "Inactive"
			cmd.save(ignore_permissions=True)
			cmd.synonyms = "تعريف"
			with self.assertRaises(WAValidationError):
				cmd.save(ignore_permissions=True)
		finally:
			ensure_settings(command_help_token="؟")
			frappe.db.set_value("WhatsApp Command", "tping", {"status": "Active", "synonyms": "tبنق"})
			cr.clear_map()

	def test_replies_are_written_in_the_reply_language(self):
		"""Settings' reply language, not the caller's; the caller's language comes back after."""
		before = frappe.local.lang
		ensure_settings(command_reply_language="ar")
		try:
			res = simulator.simulate_inbound(self.device, P_UNLINKED, "tdoc ؟")
			self.assertIn("أرسل:", res.replies[0]["body"])
			self.assertEqual(frappe.local.lang, before)
			# a job resolves its user's language on its first `_()` and overwrites `frappe.local.lang`;
			# when that first call falls inside the reply (a fresh worker), the reply must stay put
			frappe.local.job = frappe._dict(user="Guest", lang_resolved=False)
			try:
				with cr.in_reply_language():
					self.assertEqual(frappe._("Send: {0}"), "أرسل: {0}")
					self.assertEqual(frappe._("Variables, in this order:"), "المتغيرات بهذا الترتيب:")
			finally:
				del frappe.local.job
		finally:
			ensure_settings(command_reply_language="en")
		self.assertNotIn(
			"أرسل:", simulator.simulate_inbound(self.device, P_UNLINKED, "tdoc ؟").replies[0]["body"]
		)

	def test_args_party_and_handler_errors(self):
		if not self.customer:
			self.skipTest("no Customer on this site")
		# missing required arg → Failed with a reply
		res = simulator.simulate_inbound(self.device, P_LINKED, "#tdoc")
		self.assertEqual(res.status, "Failed")
		self.assertIn("required", res.error)
		# the script's error (document does not exist) → Failed, error reply
		res = simulator.simulate_inbound(self.device, P_LINKED, "#tdoc NOPE-1")
		self.assertEqual(res.status, "Failed")
		self.assertIn("not found", res.error)
		self.assertEqual(res.replies[0]["output_key"], "error")
		# a run for the linked party
		res = simulator.simulate_inbound(self.device, P_LINKED, "#tdoc SINV-1 2 -3d")
		self.assertEqual((res.status, res.replies[0]["body"]), ("Executed", f"doc SINV-1 of {self.customer}"))
		self.assertEqual(res.data["days"], 2)

	def test_typed_parsing_follows_the_header(self):
		cmd = frappe.get_doc("WhatsApp Command", "tdoc")
		self.assertEqual(
			[(i["key"], i["type"], i["required"], i["position"]) for i in cr.command_inputs(cmd)],
			[("doc_name", "str", True, 1), ("days", "int", False, 2), ("since", "date", False, 3)],
		)
		self.assertEqual(
			cr.parse_args(cmd, "SINV-1 days=7 2026-01-05"),
			{"doc_name": "SINV-1", "days": 7, "since": "2026-01-05"},
		)
		# named values in any order, a relative date, quotes keep spaces
		self.assertEqual(
			cr.parse_args(cmd, 'since=month_start "SINV 1" DAYS=3'),
			{"doc_name": "SINV 1", "days": 3, "since": str(frappe.utils.get_first_day(frappe.utils.nowdate()))},
		)
		# the party and a template are never the sender's: their key=value is dropped
		self.assertEqual(cr.parse_args(cmd, "SINV-1 party=OTHER party_type=Supplier"), {"doc_name": "SINV-1"})
		with self.assertRaises(WAValidationError):
			cr.parse_args(cmd, "SINV-1 days=seven")
		frappe.clear_last_message()
		self.assertEqual(cr.parse_args(cmd, ""), {})  # required values are checked when the run is built
		# the last text input takes the rest of the message
		ping = frappe.get_doc("WhatsApp Command", "tping")
		self.assertEqual(cr.parse_args(ping, "hello  there world"), {"text": "hello there world"})
		self.assertEqual(cr.parse_args(ping, "msg_result=x hi"), {"text": "hi"})
		# a value the command fixes, or switched off, is no input
		draft = frappe._dict(function="_test_typed", settings_overrides='{"days": 9}', disabled_inputs="since")
		self.assertEqual([i["key"] for i in cr.command_inputs(draft)], ["doc_name"])
		self.assertEqual(cr.parse_args(draft, "SINV-1 days=1 2026-01-01"), {"doc_name": "SINV-1 2026-01-01"})

	def test_persisted_simulation_and_live_guard(self):
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "#tping persisted", persist=True)
		self.assertEqual(res.status, "Executed")
		self.assertIsNotNone(res.inbound)
		row = frappe.db.get_value(
			"WhatsApp Inbound Message",
			res.inbound,
			["is_simulated", "command_status", "command", "reply_outbound"],
			as_dict=True,
		)
		self.assertEqual((row.is_simulated, row.command_status, row.command), (1, "Executed", "tping"))
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
		res2 = simulator.simulate_inbound(self.device, P_UNLINKED, "#tping live", persist=True)
		frappe.db.set_value("WhatsApp Inbound Message", res2.inbound, "is_simulated", 0)
		with patch.object(frappe, "enqueue"):
			live = cr.route(res2.inbound)
		self.assertEqual(live.status, "Executed")
		self.assertEqual(frappe.db.get_value("WhatsApp Log", live.outbound[0], "status"), "Queued")
		self.assertEqual(frappe.db.count("WhatsApp Queue Item", {"outbound_message": live.outbound[0]}), 1)

	def test_automatic_replies_skip_the_queue(self):
		"""The receipt and the unknown-command reply go out at once (`dispatch.send_now`); the
		function's own reply keeps the queue; a direct send that breaks falls back to the queue."""

		def live(text):
			res = simulator.simulate_inbound(self.device, P_UNLINKED, text, persist=True)
			frappe.db.set_value("WhatsApp Inbound Message", res.inbound, "is_simulated", 0)
			return res.inbound

		queued = lambda name: frappe.db.count("WhatsApp Queue Item", {"outbound_message": name})  # noqa: E731
		ensure_settings(send_receipt_reply=1, receipt_reply="got it")
		inbound = live("#tping now")
		with patch.object(frappe, "enqueue"), patch.object(cr.dispatch, "send_now") as now:
			result = cr.route(inbound)
		self.assertEqual(result.status, "Executed")
		receipt = frappe.get_all(
			"WhatsApp Log", filters={"trigger_inbound": inbound, "body": "got it"}, pluck="name"
		)
		self.assertEqual(len(receipt), 1)
		now.assert_called_once_with(receipt[0], source="direct")
		self.assertEqual(queued(receipt[0]), 0)
		self.assertEqual(queued(result.outbound[0]), 1)  # the function's reply
		ensure_settings(send_receipt_reply=0)
		inbound = live("#xyz")
		with patch.object(frappe, "enqueue"), patch.object(cr.dispatch, "send_now") as now:
			result = cr.route(inbound)
		self.assertEqual(result.status, "Not Matched")
		now.assert_called_once_with(result.outbound[0], source="direct")
		self.assertEqual(queued(result.outbound[0]), 0)
		inbound = live("#xyz again")
		with patch.object(frappe, "enqueue"), patch.object(cr.dispatch, "send_now", side_effect=RuntimeError):
			result = cr.route(inbound)
		self.assertEqual(queued(result.outbound[0]), 1)

	def test_a_reply_quotes_the_message_that_asked(self):
		"""A command's answer is a WhatsApp reply to the message that asked for it (owner, 2026-10-08)."""
		res = simulator.simulate_inbound(self.device, P_UNLINKED, "#tping now", persist=True)
		frappe.db.set_value(
			"WhatsApp Inbound Message", res.inbound, {"is_simulated": 0, "provider_message_id": "ASKED-1"}
		)
		with patch.object(frappe, "enqueue"), patch.object(cr.dispatch, "send_now"):
			result = cr.route(res.inbound)
		self.assertTrue(result.outbound)
		for name in result.outbound:
			self.assertEqual(frappe.db.get_value("WhatsApp Log", name, "reply_to_provider_message_id"), "ASKED-1")

	def test_the_reply_reaches_every_number_of_the_contact(self):
		"""A command's answer goes to the number that asked and to the contact's other WhatsApp
		numbers (owner, 2026-10-08); only the asker's copy quotes the message."""
		other = "+966500000609"
		c = frappe.get_doc("Contact", self.contact)
		c.append("phone_nos", {"phone": other})
		c.save(ignore_permissions=True)
		try:
			res = simulator.simulate_inbound(self.device, P_LINKED, "#tping now", persist=True)
			frappe.db.set_value(
				"WhatsApp Inbound Message", res.inbound, {"is_simulated": 0, "provider_message_id": "ASKED-2"}
			)
			with patch.object(frappe, "enqueue"), patch.object(cr.dispatch, "send_now"):
				result = cr.route(res.inbound)
			rows = [
				frappe.db.get_value("WhatsApp Log", n, ["phone_e164", "reply_to_provider_message_id"], as_dict=True)
				for n in result.outbound
			]
			self.assertEqual(rows[0].phone_e164, P_LINKED)
			self.assertEqual({r.phone_e164 for r in rows}, {P_LINKED, other})
			for r in rows:
				self.assertEqual(r.reply_to_provider_message_id, "ASKED-2" if r.phone_e164 == P_LINKED else None)
		finally:
			c.reload()
			c.set("phone_nos", [p for p in c.phone_nos if p.wa_phone_e164 != other])
			c.save(ignore_permissions=True)

	def test_a_contact_of_several_accounts_answers_for_its_primary_one(self):
		links = [
			frappe._dict(link_doctype="Customer", link_name="First Linked"),
			frappe._dict(link_doctype="Customer", link_name="Primary Of"),
		]
		primary = {"First Linked": "Somebody Else", "Primary Of": self.contact}
		with (
			patch.object(cr.frappe, "get_all", return_value=links),
			patch.object(cr.frappe.db, "get_value", side_effect=lambda dt, name, field: primary[name]),
		):
			sender = cr.sender_for({"phone_e164": P_LINKED, "contact": self.contact})
			self.assertEqual((sender.party_type, sender.party_name), ("Customer", "Primary Of"))
		# nobody's primary contact: the first link, as before
		with (
			patch.object(cr.frappe, "get_all", return_value=links),
			patch.object(cr.frappe.db, "get_value", return_value=None),
		):
			sender = cr.sender_for({"phone_e164": P_LINKED, "contact": self.contact})
			self.assertEqual(sender.party_name, "First Linked")

	def test_render_outputs_and_send_test(self):
		cmd = frappe.get_doc("WhatsApp Command", "tdoc")
		sender = cr.sender_for({"phone_e164": P_LINKED, "contact": self.contact})
		result = FunctionRun(
			messages=[
				{"reply": "summary", "type": "text", "text": "Role System Manager"},
				{
					"reply": "document",
					"type": "report",
					"report_name": "Some Report",
					"filters": {"name": "System Manager"},
					"format": "PDF",
					"file_name": "statement.pdf",
					"caption": "your statement",
				},
			]
		)
		replies = cr.render_outputs(cmd, result, sender, dry_run=True)
		self.assertEqual([r["output_key"] for r in replies], ["summary", "document"])  # in the run's order
		kinds = {r["output_key"]: r for r in replies}
		self.assertEqual((kinds["summary"]["message_type"], kinds["summary"]["body"]), ("Text", "Role System Manager"))
		self.assertEqual(kinds["document"]["message_type"], "Document", kinds["document"].get("body"))
		self.assertIsNone(kinds["document"]["attachment"])  # dry run: not printed, not stored
		self.assertEqual((kinds["document"]["file_name"], kinds["document"]["body"]), ("statement.pdf", "your statement"))
		# an error is the only reply
		self.assertEqual(
			[r["body"] for r in cr.render_outputs(cmd, FunctionRun(error="no"), sender, dry_run=True)], ["no"]
		)
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
