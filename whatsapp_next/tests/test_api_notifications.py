# Tests for api/v1/notifications.py (build order B-25) and the service helpers it needed
# (`notifications.preview_for_document`, `notifications.document_fields`, `outbounds` in the
# `send_for_document` result): role gate, masked preview, editor field choices, manual send.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import notifications as api
from whatsapp_next.exceptions import WANotFoundError, WAPermissionError, WAValidationError
from whatsapp_next.services import notifications as svc
from whatsapp_next.tests.conftest_frappe import (
	ROLE_USERS,
	as_user,
	delete_all,
	ensure_device,
	ensure_settings,
)

NAME = "ApiTest Notification"
PHONE = "+966500930201"


class TestApiNotifications(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("ApiTest Notif Device", "WAD-APITEST-NT", phone="+966500930200")
		ensure_settings(send_only_to_known_numbers=0)

	def setUp(self):
		self._clean()
		self.todo = frappe.get_doc({"doctype": "ToDo", "description": "apitest notif body"}).insert(
			ignore_permissions=True
		)
		# ToDo rows are readable by their owner / assignee only: hand it to the Manager test user
		manager = ROLE_USERS["WhatsApp Manager"]
		frappe.db.set_value("ToDo", self.todo.name, {"owner": manager, "assigned_by": manager})
		self.notification = frappe.get_doc(
			{
				"doctype": "WhatsApp Notification",
				"notification_name": NAME,
				"enabled": 1,
				"document_type": "ToDo",
				"event": "New",
				"condition": "doc.status == 'Open'",
				"device": self.device,
				"message": "apitest {{ doc.description }} -> {{ recipient.phone_e164 }}",
				"recipients": [{"recipient_type": "Fixed Number", "phone": PHONE}],
			}
		).insert(ignore_permissions=True)
		svc.clear_cache("ToDo")

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Queue Item")
		delete_all("WhatsApp Log", {"phone_e164": PHONE})
		delete_all("WhatsApp Notification", {"notification_name": NAME})
		delete_all("ToDo", {"description": ("like", "apitest notif%")})
		svc.clear_cache()

	def test_role_gate(self):
		with as_user("WhatsApp Agent"), self.assertRaises(WAPermissionError):
			api.preview(name=NAME, reference_name=self.todo.name)
		with as_user("_none"), self.assertRaises(WAPermissionError):
			api.get_document_fields(document_type="ToDo")
		with as_user("WhatsApp Manager"):
			self.assertTrue(api.preview(name=NAME, reference_name=self.todo.name)["meets_condition"])

	def test_preview_masks_phones(self):
		with as_user("WhatsApp Manager"):
			out = api.preview(name=NAME, reference_name=self.todo.name)
		self.assertEqual(out["message"], f"apitest apitest notif body -> {PHONE}")
		self.assertEqual(out["recipients"], [{"phone_e164": "+966*******01", "source": "Fixed Number"}])
		self.assertEqual(out["errors"], [])
		frappe.db.set_value("ToDo", self.todo.name, "status", "Closed")
		with as_user("WhatsApp Manager"):
			self.assertFalse(api.preview(name=NAME, reference_name=self.todo.name)["meets_condition"])
			with self.assertRaises(WANotFoundError):
				api.preview(name=NAME, reference_name="no-such-todo")
		self.assertEqual(frappe.db.count("WhatsApp Log", {"phone_e164": PHONE}), 0)

	def test_document_fields(self):
		with as_user("WhatsApp Manager"):
			out = api.get_document_fields(document_type="ToDo")
			with self.assertRaises(WAValidationError):
				api.get_document_fields(document_type="No Such DocType")
		self.assertEqual(
			set(out), {"date_fields", "datetime_fields", "phone_fields", "link_fields", "all_fields"}
		)
		self.assertIn("date", [f["fieldname"] for f in out["date_fields"]])
		links = {f["fieldname"]: f for f in out["link_fields"]}
		self.assertEqual(links["allocated_to"]["options"], "User")
		self.assertNotIn("Section Break", {f["fieldtype"] for f in out["all_fields"]})

	def test_send_now(self):
		with as_user("WhatsApp Manager"):
			out = api.send_now(name=NAME, reference_name=self.todo.name)
		self.assertEqual((out["sent"], out["skipped"], out["error"]), (1, 0, None))
		self.assertEqual(len(out["outbounds"]), 1)
		row = frappe.db.get_value(
			"WhatsApp Log",
			out["outbounds"][0],
			["status", "source_type", "notification", "phone_e164"],
			as_dict=True,
		)
		self.assertEqual(
			(row.status, row.source_type, row.notification, row.phone_e164),
			("Queued", "Notification", NAME, PHONE),
		)
		self.assertEqual(frappe.db.get_value("WhatsApp Notification", NAME, "send_count"), 1)
