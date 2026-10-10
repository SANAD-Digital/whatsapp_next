# Tests for api/v1/templates.py (build order B-25): role gate, preview from body / saved template
# with sample context and a real record, variable hints, sample picker; and the editor window's
# open / save / rename / conflict / delete.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import templates as api
from whatsapp_next.exceptions import WAPermissionError, WAValidationError
from whatsapp_next.tests.conftest_frappe import ROLE_USERS, as_user, delete_all

TEMPLATE = "ApiTest Template"
EDITED = "ApiTest Editor Template"


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
		delete_all("WhatsApp Template", {"template_name": ("like", "ApiTest %")})
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

	def test_preview_without_a_record_never_shows_one_the_user_cannot_read(self):
		hidden = frappe.get_doc({"doctype": "ToDo", "description": "ApiTest todo hidden"}).insert(
			ignore_permissions=True
		)
		frappe.db.set_value("ToDo", hidden.name, {"owner": "Administrator", "assigned_by": "Administrator"})
		with as_user("WhatsApp Agent"):
			out = api.preview(body="{{ doc.description }}", reference_doctype="ToDo")
		self.assertNotIn("hidden", out["body"])
		# the Manager reads no ToDo at all: the fields print nothing, never "None"
		with as_user("WhatsApp Manager"):
			out = api.preview(body="[{{ doc.description }}]", reference_doctype="ToDo")
		self.assertEqual(out["body"], "[]")

	def test_preview_of_a_saved_template_against_a_record(self):
		# the saved `sample_context` is JSON text: it must not break the real-record preview, and its
		# `doc` never replaces the record
		with as_user("WhatsApp Agent"):
			out = api.preview(template=TEMPLATE, reference_name=self.todo.name)
		self.assertEqual(out, {"body": "Hi Recipient: ApiTest todo body", "errors": []})

	def test_preview_hides_fields_above_the_callers_permission_level(self):
		from frappe.custom.doctype.property_setter.property_setter import make_property_setter

		# a Property Setter the site already had is restored afterwards, never deleted (WN-002)
		ps_filters = {"doc_type": "ToDo", "field_name": "description", "property": "permlevel"}
		before = frappe.db.get_value("Property Setter", ps_filters, ["name", "value"], as_dict=True)
		make_property_setter("ToDo", "description", "permlevel", "1", "Int", validate_fields_for_doctype=False)
		frappe.clear_cache(doctype="ToDo")
		try:
			with as_user("WhatsApp Agent"):
				out = api.preview(
					body="A {{ doc.description }}", reference_doctype="ToDo", reference_name=self.todo.name
				)
				self.assertEqual(out["body"], "A")
				out = api.preview(body="B {{ doc.description }}", reference_doctype="ToDo")
				self.assertEqual(out["body"], "B")
		finally:
			if before:
				frappe.db.set_value("Property Setter", before.name, "value", before.value)
			else:
				frappe.db.delete("Property Setter", ps_filters)
			frappe.clear_cache(doctype="ToDo")

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

	def test_editor_opens_read_only_for_an_agent(self):
		with as_user("WhatsApp Agent"):
			out = api.get_editor(name=TEMPLATE)
			self.assertEqual(out["template"]["name"], TEMPLATE)
			self.assertFalse(out["can_write"])
			self.assertFalse(out["can_delete"])
			self.assertIn("Text", out["message_types"])
			with self.assertRaises(WAPermissionError):
				api.save_editor(payload={"name": TEMPLATE, "template_name": TEMPLATE, "body": "x"})

	def test_editor_create_rename_conflict_delete(self):
		with as_user("WhatsApp Manager"):
			blank = api.get_editor()
			self.assertIsNone(blank["template"]["name"])
			self.assertEqual(blank["template"]["message_type"], "Text")

			created = api.save_editor(
				payload={
					"template_name": EDITED,
					"message_type": "Text",
					"body": "Hi {{ doc.description }}",
					"category": " ApiTest ",
					# a field outside the allow-list is ignored, never written
					"use_count": 99,
					# what a Text message cannot carry is cleared
					"print_format": "Standard",
				}
			)
			self.assertEqual(created["name"], EDITED)
			row = frappe.db.get_value(
				"WhatsApp Template", EDITED, ["category", "use_count", "print_format"], as_dict=True
			)
			self.assertEqual(row.category, "ApiTest")
			self.assertEqual(row.use_count or 0, 0)
			self.assertIsNone(row.print_format)

			with self.assertRaises(WAValidationError):  # the name is taken
				api.save_editor(payload={"template_name": EDITED, "body": "x"})
			with self.assertRaises(WAValidationError):  # a body that does not compile
				api.save_editor(payload={"name": EDITED, "template_name": EDITED, "body": "{{ doc.x "})

			opened = api.get_editor(name=EDITED)["template"]["modified"]
			frappe.db.set_value(
				"WhatsApp Template", EDITED, "description", "saved elsewhere", update_modified=True
			)
			with self.assertRaises(WAValidationError):  # somebody saved it since the window opened
				api.save_editor(
					payload={"name": EDITED, "modified": opened, "template_name": EDITED, "body": "stale"}
				)

			fresh = api.get_editor(name=EDITED)["template"]["modified"]
			renamed = api.save_editor(
				payload={"name": EDITED, "modified": fresh, "template_name": f"{EDITED} 2", "body": "Hi"}
			)
			self.assertEqual(renamed["name"], f"{EDITED} 2")
			self.assertFalse(frappe.db.exists("WhatsApp Template", EDITED))

			self.assertEqual(api.delete_template(name=f"{EDITED} 2"), {"deleted": True})
			self.assertFalse(frappe.db.exists("WhatsApp Template", f"{EDITED} 2"))
