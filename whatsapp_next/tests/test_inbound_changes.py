# A gateway `message.edited` / `message.deleted` updates the Inbound it names: the new text with
# the first one kept, or who deleted it and when — and the read layer carries both to the thread.

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.providers.schemas import WebhookEvent
from whatsapp_next.services import inbound
from whatsapp_next.webhooks.handlers import handle_event


class TestInboundChanges(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		self.device = frappe.db.get_value("WhatsApp Device", {}, "name")
		if not self.device:
			self.skipTest("no WhatsApp Device on this site")
		self.pid = f"CHG-{frappe.generate_hash(length=8)}"
		doc = frappe.get_doc(
			{
				"doctype": "WhatsApp Inbound Message",
				"device": self.device,
				"message_type": "Text",
				"body": "Meeting at 5",
				"provider_message_id": self.pid,
				"phone_e164": "+967770000001",
				"command_status": "None",
			}
		)
		doc.flags.ignore_mandatory = True
		doc.insert(ignore_permissions=True)
		self.name = doc.name

	def _event(self, name, **raw):
		return WebhookEvent(event_id=f"{name}-{frappe.generate_hash(length=6)}", event_name=name, raw={"message_id": self.pid, **raw})

	def test_edit_keeps_the_first_text(self):
		status, links = handle_event(self._event("message.edited", original_text="Meeting at 5", new_text="Meeting at 6"), webhook_event_name=None, device=self.device)
		self.assertEqual((status, links.get("inbound_message")), ("Processed", self.name))
		handle_event(self._event("message.edited", original_text="Meeting at 6", new_text="Meeting at 7"), webhook_event_name=None, device=self.device)
		row = frappe.db.get_value("WhatsApp Inbound Message", self.name, ["body", "original_body", "edited_at"], as_dict=True)
		self.assertEqual((row.body, row.original_body), ("Meeting at 7", "Meeting at 5"))
		self.assertIsNotNone(row.edited_at)

	def test_delete_records_who_and_keeps_the_text(self):
		handle_event(self._event("message.deleted", original_text="Meeting at 5", deleted_by_number="967770000002"), webhook_event_name=None, device=self.device)
		row = frappe.db.get_value("WhatsApp Inbound Message", self.name, ["body", "deleted_at", "deleted_by"], as_dict=True)
		self.assertEqual((row.body, row.deleted_by), ("Meeting at 5", "967770000002"))
		self.assertIsNotNone(row.deleted_at)

	def test_unknown_message_is_ignored(self):
		event = WebhookEvent(event_id="x", event_name="message.edited", raw={"message_id": "NOT-HERE", "new_text": "x"})
		self.assertEqual(handle_event(event, webhook_event_name=None, device=self.device)[0], "Ignored")


class TestChangeReplies(TestInboundChanges):
	"""The settings' answer to an edit / a deletion (reply_on_edit, reply_on_delete)."""

	def setUp(self):
		super().setUp()
		self.settings = {f: frappe.db.get_single_value("WhatsApp Settings", f) for f in ("reply_on_edit", "edit_reply_text", "reply_on_delete", "delete_reply_text", "changes_reply_scope")}
		frappe.db.set_single_value("WhatsApp Settings", {"reply_on_edit": 1, "edit_reply_text": "Edited, it said:", "reply_on_delete": 1, "delete_reply_text": "Deleted, it said:", "changes_reply_scope": "All chats"})
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")

	def tearDown(self):
		frappe.db.set_single_value("WhatsApp Settings", self.settings)
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
		super().tearDown()

	def _replies(self):
		return frappe.get_all("WhatsApp Log", filters={"trigger_inbound": self.name}, fields=["body", "reply_to_provider_message_id", "phone_e164", "status"])

	def test_edit_reply_quotes_the_message(self):
		handle_event(self._event("message.edited", original_text="Meeting at 5", new_text="Meeting at 6"), webhook_event_name=None, device=self.device)
		[reply] = self._replies()
		self.assertEqual(reply.body, "Edited, it said:\n\nMeeting at 5")
		self.assertEqual((reply.reply_to_provider_message_id, reply.phone_e164), (self.pid, "+967770000001"))

	def test_delete_reply_sends_the_deleted_text(self):
		handle_event(self._event("message.deleted", original_text="Meeting at 5", deleted_by_number="967770000001"), webhook_event_name=None, device=self.device)
		[reply] = self._replies()
		self.assertEqual(reply.body, "Deleted, it said:\n\nMeeting at 5")
		self.assertFalse(reply.reply_to_provider_message_id)

	def test_scope_and_switch(self):
		frappe.db.set_single_value("WhatsApp Settings", "changes_reply_scope", "Groups only")
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
		handle_event(self._event("message.edited", original_text="a", new_text="b"), webhook_event_name=None, device=self.device)
		self.assertEqual(self._replies(), [])  # a private chat, groups only
		frappe.db.set_single_value("WhatsApp Settings", {"changes_reply_scope": "All chats", "reply_on_delete": 0})
		frappe.clear_document_cache("WhatsApp Settings", "WhatsApp Settings")
		handle_event(self._event("message.deleted", original_text="b"), webhook_event_name=None, device=self.device)
		self.assertEqual(self._replies(), [])
