# Table-driven tests for services/phone.py (E.164, JIDs, masking, provider boundary).

from __future__ import annotations

from frappe.tests import IntegrationTestCase

from whatsapp_next.services import phone


class TestPhone(IntegrationTestCase):
	def test_normalize_table(self):
		cases = [
			# (raw, region, expected) — only the owner's own numbers (2026-11-12)
			("+967784499996", None, "+967784499996"),
			("967784499996", None, "+967784499996"),
			("00967784499996", None, "+967784499996"),
			("0784499996", "YE", "+967784499996"),
			("078 449 9996", "YE", "+967784499996"),
			("078-449-9996", "YE", "+967784499996"),
			("(078) 449 9996", "YE", "+967784499996"),
			("٠٧٨٤٤٩٩٩٩٦", "YE", "+967784499996"),
			("784499996", "YE", "+967784499996"),
			("0777667663", "YE", "+967777667663"),
			("+967 777 999 579", None, "+967777999579"),
			("+967-775-040-850", None, "+967775040850"),
			("967784499996@c.us", None, "+967784499996"),
			("967784499996@s.whatsapp.net", None, "+967784499996"),
			("120363000000000001@g.us", None, "120363000000000001@g.us"),
			("123456789012345@lid", None, "123456789012345@lid"),
			("", None, None),
			(None, None, None),
			("abc", "YE", None),
			("+", None, None),
		]
		for raw, region, expected in cases:
			with self.subTest(raw=raw, region=region):
				self.assertEqual(phone.normalize_phone_to_e164(raw, region=region), expected)

	def test_the_sites_country_and_yemens_example(self):
		"""Every phone field opens on Global Defaults → Country, else System Settings (owner,
		2026-11-09); Yemen's placeholder is the product's own example, not the library's."""
		from unittest.mock import patch

		import frappe

		from whatsapp_next.tests.conftest_frappe import REAL_REGION_FROM_SETTINGS

		singles = {("Global Defaults", "country"): "Yemen", ("System Settings", "country"): "Saudi Arabia"}
		with patch.object(
			frappe.db, "get_single_value", side_effect=lambda dt, f, *a, **k: singles.get((dt, f))
		):
			self.assertEqual(REAL_REGION_FROM_SETTINGS(), "YE")
			singles[("Global Defaults", "country")] = None
			self.assertEqual(REAL_REGION_FROM_SETTINGS(), "SA")
		frappe.cache.delete_value("wa_country_catalog_v3")
		yemen = next(r for r in phone.country_catalog() if r["iso"] == "YE")
		# the example is a Yemeni mobile written the local way, and its international form matches it
		self.assertRegex(yemen["example"], r"^07\d{2} \d{3} \d{3}$")
		self.assertEqual(yemen["international"], "+967 " + yemen["example"][1:])

	def test_classify(self):
		self.assertEqual(phone.classify("+967784499996"), ("Individual", "+967784499996"))
		self.assertEqual(phone.classify("120363000000000001@g.us"), ("Group", "120363000000000001@g.us"))
		self.assertEqual(phone.classify("1234@lid"), ("LID", "1234@lid"))
		self.assertEqual(phone.classify("nope"), (None, None))

	def test_key_and_jid_conversions(self):
		self.assertEqual(phone.key_for("+967784499996", None), "+967784499996")
		self.assertEqual(phone.key_for("+967784499996", "1@g.us"), "1@g.us")
		self.assertEqual(phone.to_provider("+967784499996"), "967784499996")
		self.assertEqual(phone.to_provider("1@g.us"), "1@g.us")

	def test_mask_hides_digits(self):
		masked = phone.mask_phone_for_logs("+967784499996")
		# the country code shows, the "+" does not (numbers are never shown with one)
		self.assertTrue(masked.startswith("967"))
		self.assertNotIn("+", masked)
		self.assertTrue(masked.endswith("96"))
		self.assertNotIn("84499", masked)
		self.assertIn("***", phone.mask_phone_for_logs("967784499996@s.whatsapp.net"))
		self.assertEqual(phone.mask_phone_for_logs(""), "")

	def test_set_phone_pair(self):
		import frappe

		from whatsapp_next.exceptions import WAInvalidPhoneError

		doc = frappe._dict(phone="0784499996", phone_e164=None)
		doc.set = lambda k, v: doc.__setitem__(k, v)
		self.assertEqual(
			phone.set_phone_pair(doc, required=True),
			phone.normalize_phone_to_e164("0784499996", "YE")
			if phone.default_region() == "YE"
			else doc.phone_e164,
		)
		bad = frappe._dict(phone="abc", phone_e164=None)
		bad.set = lambda k, v: bad.__setitem__(k, v)
		with self.assertRaises(WAInvalidPhoneError):
			phone.set_phone_pair(bad, required=True)
		self.assertIsNone(phone.set_phone_pair(bad, required=False))
