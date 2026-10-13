# Unit tests for services/function_header.py (WHATSAPP_NEXT_INTEGRATION §2, §11): the WA-FUNCTION
# parser and its errors with line numbers, `@requires`, `@party_types`, the parameter groups, `@var`,
# `build_params` (sender's party, defaults, templates by language, depends_on, types, missing),
# date words and default symbols, and the header checksum.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_days, get_first_day, get_year_start, getdate, nowdate

from whatsapp_next.services import function_header as fh
from whatsapp_next.services.function_runner import Sender
from whatsapp_next.tests import function_fixtures as ff


def _spec(key: str) -> dict:
	return fh.parse_function_header(ff.FUNCTIONS[key][1])


class TestFunctionHeader(IntegrationTestCase):
	def setUp(self):
		self._lang = frappe.local.lang
		frappe.local.lang = "en"

	def tearDown(self):
		frappe.local.lang = self._lang

	def _error(self, lines: list[str], *, key: str = "_test_x") -> str:
		with self.assertRaises(fh.HeaderError) as caught:
			fh.parse_function_header(ff.header(key, lines))
		return str(caught.exception)

	def test_parse(self):
		spec = _spec("_test_span")
		self.assertEqual(
			(spec["function"], spec["title"], spec["version"]), ("_test_span", "Test Span", "1.0.0")
		)
		self.assertEqual(spec["party_types"], {"mode": "only", "types": ["Customer"]})
		timespan = fh.param(spec, "timespan")
		self.assertEqual(
			(timespan["fieldtype"], timespan["default"], timespan["select_options"], timespan["source"]),
			("Select", "this month", ["today", "this month", "select date range"], "command"),
		)
		self.assertEqual(
			fh.param(spec, "from_date")["depends_on"], {"param": "timespan", "value": "select date range"}
		)
		self.assertEqual(fh.param(spec, "party")["fieldtype"], "Dynamic")
		self.assertEqual(fh.param(spec, "party")["options"], "party_type")
		msg = fh.param(spec, "msg_result")
		self.assertEqual(msg["default"], "رصيد {{ party }} {{ span }}")
		self.assertEqual(msg["defaults_by_lang"], {"en": "Balance of {{ party }} {{ span }}"})
		self.assertEqual(
			[(r["key"], r["type"], r["report_name"], r["format"]) for r in spec["replies"]],
			[("result_text", "text", None, None), ("statement", "report", ff.SPAN_REPORT, "PDF")],
		)
		self.assertEqual([v["name"] for v in spec["vars"]], ["party", "span"])
		self.assertIsNone(fh.param(spec, "nope"))
		# a multi-line default keeps its lines; `@var` with two columns is for every message
		spec = fh.parse_function_header(
			ff.header(
				"_test_x",
				["@param m | Template | optional | | M", "@default m", "> one", ">   two", "@var v | Value"],
			)
		)
		self.assertEqual(fh.param(spec, "m")["default"], "one\n  two")
		self.assertEqual(spec["vars"], [{"name": "v", "label": "Value", "messages": ["all"]}])

	def test_party_types_rules(self):
		for value, rule in (
			("all", {"mode": "all", "types": []}),
			("All except Supplier, Employee", {"mode": "except", "types": ["Supplier", "Employee"]}),
			("Customer, Supplier", {"mode": "only", "types": ["Customer", "Supplier"]}),
		):
			spec = fh.parse_function_header(ff.header("_test_x", [], party_types=value))
			self.assertEqual(spec["party_types"], rule, value)
		only = {"party_types": {"mode": "only", "types": ["Customer"]}}
		self.assertTrue(fh.party_type_allowed(only, "Customer"))
		self.assertFalse(fh.party_type_allowed(only, "Supplier"))
		self.assertFalse(fh.party_type_allowed(only, None))
		except_ = {"party_types": {"mode": "except", "types": ["Supplier"]}}
		self.assertTrue(fh.party_type_allowed(except_, "Customer"))
		self.assertFalse(fh.party_type_allowed(except_, "Supplier"))
		self.assertFalse(fh.party_type_allowed(except_, None))
		self.assertTrue(fh.party_type_allowed({}, None))
		self.assertEqual(
			fh.party_types_text({"party_types": {"mode": "except", "types": ["Supplier"]}}),
			"All except Supplier",
		)
		self.assertEqual(fh.party_types_text({}), "All")

	def test_errors_name_their_line(self):
		cases = (
			(["@param  x | Data | maybe |  | X"], "required or optional"),
			(["@param  x | Data | optional | X"], "5 columns"),
			(["@param  x | Money | optional |  | X"], "Unknown field type"),
			(["@param  x | Data | optional | source=client | X"], "source is sender or command"),
			(["@param  x | Data | optional | nokey | X"], "Invalid option"),
			(["@param  x | Data | optional |  | X", "@param  x | Int | optional |  | X"], "declared twice"),
			(["@param  x | Data | optional | depends_on=y:1 | X"], "not declared before it"),
			(["@param  x | Data | optional | depends_on=y | X"], "depends_on takes"),
			(["@options y | a, b"], "@options for a parameter not declared"),
			(["@default y"], "@default for a parameter not declared"),
			(["> stray"], "without an @default"),
			(["@requires table | Foo"], "@requires takes"),
			(["@reply r | text"], "@reply takes"),
			(["@reply r | report |  | R"], "report=<report name>"),
			(["@nope x"], "Unknown tag"),
			(["just words"], "Unreadable header line"),
		)
		for lines, message in cases:
			with self.subTest(lines=lines):
				error = self._error(lines)
				self.assertIn(message, error)
				self.assertIn(f"(line {5 + len(lines)})", error)
		# errors about the whole header
		self.assertIn("Select without @options", self._error(["@param  x | Select | optional |  | X"]))
		self.assertIn("declared twice", self._error(["@reply r | text | | R", "@reply r | text | | R2"]))
		with self.assertRaises(fh.HeaderError):
			fh.parse_function_header("x = 1\n")
		with self.assertRaises(fh.HeaderError):
			fh.parse_function_header("# WA-FUNCTION\n# @function a\nx = 1\n")  # code inside the header
		with self.assertRaises(fh.HeaderError):
			fh.parse_function_header("# WA-FUNCTION\n# @function a\n")  # no end
		with self.assertRaises(fh.HeaderError):
			fh.parse_function_header("# END WA-FUNCTION\n")
		with self.assertRaises(fh.HeaderError):
			fh.parse_function_header("# WA-FUNCTION\n# @title t\n# END WA-FUNCTION\n")  # no @function

	def test_requires(self):
		spec = fh.parse_function_header(
			ff.header(
				"_test_x",
				[
					"@requires report | _Test WA No Report",
					"@requires doctype | ToDo",
					"@requires app | frappe",
				],
			)
		)
		available, reasons = fh.function_availability(spec)
		self.assertFalse(available)
		self.assertEqual(len(reasons), 1)
		self.assertIn("_Test WA No Report", reasons[0])
		self.assertEqual(
			fh.function_availability(
				{"requires": [{"kind": "doctype", "name": "_Nope WA"}, {"kind": "app", "name": "_nope_app"}]}
			)[1].__len__(),
			2,
		)
		self.assertEqual(fh.function_availability({}), (True, []))

	def test_parameter_groups_and_vars(self):
		spec = _spec("_test_echo")
		self.assertEqual([p["name"] for p in fh.command_params(spec)], ["text", "msg_result"])
		self.assertEqual(
			[p["name"] for p in fh.typed_params(spec)], ["text"]
		)  # never the party, never a template
		self.assertEqual([v["name"] for v in fh.vars_for(spec, "msg_result")], ["echo", "party"])
		self.assertEqual([v["name"] for v in fh.vars_for(spec, "other")], ["party"])

	def test_build_params(self):
		spec = _spec("_test_span")
		customer = Sender("+966500000001", None, None, None, party_type="Customer", party_name="CUST-1")
		params, missing = fh.build_params(spec, customer, {"party": "OTHER", "party_type": "Supplier"}, "en")
		self.assertEqual((params["party_type"], params["party"]), ("Customer", "CUST-1"))
		self.assertEqual((params["timespan"], params["language"]), ("this month", "en"))
		self.assertNotIn("from_date", params)  # depends_on does not hold: left out, not missing
		self.assertEqual(params["msg_result"], "Balance of {{ party }} {{ span }}")
		self.assertEqual(missing, [])
		# the run's own language parameter picks the template's language
		params, _m = fh.build_params(spec, customer, {"language": "ar"}, "en")
		self.assertEqual(params["msg_result"], "رصيد {{ party }} {{ span }}")
		# a date range needs both dates
		params, missing = fh.build_params(
			spec, customer, {"timespan": "Select Date Range", "from_date": "2026-01-01"}, "en"
		)
		self.assertEqual((params["timespan"], params["from_date"]), ("select date range", "2026-01-01"))
		self.assertEqual([(m["name"], m["source"]) for m in missing], [("to_date", "command")])
		# no party: the sender's parameters are missing
		_p, missing = fh.build_params(spec, Sender(None, None, None, None), {}, "en")
		self.assertEqual([m["name"] for m in missing if m["source"] == "sender"], ["party_type", "party"])
		# wrong values
		with self.assertRaises(ValueError):
			fh.build_params(spec, customer, {"timespan": "forever"}, "en")
		with self.assertRaises(ValueError):
			fh.build_params(
				spec,
				customer,
				{"timespan": "select date range", "from_date": "not a date", "to_date": "today"},
				"en",
			)
		typed = _spec("_test_typed")
		with self.assertRaises(ValueError):
			fh.build_params(typed, customer, {"doc_name": "X", "days": "7.5"})
		params, _m = fh.build_params(typed, customer, {"doc_name": " X ", "days": "-2", "since": "-1d"})
		self.assertEqual(
			(params["doc_name"], params["days"], params["since"]),
			("X", -2, str(add_days(getdate(nowdate()), -1))),
		)

	def test_coerce(self):
		check = {"fieldtype": "Check", "label": "C"}
		self.assertEqual([fh.coerce(check, v) for v in ("1", "yes", "نعم", "0", "no")], [1, 1, 1, 0, 0])
		link = {"fieldtype": "Link", "options": "Language", "label": "L"}
		self.assertEqual(fh.coerce(link, " en "), "en")
		with self.assertRaises(ValueError):
			fh.coerce(link, "_no_such_language")
		template = {"fieldtype": "Template", "label": "T"}
		self.assertEqual(fh.coerce(template, {"en": "x"}), {"en": "x"})

	def test_dates_and_defaults(self):
		today = getdate(nowdate())
		self.assertEqual(fh.resolve_date("today"), today)
		self.assertEqual(fh.resolve_date("أمس"), add_days(today, -1))
		self.assertEqual(fh.resolve_date("month_start"), get_first_day(today))
		self.assertEqual(fh.resolve_date("year_start"), get_year_start(today))
		self.assertEqual(fh.resolve_date("week_start").weekday(), 5)  # the week starts on Saturday
		self.assertEqual(fh.resolve_date("3d"), add_days(today, 3))
		self.assertEqual(fh.resolve_date("2026-01-31"), getdate("2026-01-31"))
		self.assertEqual(fh.resolve_default("@system_language", {}, "ar"), "ar")
		self.assertEqual(fh.resolve_default("@param:a", {"a": 5}), 5)
		self.assertEqual(fh.resolve_default("plain", {}), "plain")
		self.assertEqual(
			fh.resolve_default("@default_company", {}),
			frappe.db.get_single_value("Global Defaults", "default_company"),
		)
		self.assertEqual(fh.template_default({"default": "d", "defaults_by_lang": {"en": "e"}}, "en-US"), "e")
		self.assertEqual(fh.template_default({"default": "d", "defaults_by_lang": {}}, None), "d")
		self.assertTrue(fh.is_empty("  "))
		self.assertFalse(fh.is_empty(0))

	def test_checksum_is_the_headers(self):
		script = ff.FUNCTIONS["_test_echo"][1]
		self.assertEqual(fh.header_checksum(script), fh.header_checksum(script + "\nx = 2\n"))
		self.assertNotEqual(fh.header_checksum(script), fh.header_checksum(script.replace("1.0.0", "1.0.1")))
		self.assertTrue(fh.header_text(script).startswith("@function"))
