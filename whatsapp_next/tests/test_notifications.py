# Tests for services/notifications.py (build order B-16): hook short-circuit and event matching,
# conditions that never block, enqueue after commit, the send job (body, recipients, attachment,
# set_property_after_alert, counters), and scheduled Days/Minutes triggers.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import add_days, nowdate

from whatsapp_next.services import notifications as svc
from whatsapp_next.tests.conftest_frappe import delete_all, ensure_contact, ensure_device, ensure_settings

PHONE = "+966500000901"
NAME = "NotifTest ToDo"


def _notification(**values):
	doc = frappe.get_doc(
		{
			"doctype": "WhatsApp Notification",
			"notification_name": NAME,
			"enabled": 1,
			"document_type": "ToDo",
			"event": "New",
			"message": "notif-test {{ doc.description }} for {{ recipient.display_name }}",
			"recipients": [{"recipient_type": "Fixed Number", "phone": PHONE}],
			**values,
		}
	)
	doc.insert(ignore_permissions=True)
	svc.clear_cache("ToDo")
	return doc


class TestNotifications(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.device = ensure_device("Notif Device", "WAD-TEST-NT01", phone="+966500000061")
		ensure_settings(default_device=cls.device, send_only_to_known_numbers=0)

	def setUp(self):
		self._clean()

	def tearDown(self):
		self._clean()

	@staticmethod
	def _clean():
		delete_all("WhatsApp Queue Item")
		delete_all("WhatsApp Log", {"source_type": "Notification"})
		delete_all("WhatsApp Notification", {"notification_name": ("like", "NotifTest%")})
		delete_all("ToDo", {"description": ("like", "notif-test%")})
		svc.clear_cache()

	def test_hook_short_circuit_and_new_event(self):
		self.assertEqual(svc.active_for("ToDo"), [])
		self.assertEqual(frappe.cache.get_value(svc.cache_key("ToDo")), [])  # empty list cached
		notif = _notification()
		self.assertEqual(svc.active_for("ToDo"), [notif.name])
		with patch.object(frappe, "enqueue") as enq:
			todo = frappe.get_doc({"doctype": "ToDo", "description": "notif-test hello"}).insert(
				ignore_permissions=True
			)
		calls = [
			c
			for c in enq.call_args_list
			if c.args[0] == "whatsapp_next.services.notifications.send_for_document"
		]
		self.assertEqual(len(calls), 1)  # after_insert only; the on_update of the insert does not fire "New"
		self.assertEqual(calls[0].kwargs["event"], "New")
		self.assertTrue(calls[0].kwargs["enqueue_after_commit"])
		# Save fires on update, not on insert
		notif.event = "Save"
		notif.save(ignore_permissions=True)
		with patch.object(frappe, "enqueue") as enq:
			todo.description = "notif-test changed"
			todo.save(ignore_permissions=True)
		self.assertEqual(len([c for c in enq.call_args_list if c.kwargs.get("event") == "Save"]), 1)
		# a failing condition never blocks the document, and is recorded
		notif.condition = "doc.nonexistent.attr > 1"
		notif.save(ignore_permissions=True)
		with patch.object(frappe, "enqueue") as enq:
			todo.description = "notif-test again"
			todo.save(ignore_permissions=True)
		self.assertEqual(enq.call_count, 0)
		self.assertIn("condition:", frappe.db.get_value("WhatsApp Notification", notif.name, "last_error"))

	def test_value_change_and_method(self):
		notif = _notification(event="Value Change", value_changed="status")
		todo = frappe.get_doc({"doctype": "ToDo", "description": "notif-test vc"}).insert(
			ignore_permissions=True
		)
		with patch.object(frappe, "enqueue") as enq:
			todo.description = "notif-test vc 2"
			todo.save(ignore_permissions=True)
			self.assertEqual(enq.call_count, 0)
			todo.status = "Closed"
			todo.save(ignore_permissions=True)
		self.assertGreaterEqual(
			len([c for c in enq.call_args_list if c.kwargs.get("event") == "Value Change"]), 1
		)
		notif.event = "Method"
		notif.method = "on_update"
		notif.save(ignore_permissions=True)
		with patch.object(frappe, "enqueue") as enq:
			todo.description = "notif-test method"
			todo.save(ignore_permissions=True)
		self.assertEqual(len([c for c in enq.call_args_list if c.kwargs.get("event") == "Method"]), 1)

	def test_send_for_document(self):
		contact = ensure_contact("Notif Contact", PHONE)
		notif = _notification(
			recipients=[
				{"recipient_type": "Fixed Number", "phone": PHONE},
				{"recipient_type": "Document Field", "receiver_by_document_field": "allocated_to"},
				{
					"recipient_type": "Fixed Number",
					"phone": "+966500000902",
					"condition": "doc.priority == 'High'",
				},
			],
			set_property_after_alert="status",
			property_value="Closed",
		)
		todo = frappe.get_doc(
			{"doctype": "ToDo", "description": "notif-test send", "priority": "Medium"}
		).insert(ignore_permissions=True)
		with patch.object(frappe, "enqueue"):
			result = svc.send_for_document(notif.name, "ToDo", todo.name, "New")
		self.assertEqual(
			(result["sent"], result["error"]), (1, None)
		)  # Fixed Number only: allocated_to empty, condition false
		out = frappe.get_all(
			"WhatsApp Log",
			filters={"notification": notif.name},
			fields=["phone_e164", "body", "status", "reference_name", "contact"],
		)
		self.assertEqual(len(out), 1)
		self.assertEqual(
			(out[0].phone_e164, out[0].status, out[0].reference_name), (PHONE, "Queued", todo.name)
		)
		self.assertTrue(out[0].body.startswith("notif-test notif-test send"))
		self.assertEqual(frappe.db.get_value("ToDo", todo.name, "status"), "Closed")
		row = frappe.db.get_value(
			"WhatsApp Notification", notif.name, ["send_count", "last_sent_at"], as_dict=True
		)
		self.assertEqual(row.send_count, 1)
		self.assertIsNotNone(row.last_sent_at)
		# recipients resolved through a Link-to-Contact field come with the contact
		todo2 = frappe.get_doc(
			{
				"doctype": "ToDo",
				"description": "notif-test link",
				"reference_type": "Contact",
				"reference_name": contact,
			}
		).insert(ignore_permissions=True)
		notif.set(
			"recipients",
			[{"recipient_type": "Document Field", "receiver_by_document_field": "reference_name"}],
		)
		notif.save(ignore_permissions=True)
		recips = svc.resolve_recipients(frappe.get_doc("WhatsApp Notification", notif.name), todo2)
		self.assertEqual([(r.phone_e164, r.contact) for r in recips], [(PHONE, contact)])
		# missing document / disabled → skipped
		self.assertEqual(svc.send_for_document(notif.name, "ToDo", "nope", "New")["skipped"], 1)
		# a template render error is recorded and nothing is sent
		notif.message = "{{ doc.description "
		notif.flags.ignore_validate = True
		frappe.db.set_value("WhatsApp Notification", notif.name, "message", "{{ doc.description ")
		frappe.clear_document_cache("WhatsApp Notification", notif.name)
		with patch.object(frappe, "enqueue"):
			result = svc.send_for_document(notif.name, "ToDo", todo2.name, "New")
		self.assertEqual(result["sent"], 0)
		self.assertIn("template:", frappe.db.get_value("WhatsApp Notification", notif.name, "last_error"))

	def test_scheduled_triggers(self):
		notif = _notification(event="Days Before", date_changed="date", days_in_advance=2)
		due = frappe.get_doc(
			{"doctype": "ToDo", "description": "notif-test due", "date": add_days(nowdate(), 2)}
		).insert(ignore_permissions=True)
		frappe.get_doc(
			{"doctype": "ToDo", "description": "notif-test not due", "date": add_days(nowdate(), 5)}
		).insert(ignore_permissions=True)
		self.assertEqual(svc.documents_due(frappe.get_doc("WhatsApp Notification", notif.name)), [due.name])
		with patch.object(frappe, "enqueue") as enq:
			self.assertEqual(svc.trigger_daily(), 1)
		self.assertEqual(enq.call_args.kwargs["name"], due.name)
		notif.event = "Minutes After"
		notif.datetime_changed = "modified"
		notif.minutes_offset = 0
		notif.save(ignore_permissions=True)
		with patch.object(frappe, "enqueue") as enq:
			n = svc.trigger_offset()
		self.assertGreaterEqual(n, 2)  # both ToDos were modified within the last 5 minutes
