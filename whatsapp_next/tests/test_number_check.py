# Is a number on WhatsApp (services/number_check): asked through the provider, remembered, mirrored
# on WhatsApp Number, and used by campaigns to skip numbers that are not on WhatsApp.

from __future__ import annotations

from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.providers.schemas import NumberCheck
from whatsapp_next.services import number_check
from whatsapp_next.tests.conftest_frappe import ensure_device


class Provider:
	def __init__(self, on):
		self.on, self.calls = on, []

	def check_numbers(self, platform_device, numbers):
		self.calls.append(list(numbers))
		return [NumberCheck(phone_e164=n, on_whatsapp=n in self.on, jid=f"{n[1:]}@s.whatsapp.net" if n in self.on else None)
			for n in numbers if n != "+967711999999"]  # one number missing from the answer


class TestNumberCheck(IntegrationTestCase):
	def setUp(self):
		if not frappe.db.get_value("WhatsApp Device", {"status": "Connected"}, "name"):
			ensure_device()
		self.tag = frappe.generate_hash(length=4).translate(str.maketrans("abcdef", "123456"))
		self.a, self.b = f"+96771100{self.tag}", f"+96771200{self.tag}"

	def test_asks_once_then_remembers(self):
		provider = Provider({self.a})
		with patch("whatsapp_next.providers.registry.get_provider", return_value=provider):
			first = number_check.check([self.a, self.b, "+967711999999", "not a number"])
			again = number_check.check([self.a, self.b])
		self.assertEqual(first, {self.a: True, self.b: False, "+967711999999": False})
		self.assertEqual(again, {self.a: True, self.b: False})
		self.assertEqual(len(provider.calls), 1)
		self.assertEqual(frappe.db.get_value("WhatsApp Number Check", self.a, "on_whatsapp"), "Yes")

	def test_mirrors_onto_the_number_row(self):
		frappe.get_doc({"doctype": "WhatsApp Number", "phone_e164": self.b, "number_type": "Individual",
			"link_status": "Not Linked"}).insert(ignore_permissions=True)
		with patch("whatsapp_next.providers.registry.get_provider", return_value=Provider(set())):
			number_check.check([self.b], force=True)
		self.assertEqual(frappe.db.get_value("WhatsApp Number", self.b, "on_whatsapp"), "No")
