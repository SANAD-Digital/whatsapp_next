"""The picker-source editor's brains: which screens can give numbers, which field holds them, and
how many people a source reaches (services.picker_sources)."""

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.api.v1 import settings as api
from whatsapp_next.services import picker_sources as svc
from whatsapp_next.tests.conftest_frappe import as_user


class TestPickerSources(IntegrationTestCase):
	def test_only_screens_with_a_number_or_a_contact_link_are_offered(self):
		rows = svc.candidates()
		names = {r["document_type"] for r in rows}
		self.assertIn("User", names)  # mobile_no / phone
		self.assertNotIn("Contact", names)  # the picker has its own contacts tab
		self.assertFalse({n for n in names if n.startswith("WhatsApp ")})  # the app's own records
		for r in rows:
			self.assertTrue(r["phone_fields"] or r["contact_link"], r)

	def test_a_screen_is_read_and_the_busiest_number_field_is_the_guess(self):
		info = svc.analyze("User")
		fields = [f["fieldname"] for f in info["phone_fields"]]
		self.assertIn("mobile_no", fields)
		self.assertNotIn("phone_ext", fields)  # an extension is not a number
		self.assertEqual(info["suggestion"]["phone_source"], "Field")
		self.assertEqual(info["suggestion"]["phone_fieldname"], fields[0])
		self.assertTrue(all(isinstance(f["filled"], int) for f in info["phone_fields"]))
		with self.assertRaises(frappe.ValidationError):
			svc.analyze("WhatsApp Settings")  # a single is no list of people

	def test_the_preview_counts_usable_numbers_only(self):
		user = "wa-picker-preview@example.com"
		if not frappe.db.exists("User", user):
			frappe.get_doc({"doctype": "User", "email": user, "first_name": "Picker Preview", "send_welcome_email": 0}).insert(ignore_permissions=True)
		frappe.db.set_value("User", user, "mobile_no", "+967777667663")
		source = {"document_type": "User", "phone_source": "Field", "phone_fieldname": "mobile_no", "name_fieldname": "full_name",
			"filters_json": '[["name", "=", "%s"]]' % user}
		out = svc.preview(source)
		self.assertEqual((out["total"], out["with_number"]), (1, 1))
		self.assertEqual(out["sample"][0]["phone"], "+967777667663")
		frappe.db.set_value("User", user, "mobile_no", "12")
		self.assertEqual(svc.preview(source)["with_number"], 0)
		with self.assertRaises(frappe.ValidationError):
			svc.preview(dict(source, filters_json='[["no_such_field", "=", 1]]'))

	def test_the_endpoints_are_for_managers(self):
		with as_user("WhatsApp Agent"), self.assertRaises(frappe.PermissionError):
			api.list_picker_candidates()
		# analysing and previewing read records of any screen past their permissions: a System
		# Manager's, as saving a source is (review 2026-10-29) — a WhatsApp Manager is refused
		with as_user("WhatsApp Manager"), self.assertRaises(frappe.PermissionError):
			api.analyze_picker_doctype(document_type="User")
		with as_user("System Manager"):
			self.assertTrue(api.analyze_picker_doctype(document_type="User")["phone_fields"])
