# Chat links and their QR codes for print formats (services/wa_links).

from __future__ import annotations

import frappe
from frappe.tests import IntegrationTestCase

from whatsapp_next.services import wa_links


class TestWaLinks(IntegrationTestCase):
	def setUp(self):
		self.device = frappe.db.get_value("WhatsApp Device", {"phone_e164": ("is", "set")}, ["name", "phone_e164"], as_dict=True)
		if not self.device:
			self.skipTest("needs a device with a number")
		self.digits = self.device.phone_e164.lstrip("+")

	def test_link_carries_the_typed_message(self):
		self.assertEqual(wa_links.link(None, self.device.name), f"https://wa.me/{self.digits}")
		self.assertEqual(wa_links.link("كشف 3", self.device.name),
			f"https://wa.me/{self.digits}?text=%D9%83%D8%B4%D9%81%203")

	def test_qr_in_a_print_format(self):
		html = frappe.render_template('{{ whatsapp_qr("كشف " ~ name, size=100) }}', {"name": "C-1"})
		self.assertTrue(html.startswith('<img src="data:image/png;base64,'))
		self.assertIn('width="100"', html)
		self.assertTrue(frappe.render_template('{{ whatsapp_link("x") }}', {}).startswith("https://wa.me/"))
