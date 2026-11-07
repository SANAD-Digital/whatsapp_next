"""What `compat_v15.py` promises, on the branch that carries it."""

import json

import frappe
from frappe.desk import reportview
from frappe.tests.utils import FrappeTestCase


class TestBrowserListReads(FrappeTestCase):
	def setUp(self):
		self.form_dict = frappe.local.form_dict

	def tearDown(self):
		frappe.local.form_dict = self.form_dict

	def test_an_aggregate_in_frappe_16_form(self):
		"""A list's number card asks for `{"SUM": "member_count", "as": "value"}`. Frappe 15's check of
		the fields stopped on it with `unhashable type: 'dict'`, and the whole list showed an error."""
		frappe.local.form_dict = frappe._dict(
			doctype="WhatsApp Contact Group",
			fields=json.dumps([{"SUM": "member_count", "as": "value"}]),
		)

		rows = reportview.get_list()

		self.assertEqual(len(rows), 1)
		self.assertIn("value", rows[0])

	def test_a_column_the_doctype_does_not_have_is_still_refused(self):
		frappe.local.form_dict = frappe._dict(
			doctype="WhatsApp Contact Group",
			fields=json.dumps([{"SUM": "no_such_column", "as": "value"}]),
		)

		with self.assertRaises(frappe.DataError):
			reportview.get_list()
