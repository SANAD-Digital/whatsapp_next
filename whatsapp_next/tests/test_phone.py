# Table-driven tests for services/phone.py (E.164, JIDs, masking, provider boundary).

from __future__ import annotations

from frappe.tests import IntegrationTestCase

from whatsapp_next.services import phone


class TestPhone(IntegrationTestCase):
	def test_normalize_table(self):
		cases = [
			# (raw, region, expected)
			("+966501234567", None, "+966501234567"),
			("966501234567", None, "+966501234567"),
			("00966501234567", None, "+966501234567"),
			("0501234567", "SA", "+966501234567"),
			("050 123 4567", "SA", "+966501234567"),
			("050-123-4567", "SA", "+966501234567"),
			("(050) 123 4567", "SA", "+966501234567"),
			("٠٥٠١٢٣٤٥٦٧", "SA", "+966501234567"),
			("501234567", "SA", "+966501234567"),
			("0777123456", "YE", "+967777123456"),
			("967777123456", None, "+967777123456"),
			("01012345678", "EG", "+201012345678"),
			("0501234567", "AE", "+971501234567"),
			("+1 (415) 555-2671", None, "+14155552671"),
			("966501234567@c.us", None, "+966501234567"),
			("966501234567@s.whatsapp.net", None, "+966501234567"),
			("120363000000000001@g.us", None, "120363000000000001@g.us"),
			("123456789012345@lid", None, "123456789012345@lid"),
			("", None, None),
			(None, None, None),
			("abc", "SA", None),
			("12", "SA", None),
			("+", None, None),
		]
		for raw, region, expected in cases:
			with self.subTest(raw=raw, region=region):
				self.assertEqual(phone.normalize(raw, region=region), expected)

	def test_classify(self):
		self.assertEqual(phone.classify("+966501234567"), ("Individual", "+966501234567"))
		self.assertEqual(phone.classify("120363000000000001@g.us"), ("Group", "120363000000000001@g.us"))
		self.assertEqual(phone.classify("1234@lid"), ("LID", "1234@lid"))
		self.assertEqual(phone.classify("nope"), (None, None))
		self.assertTrue(phone.is_valid_key("+966501234567"))
		self.assertFalse(phone.is_valid_key("nope"))

	def test_key_and_jid_conversions(self):
		self.assertEqual(phone.key_for("+966501234567", None), "+966501234567")
		self.assertEqual(phone.key_for("+966501234567", "1@g.us"), "1@g.us")
		self.assertEqual(phone.to_jid("+966501234567"), "966501234567@s.whatsapp.net")
		self.assertEqual(phone.to_jid("1@g.us"), "1@g.us")
		self.assertEqual(phone.to_provider("+966501234567"), "966501234567")
		self.assertEqual(phone.to_provider("1@g.us"), "1@g.us")

	def test_mask_hides_digits(self):
		masked = phone.mask("+966501234567")
		self.assertTrue(masked.startswith("+966"))
		self.assertTrue(masked.endswith("67"))
		self.assertNotIn("50123", masked)
		self.assertIn("***", phone.mask("966501234567@s.whatsapp.net"))
		self.assertEqual(phone.mask(""), "")

	def test_set_phone_pair(self):
		import frappe

		from whatsapp_next.exceptions import WAInvalidPhoneError

		doc = frappe._dict(phone="0501234567", phone_e164=None)
		doc.set = lambda k, v: doc.__setitem__(k, v)
		self.assertEqual(
			phone.set_phone_pair(doc, required=True),
			phone.normalize("0501234567", "SA") if phone.default_region() == "SA" else doc.phone_e164,
		)
		bad = frappe._dict(phone="abc", phone_e164=None)
		bad.set = lambda k, v: bad.__setitem__(k, v)
		with self.assertRaises(WAInvalidPhoneError):
			phone.set_phone_pair(bad, required=True)
		self.assertIsNone(phone.set_phone_pair(bad, required=False))
