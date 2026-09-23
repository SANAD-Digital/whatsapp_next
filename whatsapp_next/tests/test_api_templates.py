# Tests for api/v1/templates.py (build order B-25): role gate, preview from body / saved template
# with sample context and a real record, variable hints, sample picker.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import templates as api
from whatsapp_next.exceptions import WAPermissionError
from whatsapp_next.tests.conftest_frappe import ROLE_USERS, as_user, delete_all

TEMPLATE = "ApiTest Template"


class TestApiTemplates(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls._clean()
		frappe.get_doc(
			{
				"doctype": "WhatsApp Template",
				"template_name": TEMPLATE,
				"message_type": "Text",
				"body": "Hi {{ recipient.display_name }}: {{ doc.description }}",
				"reference_doctype": "ToDo",
				"sample_context": '{"doc": {"description": "sample-desc"}}',
			}
		).insert(ignore_permissions=True)
		cls.todo = frappe.get_doc({"doctype": "ToDo", "description": "ApiTest todo body"}).insert(
			ignore_permissions=True
		)
		# ToDo rows are readable by their owner / assignee only: hand it to the Agent test user
		agent = ROLE_USERS["WhatsApp Agent"]
		frappe.db.set_value("ToDo", cls.todo.name, {"owner": agent, "assigned_by": agent})

	@classmethod
	def tearDownClass(cls):
		cls._clean()
		super().tearDownClass()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Template", {"template_name": TEMPLATE})
		delete_all("ToDo", {"description": ("like", "ApiTest todo%")})

	def test_role_gate(self):
		with as_user("WhatsApp Viewer"), self.assertRaises(WAPermissionError):
			api.preview(body="x")
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.list_variables(reference_doctype="ToDo")
		with as_user("WhatsApp Agent"):
			self.assertEqual(api.preview(body="plain")["body"], "plain")

	def test_preview(self):
		with as_user("WhatsApp Agent"):
			out = api.preview(
				body="A {{ doc.description }}", reference_doctype="ToDo", reference_name=self.todo.name
			)
			self.assertEqual(out, {"body": "A ApiTest todo body", "errors": []})
			out = api.preview(template=TEMPLATE)  # saved body + its sample_context overlay
			self.assertEqual(out["errors"], [])
			self.assertTrue(out["body"].startswith("Hi Recipient: "))
			out = api.preview(
				body="X {{ doc.description }}",
				reference_doctype="ToDo",
				sample_context='{"doc": {"description": "ovr"}}',
			)
			self.assertEqual(out["body"], "X ovr")
			bad = api.preview(body="{{ doc.x ")
			self.assertEqual(bad["body"], "")
			self.assertEqual(len(bad["errors"]), 1)
			runtime = api.preview(body="{{ 1 / 0 }}")
			self.assertIn("ZeroDivisionError", runtime["errors"][0])

	def test_variables_and_sample(self):
		with as_user("WhatsApp Manager"):
			rows = api.list_variables(reference_doctype="ToDo")
			by_name = {r["name"]: r for r in rows}
			self.assertIn("doc", by_name)
			self.assertEqual(by_name["doc.description"]["fieldtype"], "Text Editor")
			self.assertEqual(set(rows[0]), {"name", "label", "fieldtype"})
			# ToDo rows are visible to their owner / assignee only: the Manager gets no sample ...
			self.assertEqual(api.pick_sample(reference_doctype="ToDo"), {"name": None})
			self.assertEqual(api.pick_sample(reference_doctype="No Such DocType"), {"name": None})
		with as_user("WhatsApp Agent"):  # ... the owner gets the latest one
			self.assertEqual(api.pick_sample(reference_doctype="ToDo")["name"], self.todo.name)
