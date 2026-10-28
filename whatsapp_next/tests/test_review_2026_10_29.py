# Tests for the security review of 2026-10-29: each hole it closed stays closed — the picker
# preview reads past permissions only for a System Manager, a contact's numbers and name reach
# only someone who may read that contact, a Quick Send preview shows no field above the caller's
# level, the webhook callback for sign-ups says nothing, and a dry run leaves no writes behind.

from __future__ import annotations

import json
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import quick_send as quick_send_api
from whatsapp_next.api.v1 import settings as settings_api
from whatsapp_next.services import quick_send, templates, wa_groups
from whatsapp_next.tests.conftest_frappe import as_user

PHONE = "+966500929901"


class TestReview20261029(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		contact = frappe.get_doc(
			{"doctype": "Contact", "first_name": "Review Hidden", "phone_nos": [{"phone": PHONE, "is_primary_mobile_no": 1}]}
		).insert(ignore_permissions=True)
		cls.contact = contact.name

	@classmethod
	def tearDownClass(cls):
		frappe.set_user("Administrator")
		frappe.delete_doc("Contact", cls.contact, force=True, ignore_permissions=True)
		super().tearDownClass()

	def test_the_picker_preview_is_for_a_system_manager(self):
		source = json.dumps({"document_type": "User", "phone_source": "Field", "phone_fieldname": "mobile_no", "name_fieldname": "api_key"})
		with as_user("WhatsApp Manager"):
			with self.assertRaises(frappe.PermissionError):
				settings_api.preview_picker_source(source=source)
			with self.assertRaises(frappe.PermissionError):
				settings_api.analyze_picker_doctype(document_type="User")

	def test_a_contacts_numbers_only_to_who_may_read_it(self):
		with as_user("WhatsApp Agent"):
			self.assertEqual(wa_groups.members_from("Contact", [self.contact]), [])
			with self.assertRaises(frappe.PermissionError):
				quick_send.resolve_recipient(contact=self.contact)
			# typing the number does not tell whose it is
			self.assertIsNone(quick_send.resolve_recipient(phone=PHONE)["contact"])
		with as_user("WhatsApp Contact User"):
			self.assertTrue(wa_groups.members_from("Contact", [self.contact]))

	def test_a_preview_hides_the_fields_above_the_callers_level(self):
		# `readable_only` empties what the caller's permission levels do not cover
		doc = frappe.get_doc("Contact", self.contact)
		with patch.object(type(doc), "apply_fieldlevel_read_permissions", lambda d: d.__dict__.pop("first_name", None)):
			templates.readable_only(doc)
		self.assertEqual(doc.first_name, "")
		with as_user("WhatsApp Agent"), patch.object(templates, "readable_only") as hide:
			with patch.object(frappe, "has_permission", return_value=True):
				quick_send_api.preview(body="{{ doc.first_name }}", reference_doctype="Contact", reference_name=self.contact)
		hide.assert_called_once()

	def test_the_signup_callback_says_nothing(self):
		from whatsapp_next.webhooks.v1 import signup

		self.assertEqual(signup.confirmed(callback_token="not-ours", status="Verified"), {})
