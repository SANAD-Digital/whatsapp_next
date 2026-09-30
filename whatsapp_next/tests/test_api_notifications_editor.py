# Tests for the notification editor window's endpoints in api/v1/notifications.py
# (`services/notifications_editor.py`): defaults, a draft tried on a record without writing,
# template vs written text, save / rename, the payload allow-list and the role gate.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import notifications as api
from whatsapp_next.exceptions import WAPermissionError, WAValidationError
from whatsapp_next.services import notifications as svc
from whatsapp_next.tests.conftest_frappe import as_user, delete_all, ensure_device, ensure_settings

NAME = "ApiTest Notif Editor"
RENAMED = "ApiTest Notif Editor 2"
TEMPLATE = "ApiTest Notif Editor Template"
PHONE = "+966500930301"


class TestApiNotificationsEditor(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("ApiTest NotifEd Device", "WAD-APITEST-NE", phone="+966500930300")
		ensure_settings(send_only_to_known_numbers=0)

	def setUp(self):
		self._clean()
		self.todo = frappe.get_doc({"doctype": "ToDo", "description": "apitest notifed body"}).insert(ignore_permissions=True)
		frappe.get_doc(
			{"doctype": "WhatsApp Template", "template_name": TEMPLATE, "reference_doctype": "ToDo", "body": "tpl {{ doc.description }}"}
		).insert(ignore_permissions=True)

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Notification", {"notification_name": ("in", [NAME, RENAMED])})
		delete_all("WhatsApp Template", {"template_name": TEMPLATE})
		delete_all("ToDo", {"description": ("like", "apitest notifed%")})
		svc.clear_cache()

	def _payload(self, **kw):
		p = {
			"notification_name": NAME,
			"enabled": 1,
			"document_type": "ToDo",
			"event": "New",
			"device": self.device,
			"message": "hi {{ doc.description }}",
			"recipients": [{"recipient_type": "Fixed Number", "phone": PHONE}],
		}
		p.update(kw)
		return p

	def test_new_defaults(self):
		r = api.get_editor()
		self.assertIsNone(r["notification"]["name"])
		self.assertIn("Submit", r["options"]["event"])
		self.assertIn("on_update", r["options"]["method"])

	def test_document_setup_lists_its_templates_first(self):
		r = api.get_document_setup(document_type="ToDo")
		self.assertTrue(r["fields"]["all_fields"])
		self.assertEqual(r["templates"][0]["name"], TEMPLATE)

	def test_preview_written_text_and_template(self):
		r = api.preview_draft(payload=self._payload(), reference_name=self.todo.name)
		self.assertIsNone(r["problem"])
		self.assertTrue(r["meets_condition"])
		self.assertEqual(r["message"], "hi apitest notifed body")
		self.assertEqual(r["recipients_count"], 1)
		self.assertNotIn(PHONE, str(r["recipients"]))  # masked
		r = api.preview_draft(payload=self._payload(template=TEMPLATE, message=None), reference_name=self.todo.name)
		self.assertEqual(r["message"], "tpl apitest notifed body")

	def test_preview_reports_the_problem_and_writes_nothing(self):
		r = api.preview_draft(payload=self._payload(message="", recipients=[]))
		self.assertTrue(r["problem"])
		self.assertFalse(frappe.db.exists("WhatsApp Notification", NAME))

	def test_save_then_rename(self):
		r = api.save_editor(payload=self._payload())
		self.assertEqual(r["name"], NAME)
		r = api.save_editor(payload=self._payload(name=NAME, notification_name=RENAMED, template=TEMPLATE, message=None))
		self.assertEqual(r["name"], RENAMED)
		self.assertEqual(frappe.db.get_value("WhatsApp Notification", RENAMED, "template"), TEMPLATE)

	def test_unknown_payload_key_refused(self):
		with self.assertRaises(WAValidationError):
			api.save_editor(payload=self._payload(owner="x"))

	def test_filters_condition(self):
		match = [["ToDo", "status", "=", "Open"]]
		miss = [["ToDo", "status", "=", "Closed"]]
		r = api.preview_draft(payload=self._payload(condition_type="Filters", filters=match), reference_name=self.todo.name)
		self.assertIsNone(r["problem"])
		self.assertTrue(r["meets_condition"])
		r = api.preview_draft(payload=self._payload(condition_type="Filters", filters=miss), reference_name=self.todo.name)
		self.assertFalse(r["meets_condition"])
		# saved as Frappe's Notification stores it; the Python condition is cleared
		api.save_editor(payload=self._payload(condition_type="Filters", filters=match, condition="doc.name"))
		saved = frappe.get_doc("WhatsApp Notification", NAME)
		self.assertEqual(saved.condition_type, "Filters")
		self.assertIsNone(saved.condition)
		self.assertTrue(svc.evaluate(saved, self.todo, "New"))

	def test_bad_filters_refused(self):
		with self.assertRaises(WAValidationError):
			api.save_editor(payload=self._payload(condition_type="Filters", filters=[["ToDo", "no_such_field", "=", "x"]]))

	def test_document_type_search_matches_the_translated_name(self):
		lang = frappe.local.lang
		frappe.local.lang = "ar"
		try:
			arabic = frappe._("ToDo")
			rows = api.search(kind="document_type", txt=arabic[:3])
		finally:
			frappe.local.lang = lang
		self.assertIn("ToDo", [r["value"] for r in rows])
		self.assertEqual(api.search(kind="document_type", txt="todo")[0]["value"], "ToDo")

	def test_role_gate(self):
		with as_user("WhatsApp Agent"), self.assertRaises(WAPermissionError):
			api.get_editor()
