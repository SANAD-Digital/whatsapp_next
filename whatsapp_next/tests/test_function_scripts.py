# Acceptance tests of command functions as Server Scripts (WHATSAPP_NEXT_INTEGRATION §10): discovery by
# the `wa_fn_` method, header errors with their line, `@requires`, `@party_types`, asking for a date
# range over WhatsApp, values the sender may not set, the reply language, undeclared replies, switched
# off replies, the direct-URL guard, the Functions Center "Try" against a command dry run — plus the
# install rules (guard, duplicate `@function`), update keeping the site's values, and the repo's own
# function scripts. Every function here is a fixture script `wa_fn__test_*` (function_fixtures.py).

from __future__ import annotations

import json
import os
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services import command_router as cr
from whatsapp_next.services import command_sessions, function_runner, simulator
from whatsapp_next.services import function_header as fh
from whatsapp_next.services import functions_catalog as fc
from whatsapp_next.services.function_runner import Sender
from whatsapp_next.tests import function_fixtures as ff
from whatsapp_next.tests.conftest_frappe import (
	delete_all,
	ensure_contact,
	ensure_device,
	ensure_settings,
	fake_provider,
)

P_LINKED = "+966500940101"
P_SUPPLIER = "+966500940102"
P_UNLINKED = "+966500940103"
LINKED = "FnScript Linked Contact"
SUPPLIER_CONTACT = "FnScript Supplier Contact"


def _link(contact: str, doctype: str, name: str) -> None:
	doc = frappe.get_doc("Contact", contact)
	if not any(link.link_doctype == doctype and link.link_name == name for link in doc.links):
		doc.set("links", [link for link in doc.links if link.link_doctype != doctype])
		doc.append("links", {"link_doctype": doctype, "link_name": name})
		doc.save(ignore_permissions=True)


def _texts(replies) -> list[str]:
	return [r["body"] for r in replies if r.get("message_type") == "Text"]


class TestFunctionScripts(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ff.drop_all()
		cls.device = ensure_device("FnScript Device", "WAD-TEST-FS01", phone="+966500940001")
		ensure_settings(
			enable_commands=1,
			command_service_user=ff.ensure_service_user(),
			send_receipt_reply=0,
			command_reply_language="en",
			main_menu_mode="Off",
			default_device=cls.device,
		)
		cls.customer = (frappe.get_all("Customer", limit=1, pluck="name") or [None])[0]
		cls.supplier = (frappe.get_all("Supplier", limit=1, pluck="name") or [None])[0]
		cls.contact = ensure_contact(LINKED, P_LINKED)
		if cls.customer:
			_link(cls.contact, "Customer", cls.customer)
		cls.supplier_contact = ensure_contact(SUPPLIER_CONTACT, P_SUPPLIER)
		if cls.supplier:
			_link(cls.supplier_contact, "Supplier", cls.supplier)

	@classmethod
	def tearDownClass(cls):
		ff.drop_all()
		delete_all("Contact", {"first_name": ("in", [LINKED, SUPPLIER_CONTACT])})
		super().tearDownClass()

	def setUp(self):
		self._lang = frappe.local.lang
		frappe.local.lang = "en"
		ensure_settings(
			enable_commands=1, send_receipt_reply=0, command_reply_language="en", main_menu_mode="Off"
		)
		ff.drop_commands()
		self.addCleanup(command_sessions.clear, self.device, P_LINKED)

	def tearDown(self):
		frappe.local.lang = self._lang

	def _need_customer(self):
		if not self.customer:
			self.skipTest("no Customer on this site")

	def _sim(self, phone: str, text: str, **kw):
		return simulator.simulate_inbound(self.device, phone, text, **kw)

	def _live(self, body: str, selected: str | None = None):
		"""A received message from the linked contact, routed live (replies captured, not sent)."""
		doc = frappe.get_doc(
			{
				"doctype": "WhatsApp Inbound Message",
				"device": self.device,
				"phone": P_LINKED,
				"phone_e164": P_LINKED,
				"contact": self.contact,
				"message_type": "Interactive Reply" if selected else "Text",
				"body": body,
				"selected_option_id": selected,
				"provider_message_id": f"FS-{frappe.generate_hash(length=10)}",
				"command_status": "None",
			}
		)
		doc.flags.ignore_mandatory = True
		doc.flags.skip_numbers_upsert = True
		doc.insert(ignore_permissions=True)
		sent: list[dict] = []
		with (
			fake_provider(),
			patch.object(
				cr, "_send_replies", side_effect=lambda c, i, replies, **k: sent.extend(replies) or []
			),
		):
			res = cr.route(doc.name)
		return res, sent, doc.name

	# 1 ---------------------------------------------------------------------------------------------

	def test_01_a_method_without_the_prefix_is_not_a_function(self):
		ff.ensure_script(
			"wa_fn__test_wrongmethod",
			ff.source("_test_wrongmethod", ff.ASON_LINES, ff.ASON_BODY),
			api_method="wa_test_wrongmethod",
		)
		ff.ensure_script("wa_fn__test_off", ff.source("_test_off", ff.ASON_LINES, ff.ASON_BODY), disabled=1)
		scripts = [e["server_script"] for e in fc.discover(use_cache=False)]
		self.assertNotIn("wa_fn__test_wrongmethod", scripts)
		self.assertNotIn("wa_fn__test_off", scripts)  # a disabled script is no function either
		keys = [e["function_key"] for e in fc.storefront()]
		self.assertNotIn("_test_wrongmethod", keys)
		self.assertNotIn("_test_off", keys)
		with self.assertRaises(WAValidationError):
			fc.install("wa_fn__test_wrongmethod")
		with self.assertRaises(WAValidationError):
			fc.install("wa_fn__test_off")
		self.assertFalse(frappe.db.exists("WhatsApp Function", "_test_wrongmethod"))

	# 2 ---------------------------------------------------------------------------------------------

	def test_02_a_wrong_header_line_is_listed_with_its_line(self):
		bad = ff.source(
			"_test_invalid",
			["@param  x | Data | maybe |  | X", "@reply  result_text | text |  | Result"],
			ff.OK_BODY,
		)
		ff.ensure_script("wa_fn__test_invalid", bad)
		with self.assertRaises(fh.HeaderError) as caught:
			fh.parse_function_header(bad)
		self.assertIn("(line 6)", str(caught.exception))  # lines 1–5 are the header's first tags
		entry = {e["server_script"]: e for e in fc.discover(use_cache=False)}["wa_fn__test_invalid"]
		self.assertIsNone(entry["spec"])
		self.assertIn("(line 6)", entry["error"])
		listed = {e["server_script"]: e for e in fc.storefront()}["wa_fn__test_invalid"]
		self.assertEqual((listed["state"], listed["available"]), ("invalid", False))
		self.assertIn("(line 6)", listed["error"])
		with self.assertRaises(WAValidationError):
			fc.install("wa_fn__test_invalid")

	# 3 ---------------------------------------------------------------------------------------------

	def test_03_requires_a_missing_report(self):
		name, script = ff.FUNCTIONS["_test_needs"]
		ff.ensure_script(name, script)
		listed = {e["server_script"]: e for e in fc.storefront()}[name]
		self.assertEqual((listed["state"], listed["available"]), ("unavailable", False))
		self.assertIn(ff.NEEDED_REPORT, " ".join(listed["reasons"]))
		with self.assertRaises(WAValidationError):
			fc.install(name)
		self.assertFalse(frappe.db.exists("WhatsApp Function", "_test_needs"))

		# the report arrives: the function installs and its command runs ...
		frappe.get_doc(
			{
				"doctype": "Report",
				"report_name": ff.NEEDED_REPORT,
				"ref_doctype": "ToDo",
				"report_type": "Report Builder",
				"is_standard": "No",
				"module": "WhatsApp Next",
			}
		).insert(ignore_permissions=True)
		ff.ensure_function("_test_needs")
		ff.make_command("tfnneeds", "_test_needs")
		res = self._sim(P_UNLINKED, "tfnneeds")
		self.assertEqual((res.status, _texts(res.replies)), ("Executed", ["ok"]))
		# ... and once it is disabled, the command is blocked `Function Inactive`, with the reason kept
		frappe.db.set_value("Report", ff.NEEDED_REPORT, "disabled", 1)
		res = self._sim(P_UNLINKED, "tfnneeds", persist=True)
		self.assertEqual((res.status, res.block_reason), ("Blocked", "Function Inactive"))
		row = frappe.db.get_value(
			"WhatsApp Inbound Message", res.inbound, ["block_reason", "command_error"], as_dict=True
		)
		self.assertEqual(row.block_reason, "Function Inactive")
		self.assertIn(ff.NEEDED_REPORT, row.command_error)
		# an Inactive function blocks the same way
		frappe.db.set_value("Report", ff.NEEDED_REPORT, "disabled", 0)
		fc.set_status("_test_needs", "Inactive")
		self.assertEqual(self._sim(P_UNLINKED, "tfnneeds").block_reason, "Function Inactive")

	# 4 ---------------------------------------------------------------------------------------------

	def test_04_party_types_refuse_a_supplier(self):
		ff.ensure_function("_test_span")
		cmd = frappe.get_doc("WhatsApp Command", ff.make_command("tfnspan", "_test_span"))
		supplier = Sender("+966500940109", None, None, None, party_type="Supplier", party_name="Any Supplier")
		customer = Sender("+966500940108", None, None, None, party_type="Customer", party_name="Any Customer")
		self.assertEqual(cr.function_block(cmd, supplier), "Party Type")
		self.assertIsNone(cr.function_block(cmd, customer))
		self.assertEqual(cr.check_access(cmd, frappe._dict(message_type="Text"), supplier), "Party Type")
		# the Functions Center's "Try" stops at the same step
		trial = function_runner.trial("_test_span", party_type="Supplier", party=self.supplier)
		self.assertFalse(trial["steps"][-1]["ok"])
		self.assertIn("@party_types", trial["steps"][-1]["name"])
		# a command may not allow a type the header does not serve
		with self.assertRaises(WAValidationError):
			ff.make_command("tfnspanx", "_test_span", allowed_party_types=[{"party_type": "Supplier"}])
		if self.supplier:
			res = self._sim(P_SUPPLIER, "tfnspan")
			self.assertEqual((res.status, res.block_reason), ("Blocked", "Party Type"))

	# 5 ---------------------------------------------------------------------------------------------

	def test_05_a_date_range_is_asked_then_the_command_runs(self):
		self._need_customer()
		ff.ensure_function("_test_span")
		ff.make_command(
			"tfnrange",
			"_test_span",
			settings_overrides={"timespan": "select date range"},
			disabled_replies="statement",
		)
		res, sent, _name = self._live("tfnrange")
		self.assertEqual(res.status, "Awaiting Input")
		session = command_sessions.load(self.device, P_LINKED)
		self.assertEqual(session["pending"], ["from_date", "to_date"])
		self.assertIn("From date", sent[0]["body"])

		res, sent, _name = self._live("2026-01-01")
		self.assertEqual(res.status, "Awaiting Input")
		session = command_sessions.load(self.device, P_LINKED)
		self.assertEqual((session["pending"], session["args"]), (["to_date"], {"from_date": "2026-01-01"}))
		self.assertIn("To date", sent[0]["body"])

		res, sent, name = self._live("2026-01-31")
		self.assertEqual(res.status, "Executed", res.error)
		self.assertIsNone(command_sessions.load(self.device, P_LINKED))
		self.assertEqual(
			{k: res.data[k] for k in ("timespan", "from_date", "to_date", "party_type", "party")},
			{
				"timespan": "select date range",
				"from_date": "2026-01-01",
				"to_date": "2026-01-31",
				"party_type": "Customer",
				"party": self.customer,
			},
		)
		self.assertEqual(res.data["user"], ff.SERVICE_USER)  # run as the command service user
		self.assertEqual(_texts(sent), [f"Balance of {self.customer} 2026-01-01..2026-01-31"])
		self.assertEqual(frappe.db.get_value("WhatsApp Inbound Message", name, "command_status"), "Executed")
		self.assertEqual(frappe.session.user, "Administrator")

	# 6 ---------------------------------------------------------------------------------------------

	def test_06_a_value_outside_the_options_is_refused_before_running(self):
		self._need_customer()
		ff.ensure_function("_test_span")
		ff.make_command("tfnspan2", "_test_span", disabled_replies="statement")
		with patch.object(function_runner, "run_function", wraps=function_runner.run_function) as run:
			for text in ("tfnspan2 timespan=forever", "tfnspan2 forever"):
				res = self._sim(P_LINKED, text)
				self.assertEqual(res.status, "Failed", text)
				self.assertIn("«forever» is not an allowed value", res.error)
				self.assertEqual([r["output_key"] for r in res.replies], ["error"])
			run.assert_not_called()
			# an allowed value runs
			self.assertEqual(self._sim(P_LINKED, "tfnspan2 timespan=today").status, "Executed")
			run.assert_called_once()

	# 7 ---------------------------------------------------------------------------------------------

	def test_07_the_party_always_comes_from_the_contact(self):
		self._need_customer()
		ff.ensure_function("_test_span")
		code = ff.make_command("tfnspan3", "_test_span", settings_overrides={"timespan": "today"})
		res = self._sim(P_LINKED, "tfnspan3 party=SOMEONE-ELSE party_type=Supplier")
		self.assertEqual(res.status, "Executed", res.error)
		self.assertEqual((res.data["party_type"], res.data["party"]), ("Customer", self.customer))
		# the editor refuses the party as a command value ...
		with self.assertRaises(WAValidationError):
			ff.make_command("tfnspan4", "_test_span", settings_overrides={"party": "SOMEONE-ELSE"})
		# ... and one written around it is ignored all the same
		frappe.db.set_value(
			"WhatsApp Command",
			code,
			"settings_overrides",
			json.dumps({"timespan": "today", "party": "SOMEONE-ELSE", "party_type": "Supplier"}),
		)
		frappe.clear_document_cache("WhatsApp Command", code)
		res = self._sim(P_LINKED, "tfnspan3")
		self.assertEqual((res.data["party_type"], res.data["party"]), ("Customer", self.customer))
		# the merge itself never takes it from the values
		draft = frappe._dict(
			function="_test_span", settings_overrides={"party": "X", "timespan": "today"}, templates=[]
		)
		sender = Sender(P_LINKED, None, None, self.contact, party_type="Customer", party_name=self.customer)
		params, missing = function_runner.prepare(draft, sender, {"party": "Y", "party_type": "Supplier"})
		self.assertEqual((params["party_type"], params["party"], missing), ("Customer", self.customer, []))
		# a sender with no party is not linked, whatever the text says
		res = self._sim(P_UNLINKED, "tfnspan3 party=SOMEONE-ELSE")
		self.assertEqual((res.status, res.block_reason), ("Blocked", "Not Linked"))

	# 8 ---------------------------------------------------------------------------------------------

	def test_08_the_language_picks_the_default_message(self):
		self._need_customer()
		ensure_settings(command_reply_language="ar")
		ff.ensure_function("_test_span")
		ff.make_command(
			"tfnspanen",
			"_test_span",
			settings_overrides={"language": "en", "timespan": "today"},
			disabled_replies="statement",
		)
		ff.make_command(
			"tfnspanar", "_test_span", settings_overrides={"timespan": "today"}, disabled_replies="statement"
		)
		res = self._sim(P_LINKED, "tfnspanen")
		self.assertEqual(
			(res.status, _texts(res.replies)), ("Executed", [f"Balance of {self.customer} today"])
		)
		self.assertEqual(res.data["language"], "en")
		res = self._sim(P_LINKED, "tfnspanar")
		self.assertEqual(_texts(res.replies), [f"رصيد {self.customer} today"])
		self.assertEqual(res.data["language"], "ar")
		# the command's own text for the language wins over the header's
		frappe.db.set_value("WhatsApp Command", "tfnspanen", "status", "Inactive")
		doc = frappe.get_doc("WhatsApp Command", "tfnspanen")
		doc.append("templates", {"param": "msg_result", "language": "en", "text": "Own {{ party }}"})
		doc.append("templates", {"param": "msg_result", "language": "ar", "text": "خاص {{ party }}"})
		doc.status = "Active"
		doc.save(ignore_permissions=True)
		self.assertEqual(_texts(self._sim(P_LINKED, "tfnspanen").replies), [f"Own {self.customer}"])

	# 9 ---------------------------------------------------------------------------------------------

	def test_09_an_undeclared_reply_fails_the_run_and_nothing_is_sent(self):
		ff.ensure_function("_test_misbehave")
		for code, mode in (("tfnbadreply", "bad_reply"), ("tfnbadreport", "bad_report")):
			ff.make_command(code, "_test_misbehave", settings_overrides={"mode": mode})
			res = self._sim(P_UNLINKED, code, persist=True)
			self.assertEqual(res.status, "Failed", mode)
			# the sender reads the generic failure; the status log keeps which reply was undeclared
			self.assertNotIn("not declared", res.error)
			self.assertIn("not declared", frappe.db.get_value("WhatsApp Inbound Message", res.inbound, "command_error"))
			# none of the function's messages goes out: only the failure is reported
			self.assertEqual([r["output_key"] for r in res.replies], ["error"], mode)
			self.assertEqual(
				frappe.db.count("WhatsApp Log", {"trigger_inbound": res.inbound, "body": "fine"}), 0
			)
			self.assertEqual(
				frappe.db.get_value("WhatsApp Inbound Message", res.inbound, "command_status"), "Failed"
			)
		# the same function with declared messages only is fine
		ff.make_command("tfnfine", "_test_misbehave")
		self.assertEqual(_texts(self._sim(P_UNLINKED, "tfnfine").replies), ["fine"])

	# 10 --------------------------------------------------------------------------------------------

	def test_10_a_switched_off_reply_is_not_sent(self):
		self._need_customer()
		ff.ensure_function("_test_span")
		ff.make_command("tfnall", "_test_span", settings_overrides={"timespan": "today"})
		ff.make_command(
			"tfndis", "_test_span", settings_overrides={"timespan": "today"}, disabled_replies="statement"
		)
		res = self._sim(P_LINKED, "tfnall")
		self.assertEqual([r["output_key"] for r in res.replies], ["result_text", "statement"])
		report = res.replies[1]
		self.assertEqual(
			(report["message_type"], report["attachment"], report["report_name"], report["filters"]),
			("Document", None, ff.SPAN_REPORT, {"party": self.customer}),
		)
		res = self._sim(P_LINKED, "tfndis")
		self.assertEqual(
			[(r["output_key"], r["message_type"]) for r in res.replies], [("result_text", "Text")]
		)

	# 11 --------------------------------------------------------------------------------------------

	def test_11_the_script_refuses_its_own_url(self):
		from frappe.handler import execute_cmd
		from frappe.utils.safe_exec import run_script

		ff.ensure_function("_test_echo")
		name = ff.FUNCTIONS["_test_echo"][0]
		self.assertEqual(frappe.session.user, "Administrator")
		saved = frappe.local.form_dict
		try:
			# what `/api/method/wa_fn__test_echo` does
			frappe.local.form_dict = frappe._dict(cmd=name, text="hi")
			with self.assertRaises(frappe.PermissionError):
				execute_cmd(name)
			frappe.clear_last_message()
			# the runner clears `cmd`: a run inside a request that named the script still works
			out = function_runner.run_function(name, {"text": "hi"}, fc.manifest_of("_test_echo"))
			self.assertEqual(out["messages"][0]["text"], "pong: hi")
		finally:
			frappe.local.form_dict = saved
		with self.assertRaises(frappe.PermissionError):
			run_script(name, cmd=name)
		frappe.clear_last_message()

	# 12 --------------------------------------------------------------------------------------------

	def test_12_try_and_a_command_dry_run_give_the_same_messages(self):
		from whatsapp_next.api.v1 import functions as functions_api
		from whatsapp_next.services import commands as commands_svc
		from whatsapp_next.tests.conftest_frappe import as_user

		ff.ensure_function("_test_echo")
		ff.make_command("tfnecho", "_test_echo")
		trial = function_runner.trial("_test_echo", values={"text": "hello world"})
		self.assertTrue(all(s["ok"] for s in trial["steps"]), trial["steps"])
		dry = cr.dry_run("tfnecho hello world", P_UNLINKED, self.device)
		as_trial = [(m["reply"], m["text"]) for m in trial["messages"]]
		self.assertEqual(as_trial, [("result_text", "pong: hello world")])
		self.assertEqual(as_trial, [(r["output_key"], r["body"]) for r in dry.replies])
		preview = commands_svc.preview(
			{"code": "tfnecho2", "function": "_test_echo", "requires_linked_contact": 0},
			sender={"phone": P_UNLINKED},
			values={"text": "hello world"},
		)
		self.assertEqual(as_trial, [(r["output_key"], r["body"]) for r in preview["replies"]])
		with as_user("WhatsApp Manager"):
			api = functions_api.try_function(function_key="_test_echo", values={"text": "hello world"})
		self.assertEqual([(m["reply"], m["text"]) for m in api["messages"]], as_trial)
		self.assertEqual(frappe.session.user, "Administrator")

		if not self.customer:
			return
		# with a party, a report and the values typed by the sender
		ff.ensure_function("_test_span")
		ff.make_command("tfnspan5", "_test_span")
		trial = function_runner.trial(
			"_test_span", party_type="Customer", party=self.customer, values={"timespan": "today"}
		)
		self.assertTrue(all(s["ok"] for s in trial["steps"]), trial["steps"])
		dry = cr.dry_run("tfnspan5 today", P_LINKED, self.device)

		def shape(key, text, report, filters):
			return (key, text, report, filters)

		self.assertEqual(
			[
				shape(m["reply"], m.get("text"), m.get("report_name"), m.get("filters"))
				for m in trial["messages"]
			],
			[
				shape(
					r["output_key"],
					r["body"] if r["message_type"] == "Text" else None,
					r.get("report_name"),
					r.get("filters"),
				)
				for r in dry.replies
			],
		)

	# install rules -----------------------------------------------------------------------------------

	def test_install_refuses_a_script_without_the_guard(self):
		script = ff.source("_test_noguard", ff.ASON_LINES, ff.ASON_BODY, guard=False)
		self.assertFalse(fh.guard_present(script))
		# a guard far below the header does not count
		late = ff.header("_test_noguard", ff.ASON_LINES) + "\n" * 50 + ff.GUARD + ff.ASON_BODY
		self.assertFalse(fh.guard_present(late))
		self.assertTrue(fh.guard_present(ff.FUNCTIONS["_test_ason"][1]))
		ff.ensure_script("wa_fn__test_noguard", script)
		listed = {e["server_script"]: e for e in fc.storefront()}["wa_fn__test_noguard"]
		self.assertFalse(listed["guarded"])
		with self.assertRaises(WAValidationError) as caught:
			fc.install("wa_fn__test_noguard")
		self.assertIn("direct URL", str(caught.exception))
		self.assertFalse(frappe.db.exists("WhatsApp Function", "_test_noguard"))

	def test_duplicate_function_key_is_an_error(self):
		script = ff.source("_test_dup", ff.ASON_LINES, ff.ASON_BODY)
		ff.ensure_script("wa_fn__test_dup_a", script)
		ff.ensure_script("wa_fn__test_dup_b", script)
		entries = {e["server_script"]: e for e in fc.discover(use_cache=False)}
		for name in ("wa_fn__test_dup_a", "wa_fn__test_dup_b"):
			self.assertIn("more than one script", entries[name]["error"])
			self.assertEqual({e["server_script"]: e for e in fc.storefront()}[name]["state"], "invalid")
		with self.assertRaises(WAValidationError):
			fc.install("wa_fn__test_dup_a")
		self.assertFalse(frappe.db.exists("WhatsApp Function", "_test_dup"))

	def test_update_keeps_values_of_surviving_params(self):
		v1 = [
			"@param  keep  | Data     | optional |  | Kept",
			"@param  gone  | Int      | optional |  | Removed later",
			"@param  msg   | Template | optional |  | Message",
			"@default msg",
			"> hi",
			"@reply  result_text | text |  | Result",
		]
		v2 = [
			"@param  keep  | Data     | optional |  | Kept",
			"@param  added | Data     | optional |  | Added",
			"@param  msg   | Template | optional |  | Message",
			"@default msg",
			"> hello",
			"@reply  result_text | text |  | Result",
		]
		ff.ensure_script("wa_fn__test_upd", ff.source("_test_upd", v1, ff.OK_BODY))
		fc.install("wa_fn__test_upd")
		fc.save_values("_test_upd", {"keep": "x", "gone": "3", "msg": {"en": "custom"}})
		self.assertEqual(fc.values_of("_test_upd"), {"keep": "x", "gone": 3, "msg": {"en": "custom"}})
		# the script's header changes: an update, seen by the daily check and the storefront
		ff.ensure_script("wa_fn__test_upd", ff.source("_test_upd", v2, ff.OK_BODY, version="1.1.0"))
		fc.check_updates()
		self.assertEqual(frappe.db.get_value("WhatsApp Function", "_test_upd", "update_available"), 1)
		self.assertEqual(
			{e["server_script"]: e for e in fc.storefront()}["wa_fn__test_upd"]["state"], "update"
		)
		d = fc.diff("wa_fn__test_upd")
		self.assertEqual((d["params"]["added"], d["params"]["removed"]), (["added"], ["gone"]))
		self.assertEqual([c["name"] for c in d["params"]["changed"]], ["msg"])
		self.assertTrue(d["changed"])
		fc.update("_test_upd")
		doc = frappe.get_doc("WhatsApp Function", "_test_upd")
		self.assertEqual((doc.installed_version, doc.update_available), ("1.1.0", 0))
		self.assertEqual(fc.values_of(doc), {"keep": "x", "msg": {"en": "custom"}})
		self.assertEqual([p["name"] for p in fc.manifest_of(doc)["params"]], ["keep", "added", "msg"])
		self.assertFalse(fc.diff("wa_fn__test_upd")["changed"])

	def test_validate_messages_drops_disabled_replies(self):
		spec = fh.parse_function_header(ff.FUNCTIONS["_test_span"][1])
		messages = [
			{"reply": "result_text", "type": "text", "text": " hi "},
			{"reply": "statement", "type": "report", "filters": {"party": "C"}},
		]
		ready = fh.validate_messages(spec, messages)
		self.assertEqual([m["reply"] for m in ready], ["result_text", "statement"])
		self.assertEqual(ready[0]["text"], "hi")
		self.assertEqual((ready[1]["report_name"], ready[1]["format"]), (ff.SPAN_REPORT, "PDF"))
		self.assertEqual(
			[m["reply"] for m in fh.validate_messages(spec, messages, disabled=["statement"])],
			["result_text"],
		)
		self.assertEqual(fh.validate_messages(spec, messages, disabled={"result_text", "statement"}), [])
		# a switched-off reply is still checked: an undeclared one fails whatever is switched off
		with self.assertRaises(ValueError):
			fh.validate_messages(spec, [*messages, {"reply": "nope", "text": "x"}], disabled=["statement"])

	# the repo's own function scripts -----------------------------------------------------------------

	def test_the_shipped_scripts_are_valid_functions(self):
		folder = os.path.realpath(frappe.get_app_path("whatsapp_next", "..", "scripts", "functions"))
		files = sorted(f for f in os.listdir(folder) if f.startswith(fh.API_PREFIX) and f.endswith(".py"))
		self.assertTrue(files)
		keys = []
		for file in files:
			with self.subTest(script=file):
				with open(os.path.join(folder, file), encoding="utf-8") as fp:
					script = fp.read()
				spec = fh.parse_function_header(script)
				self.assertTrue(fh.guard_present(script), file)
				self.assertTrue(spec["replies"], file)
				# the party is the sender's, never a value the command or the text sets (a staff
				# summary may let the command pick the party *type*, never a party)
				for p in spec["params"]:
					if p["name"] == "party":
						self.assertEqual(p["source"], "sender", f"{file}: {p['name']}")
				keys.append(spec["function"])
		self.assertEqual(len(keys), len(set(keys)), keys)
