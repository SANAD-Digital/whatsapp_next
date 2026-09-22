# Tests for services/templates.py and services/polls.py (build order B-9): sandboxed render,
# compile check, context building, variable hints; the single poll option parser, validation
# and result extraction across the payload shapes the platform has used.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.exceptions import WAValidationError
from whatsapp_next.services import polls, templates
from whatsapp_next.tests.fake_provider import FakeProvider


class TestTemplates(IntegrationTestCase):
	def test_render_ok_and_errors_not_raised(self):
		r = templates.render(
			"Hello {{ doc.first_name }} / {{ recipient.display_name }}",
			{"doc": {"first_name": "A"}, "recipient": {"display_name": "B"}},
		)
		self.assertTrue(r.ok)
		self.assertEqual(r.text, "Hello A / B")
		bad = templates.render("{{ doc.x ", {})
		self.assertFalse(bad.ok)
		self.assertIn("TemplateSyntaxError", bad.error)
		self.assertEqual(bad.text, "")
		self.assertEqual(templates.render_text("{{ doc.x ", {}, fallback="fb"), "fb")
		self.assertEqual(templates.render("", {}).text, "")
		with self.assertRaises(WAValidationError):
			templates.render("{{ doc.x ", {}, strict=True)

	def test_sandbox_blocks_dunder(self):
		r = templates.render("{{ ''.__class__ }}", {})
		self.assertFalse(r.ok)
		r = templates.render("{{ doc.__class__.__mro__ }}", {"doc": frappe._dict()})
		self.assertFalse(r.ok)

	def test_compile_check(self):
		self.assertEqual(templates.compile_check("ok {{ doc.name }}"), [])
		self.assertEqual(templates.compile_check(""), [])
		errors = templates.compile_check("{% if %}")
		self.assertEqual(len(errors), 1)

	def test_context_for_and_variables(self):
		ctx = templates.context_for("Role", "System Manager", {"extra": 1}, recipient={"phone_e164": "+9665"})
		self.assertEqual(ctx["doc"].name, "System Manager")
		self.assertEqual(ctx["recipient"].phone_e164, "+9665")
		self.assertEqual(ctx["extra"], 1)
		self.assertTrue(ctx["doc_url"].endswith("/role/System%20Manager"))
		self.assertEqual(
			templates.render("{{ _('Role') }}|{{ frappe.utils.nowdate()[:2] }}", ctx).text, "Role|20"
		)
		missing = templates.context_for("Role", "no-such-role")
		self.assertEqual(missing["doc"], {})
		hints = templates.variables("Role")
		self.assertIn("doc.role_name", hints)
		self.assertIn("recipient", hints)
		self.assertEqual(templates.variables(None)[:2], ["doc", "recipient"])
		self.assertEqual(
			templates.referenced_names("{{ doc.a }} {{doc.b}} {{ recipient.x }}"), ["doc", "recipient"]
		)

	def test_sample_context(self):
		ctx = templates.sample_context("Role", '{"doc": {"role_name": "Sample"}, "code": "X1"}')
		self.assertEqual(ctx["doc"]["role_name"], "Sample")
		self.assertEqual(ctx["code"], "X1")
		self.assertIn("recipient", ctx)
		self.assertEqual(templates.sample_context(None, "not json")["doc"], {})


class TestPolls(IntegrationTestCase):
	def test_parse_options_all_shapes(self):
		self.assertEqual(polls.parse_options('["A", "B", " b ", "", "C"]'), ["A", "B", "C"])
		self.assertEqual(polls.parse_options("A\nB, C,,\n a"), ["A", "B", "C"])
		self.assertEqual(polls.parse_options(["x", 1, None, "X"]), ["x", "1"])
		self.assertEqual(polls.parse_options(None), [])
		self.assertEqual(polls.parse_options("   "), [])
		self.assertEqual(polls.parse_options('{"not": "list"}'), ['{"not": "list"}'])
		self.assertEqual(polls.to_json("a, b"), '["a", "b"]')

	def test_validate(self):
		p = polls.validate("Q?", "yes, no", 1)
		self.assertEqual((p.question, p.options, p.allow_multiple), ("Q?", ("yes", "no"), True))
		for q, o in (
			("", "a,b"),
			("Q", "a"),
			("Q", "a,A"),
			("Q", ",".join(f"o{i}" for i in range(13))),
			("Q", "a," + "x" * 101),
		):
			with self.assertRaises(WAValidationError):
				polls.validate(q, o)

	def test_extract_selected_shapes(self):
		opts = ["Red", "Green", "Blue"]
		self.assertEqual(polls.extract_selected({"selected_options": ["Blue", "red"]}, opts), ["Red", "Blue"])
		self.assertEqual(
			polls.extract_selected(
				{"options": [{"name": "Green", "vote_count": 2}, {"name": "Red", "voteCount": 0}]}, opts
			),
			["Green"],
		)
		self.assertEqual(
			polls.extract_selected(
				{"options": [{"id": "1", "text": "Blue"}], "votes": [{"option_id": "1"}]}, opts
			),
			["Blue"],
		)
		self.assertEqual(polls.extract_selected({"answers": [{"option": "Purple"}]}, opts), ["Purple"])
		self.assertEqual(
			polls.extract_selected(
				{"options": [{"label": "Red", "selected": "true"}, {"label": "Blue", "selected": False}]},
				opts,
			),
			["Red"],
		)
		self.assertEqual(polls.extract_selected({"votes": []}, opts), [])
		self.assertEqual(polls.extract_selected(None, opts), [])

	def test_fetch_results_aggregates_and_records_errors(self):
		class Provider(FakeProvider):
			def get_poll_results(self, platform_device, poll_ids):
				out = {}
				for p in poll_ids:
					if p == "p3":
						out[p] = {"error": "boom"}
					elif p != "p4":
						out[p] = {"selected_options": ["Yes"] if p == "p1" else ["No", "Yes"]}
				return out

		res = polls.fetch_results("WAD-1", ["p1", "p2", "p3", "p4", "p1"], ["Yes", "No"], provider=Provider())
		self.assertEqual(res.counts, {"Yes": 2, "No": 1})
		self.assertEqual((res.responses, res.errors), (2, 2))
		self.assertEqual(res.by_poll_id["p3"]["error"], "boom")
		self.assertIn("no result", res.by_poll_id["p4"]["error"])
		self.assertEqual(
			res.as_dict()["counts"], [{"option": "Yes", "count": 2}, {"option": "No", "count": 1}]
		)

		class Raising(FakeProvider):
			def get_poll_results(self, platform_device, poll_ids):
				raise RuntimeError("down")

		res = polls.fetch_results("WAD-1", ["p1"], ["Yes"], provider=Raising())
		self.assertEqual(res.errors, 1)
		self.assertIn("down", res.by_poll_id["p1"]["error"])
