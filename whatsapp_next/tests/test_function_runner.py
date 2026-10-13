# Unit tests for services/function_runner.py and services/report_file.py (WHATSAPP_NEXT_INTEGRATION
# §5, §6, §9): the order values are merged in, the script's run (parameters in form_dict, nothing left
# over from the request, the answer in `wa_result`), failures turned into a reply, a run's replies
# (text, report printed or shown dry), the Functions Center "Try" step by step, and a report reply
# printed to Excel / PDF. Fixture scripts only (function_fixtures.py).

from __future__ import annotations

import json
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.services import function_runner as fr
from whatsapp_next.services import functions_catalog as fc
from whatsapp_next.services import report_file
from whatsapp_next.services.function_runner import FunctionRun, Sender
from whatsapp_next.tests import function_fixtures as ff
from whatsapp_next.tests.conftest_frappe import ensure_settings


def _command(function: str, overrides: dict | None = None, templates: list[dict] | None = None, **kw):
	return frappe._dict(
		name=kw.pop("name", "tfr-draft"),
		function=function,
		settings_overrides=json.dumps(overrides) if overrides else None,
		templates=[frappe._dict(r) for r in templates or []],
		**kw,
	)


class TestFunctionRunner(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ff.drop_all()
		ensure_settings(command_service_user=ff.ensure_service_user(), command_reply_language="en")
		for key in ("_test_echo", "_test_span", "_test_misbehave"):
			ff.ensure_function(key)

	@classmethod
	def tearDownClass(cls):
		ff.drop_all()
		super().tearDownClass()

	def setUp(self):
		self._lang = frappe.local.lang
		frappe.local.lang = "en"

	def tearDown(self):
		frappe.local.lang = self._lang

	def test_spec_of(self):
		self.assertEqual(fr.spec_of("_test_echo")["function"], "_test_echo")
		self.assertEqual(fr.spec_of("_test_nope"), {})
		self.assertEqual(fr.spec_of(None), {})

	def test_merged_values_priority(self):
		fc.save_values("_test_span", {"timespan": "today", "msg_result": {"en": "site en", "": "site all"}})
		self.addCleanup(fc.save_values, "_test_span", {"timespan": "", "msg_result": ""})
		spec = fr.spec_of("_test_span")
		# the function's site value
		out = fr.merged_values(_command("_test_span"), spec, {}, "en")
		self.assertEqual((out["timespan"], out["msg_result"], out["language"]), ("today", "site en", "en"))
		self.assertEqual(fr.merged_values(_command("_test_span"), spec, {}, "ar")["msg_result"], "site all")
		# the command's override over it, the sender's value over both
		cmd = _command(
			"_test_span",
			{"timespan": "this month", "party": "IGNORED"},
			[{"param": "msg_result", "language": "en", "text": "command en"}],
		)
		out = fr.merged_values(cmd, spec, {}, "en")
		self.assertEqual((out["timespan"], out["msg_result"]), ("this month", "command en"))
		self.assertNotIn("party", out)
		self.assertEqual(
			fr.merged_values(cmd, spec, {"timespan": "select date range"}, "en")["timespan"],
			"select date range",
		)
		# the command's template in another language falls back to the function's value
		self.assertEqual(fr.merged_values(cmd, spec, {}, "ar")["msg_result"], "site all")
		# and with nothing set the header's default is used when the run is built
		fc.save_values("_test_span", {"msg_result": ""})
		sender = Sender(None, None, None, None, party_type="Customer", party_name="C-1")
		params, _missing = fr.prepare(_command("_test_span", {"language": "ar"}), sender)
		self.assertEqual((params["language"], params["msg_result"]), ("ar", "رصيد {{ party }} {{ span }}"))
		self.assertEqual(fr.run_language(_command("_test_span", {"language": "ar"})), "ar")
		self.assertEqual(fr.run_language(_command("_test_span")), "en")  # the reply language
		self.assertEqual(
			fr.disabled_replies(frappe._dict(disabled_replies="statement\n\n x ")), {"statement", "x"}
		)

	def test_run_function_reads_only_its_parameters(self):
		name = ff.FUNCTIONS["_test_echo"][0]
		spec = fr.spec_of("_test_echo")
		saved = frappe.local.form_dict
		frappe.local.form_dict = frappe._dict(text="left in the request", party="NOT-MINE")
		try:
			out = fr.run_function(name, {"msg_result": "{{ echo }}|{{ party }}"}, spec)
		finally:
			frappe.local.form_dict = saved
		self.assertEqual(out["messages"][0]["text"], "pong|")
		self.assertEqual(set(out), {"error", "messages", "data"})
		with self.assertRaises(frappe.ValidationError):  # no wa_result
			fr.run_function(
				ff.FUNCTIONS["_test_misbehave"][0], {"mode": "none"}, fr.spec_of("_test_misbehave")
			)
		frappe.clear_last_message()

	def test_execute_turns_failures_into_a_reply(self):
		run = fr.execute(_command("_test_misbehave"), {"mode": "ok"})
		self.assertTrue(run.ok)
		self.assertEqual(run.messages, [{"reply": "result_text", "type": "text", "text": "fine"}])
		run = fr.execute(_command("_test_misbehave"), {"mode": "error"})
		self.assertEqual((run.error, run.data), ("Nothing for you", {"mode": "error"}))
		before = frappe.db.count("Error Log")
		for mode in ("raise", "none"):
			run = fr.execute(_command("_test_misbehave"), {"mode": mode})
			self.assertEqual(run.error, fr.GENERIC_ERROR, mode)  # never the script's own text
		self.assertEqual(frappe.db.count("Error Log"), before + 2)
		self.assertTrue(frappe.db.exists("Error Log", {"method": ("like", "%wa_fn__test_misbehave failed%")}))
		frappe.clear_last_message()
		run = fr.execute(_command("_test_misbehave"), {"mode": "bad_reply"})
		# the sender gets the generic text; what the script did wrong is kept for the log
		self.assertEqual(run.error, fr.GENERIC_ERROR)
		self.assertIn("not declared", run.detail)
		self.assertEqual(run.messages, [])
		# a switched-off reply is dropped from the run
		run = fr.execute(_command("_test_span"), {"party": "C", "timespan": "today"}, disabled={"statement"})
		self.assertEqual([m["reply"] for m in run.messages], ["result_text"])
		self.assertEqual(fr.execute(_command("_test_nope"), {}).error, "Function is inactive")

	def test_replies_of(self):
		self.assertEqual(
			fr.replies_of(FunctionRun(error="no")),
			[{"output_key": "error", "message_type": "Text", "body": "no", "attachment": None}],
		)
		report = {
			"reply": "statement",
			"type": "report",
			"report_name": "Some Report",
			"filters": {"a": 1},
			"format": "Excel",
			"file_name": "out",
			"caption": "here",
		}
		run = FunctionRun(messages=[{"reply": "result_text", "type": "text", "text": "hi"}, report])
		dry = fr.replies_of(run, dry_run=True)
		self.assertEqual(
			[(r["output_key"], r["message_type"]) for r in dry],
			[("result_text", "Text"), ("statement", "Document")],
		)
		self.assertEqual((dry[1]["attachment"], dry[1]["body"], dry[1]["filters"]), (None, "here", {"a": 1}))
		with patch(
			"whatsapp_next.services.report_file.render_report_file",
			return_value=("out.xlsx", b"PK-bytes", "application/x"),
		):
			live = fr.replies_of(run)
		self.assertEqual(
			(live[1]["file_name"], live[1]["mime_type"], live[1]["body"]),
			("out.xlsx", "application/x", "here"),
		)
		self.assertTrue(live[1]["attachment"])
		for file in frappe.get_all("File", filters={"file_url": live[1]["attachment"]}, pluck="name"):
			self.addCleanup(frappe.delete_doc, "File", file, force=True, ignore_permissions=True)
		with patch("whatsapp_next.services.report_file.render_report_file", side_effect=RuntimeError("x")):
			failed = fr.replies_of(run)
		self.assertEqual((failed[1]["message_type"], failed[1]["body"]), ("Text", fr.GENERIC_ERROR))

	def test_trial_steps(self):
		ok = fr.trial("_test_echo", values={"text": "hi"})
		self.assertEqual(
			[s["name"] for s in ok["steps"]],
			[
				"Header",
				"Requirements (@requires)",
				"Party type (@party_types)",
				"Parameters",
				"Run",
				"Replies (@reply)",
			],
		)
		self.assertEqual(ok["messages"][0]["text"], "pong: hi")
		self.assertEqual(ok["params"]["text"], "hi")
		self.assertEqual(frappe.session.user, "Administrator")
		# missing values stop before the run
		out = fr.trial(
			"_test_span", party_type="Customer", party=None, values={"timespan": "select date range"}
		)
		self.assertEqual(out["steps"][-1]["name"], "Parameters")
		self.assertFalse(out["steps"][-1]["ok"])
		self.assertEqual({m["name"] for m in out["missing"]}, {"party", "from_date", "to_date"})
		# a party that does not exist
		out = fr.trial("_test_span", party_type="Customer", party="_No Such WA Customer")
		self.assertEqual((out["steps"][-1]["name"], out["steps"][-1]["ok"]), ("Party", False))
		# the script's error and an undeclared reply
		out = fr.trial("_test_misbehave", values={"mode": "error"})
		self.assertEqual((out["steps"][-1]["name"], out["error"]), ("Run", "Nothing for you"))
		out = fr.trial("_test_misbehave", values={"mode": "raise"})
		self.assertFalse(out["steps"][-1]["ok"])
		self.assertIn("boom", out["steps"][-1]["detail"])
		out = fr.trial("_test_misbehave", values={"mode": "bad_reply"})
		self.assertEqual((out["steps"][-1]["name"], out["steps"][-1]["ok"]), ("Replies (@reply)", False))
		# a header changed on the script but not updated: the installed one is used, and said so
		name, script = ff.FUNCTIONS["_test_echo"]
		ff.ensure_script(name, script.replace("@version      1.0.0", "@version      1.0.1"))
		out = fr.trial("_test_echo")
		self.assertIn("Installed header", [s["name"] for s in out["steps"]])
		self.assertTrue(out["steps"][-1]["ok"])
		ff.ensure_script(name, script)


class TestReportFile(IntegrationTestCase):
	COLUMNS = [
		{"fieldname": "party", "label": "Party", "fieldtype": "Data"},
		{"fieldname": "secret", "label": "Hidden", "hidden": 1},
		"Balance:Currency/currency:120",
	]
	ROWS = [{"party": "A", "secret": "x", "balance": 5}, ["B", "y", 7], "a stray string"]

	def test_columns(self):
		cols = report_file._columns(self.COLUMNS)
		self.assertEqual(
			[(c["fieldname"], c["fieldtype"], c["index"]) for c in cols],
			[("party", "Data", 0), ("balance", "Currency", 2)],
		)
		self.assertEqual(report_file._cell(["B", "y", 7], cols[1]), 7)
		self.assertEqual(report_file._cell({"balance": 5}, cols[1]), 5)
		self.assertIsNone(report_file._cell(["B"], cols[1]))

	def test_render(self):
		raw = {"columns": self.COLUMNS, "result": self.ROWS}
		msg = {"report_name": "Some Report", "filters": {"a": 1}, "format": "Excel", "file_name": "statement"}
		with patch("frappe.desk.query_report.run", return_value=raw) as run:
			name, content, mime = report_file.render_report_file(msg)
		run.assert_called_once_with("Some Report", filters={"a": 1})
		self.assertEqual((name, mime), ("statement.xlsx", report_file.MIME["Excel"]))
		self.assertTrue(content.startswith(b"PK"))
		with (
			patch("frappe.desk.query_report.run", return_value=raw),
			patch("frappe.utils.pdf.get_pdf", return_value=b"%PDF") as pdf,
		):
			name, content, mime = report_file.render_report_file(
				{**msg, "format": "PDF", "file_name": "s.pdf"}
			)
		self.assertEqual((name, content, mime), ("s.pdf", b"%PDF", "application/pdf"))
		html = pdf.call_args.args[0]
		self.assertIn("<th>Party</th>", html)
		self.assertNotIn("Hidden", html)
		with self.assertRaises(frappe.ValidationError):
			report_file.render_report_file({**msg, "format": "Word"})
		frappe.clear_last_message()
